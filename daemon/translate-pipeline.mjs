// daemon/translate-pipeline.mjs —— GPT 翻译 worker（站点工作区浏览器 worker 的 Node 替代）
// 流程：getTranslateTask → pin glossaryUuid → 逐章：chapter-task → 分段翻译（段缓存落库，经全局调度器）
//        → 合并 → 上传（带当前 glossaryId）→ 进度落库 → 丢弃本章文本
// 语义与站点一致：expire/normal/all 档位、oldGlossaryId === glossaryId 的章节跳过、401 → need-auth。
// 内存纪律：段落/译文只在单章作用域内存在，上传后随作用域释放（工作区泄漏的正面修复）。
// 调度纪律：所有 LLM 请求经 LlmScheduler（默认全局单线程）；本次 run 的选项以参数覆盖，不改共享配置。
import crypto from 'node:crypto';
import { segmentLines, translateSegment } from './translate.mjs';
import { LlmScheduler } from './scheduler.mjs';
import { processorFromStore } from './processors.mjs';
import { templateFromStore, renderSystemPrompt } from './prompt.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TranslationPipeline {
  constructor({ store, engine, workers, scheduler, makeClient, log = console, options = {} }) {
    this.store = store;
    this.engine = engine;
    this.workers = workers || [];
    this.makeClient = makeClient;
    this.log = log;
    this.options = {
      translatorId: 'gpt',
      level: 'expire',        // expire | normal | all
      concurrency: 2,         // 段级并发（受调度器全局在途上限约束）
      maxChapters: 0,         // >0 时本次最多上传 N 章（测试钩子/小步快跑）
      rssLimitMB: 500,
      timeoutMs: 300000,
      ...options,
    };
    this.scheduler = scheduler || new LlmScheduler({
      engine,
      store,
      log,
      options: { timeoutMs: this.options.timeoutMs, workers: this.workers },
    });
  }

  memoryOk(limitMB) {
    return process.memoryUsage().rss / 1e6 <= (limitMB || this.options.rssLimitMB);
  }

  // 目标筛选（与站点 TranslateWeb/Wenku 的档位语义一致）
  planTargets(toc, { glossaryUuid, volumeId, level }) {
    const targets = [];
    for (const item of toc || []) {
      if (!item.chapterId) continue;
      const fresh = item.glossaryUuid === undefined;
      const expired = item.glossaryUuid !== undefined && item.glossaryUuid !== glossaryUuid;
      const want = level === 'all' ? true : level === 'normal' ? fresh : fresh || expired;
      if (want) targets.push({ chapterId: item.chapterId, volumeId, glossaryUuid, titleJp: item.titleJp || '' });
    }
    return targets;
  }

  async runBook(bookKey, { signal, options } = {}) {
    const opt = { ...this.options, ...(options || {}) };
    const { translatorId, level, concurrency } = opt;
    const holder = `daemon:${process.pid}`;
    if (!this.store.acquireLock(bookKey, holder)) throw new Error('同书已有运行器在跑（锁被占用）；确认浏览器/其他会话没在跑同一本');
    const runId = this.store.startRun(bookKey, 'translate');
    const t0 = Date.now();
    let requests = 0;
    let uploads = 0;
    const shouldStop = () => (signal ? signal.aborted : false)
      || !this.memoryOk(opt.rssLimitMB)
      || (opt.maxChapters > 0 && uploads >= opt.maxChapters);
    try {
      const book = this.store.getBook(bookKey);
      if (!book) throw new Error(`book 不存在: ${bookKey}`);
      const client = this.makeClient(book);

      // ---- 任务与目标 ----
      const meta = book.kind === 'web'
        ? await client.getNovel(book.providerId, book.novelId)
        : await client.getWenku(book.novelId);
      const title = meta.titleZh || meta.titleJp || meta.title || book.novelId;
      if (title !== book.title) this.store.setBookTitle(bookKey, title);

      const tasks = await client.getTranslateTasks(book, translatorId);
      const targets = [];
      for (const task of tasks) targets.push(...this.planTargets(task.toc, { ...task, level }));
      this.log.log(`[translate] ${book.key}：level=${level} 目标 ${targets.length} 章（合计 ${tasks.reduce((n, t) => n + (t.toc || []).length, 0)} 章）`);

      // 文本处理链（资源占位符/保留段/替换表/标点；版本参与段缓存键）
      const processor = processorFromStore(this.store, bookKey, opt.processors || {});
      if (processor.skipped.length > 0) this.log.log(`[proc] 跳过无效规则 ${processor.skipped.length} 条`);

      // 提示词模板（协议段由代码注入；缺 {format_rules} 自动回退默认）
      const template = templateFromStore(this.store, bookKey);
      const rendered = renderSystemPrompt(template, {
        sourceLanguage: book.sourceLanguage === 'JA' || !book.sourceLanguage ? '日文' : book.sourceLanguage,
        targetLanguage: '简体中文',
      });
      if (rendered.warnings.length > 0) this.log.log(`[prompt] ${rendered.warnings.join('；')}`);

      const call = (messages) => { requests += 1; return this.scheduler.call(messages, { signal }); };

      let doneChapters = 0;
      let skipped = 0;
      const failures = [];
      for (const target of targets) {
        if (shouldStop()) break;
        const chapterKey = target.volumeId ? `${target.volumeId}/${target.chapterId}` : target.chapterId;

        // 断点续跑：该章已按同一 glossaryUuid 完成 → 跳过
        const prog = this.store.getProgress(bookKey, chapterKey);
        if (prog && prog.state === 'done' && prog.glossaryUuid === target.glossaryUuid) { skipped += 1; continue; }

        try {
          const dto = await client.getChapterTask(book, target.chapterId, translatorId, target.volumeId);
          // 站点同款跳过：已有译文且用的就是当前术语表
          if (Array.isArray(dto.oldParagraphZh) && dto.oldGlossaryId === dto.glossaryId) {
            this.store.setProgress(bookKey, chapterKey, { glossaryUuid: target.glossaryUuid, state: 'done' });
            skipped += 1;
            continue;
          }
          const paragraphs = dto.paragraphJp || [];
          if (paragraphs.length === 0) { skipped += 1; continue; }

          // 分段 → 并发翻译（段缓存落库；未完成的段在下次运行复用）
          const segments = segmentLines(paragraphs);
          const zhParts = new Array(segments.length).fill(null);
          let cursor = 0;
          let chapterRetries = 0;   // 本章各段重试次数取最大（质检 RETRY_THRESHOLD 用）
          const lane = async () => {
            for (;;) {
              const index = cursor;
              cursor += 1;
              if (index >= segments.length) return;
              if (shouldStop()) return;
              const seg = segments[index];
              const prepared = seg.map((line) => processor.pre(line));
              const preLines = prepared.map((p) => p.text);
              const segKey = crypto.createHash('sha1')
                .update(JSON.stringify(preLines)).update('|').update(processor.version)
                .digest('hex');
              const cached = this.store.getSeg(bookKey, segKey);
              if (Array.isArray(cached) && cached.length === seg.length) { zhParts[index] = cached; continue; }
              const glossary = (dto.glossary && Object.keys(dto.glossary).length > 0) ? dto.glossary : {};
              let segRetries = 0;
              const rawZh = await translateSegment(preLines, {
                call,
                glossary,
                signal,
                systemPrompt: rendered.text,
                thinking: template.thinking,
                wait: (ms) => sleep(ms),   // 传输层重试耗尽后的等待（调度器也会在派发前按冷却等待）
                onRetry: (n) => { segRetries = n; },
                log: (msg) => this.log.log(`[translate] ${chapterKey} ${msg}`),
              });
              const zh = rawZh.map((line, i) => {
                const restored = processor.post(line, prepared[i].ctx);
                if (restored.warnings.length > 0) this.log.log(`[translate] ${chapterKey} ${restored.warnings.join('；')}`);
                return restored.fellBack ? seg[i] : restored.text;   // 还原失败 → 该行回退原文
              });
              chapterRetries = Math.max(chapterRetries, segRetries);
              this.store.putSeg(bookKey, segKey, zh);
              zhParts[index] = zh;
            }
          };
          await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, () => lane()));
          if (shouldStop()) break;   // 本轮未跑完 → 不整章上传（已完成的段已缓存，续跑复用）

          const paragraphsZh = zhParts.flat();
          if (paragraphsZh.length !== paragraphs.length) {
            throw new Error(`段落数不匹配：${paragraphsZh.length}/${paragraphs.length}`);
          }
          await client.uploadChapter(book, target.chapterId, { glossaryId: dto.glossaryId, paragraphsZh }, translatorId, target.volumeId);
          this.store.setProgress(bookKey, chapterKey, { glossaryUuid: target.glossaryUuid, state: 'done' });
          this.store.setChapterMeta(bookKey, chapterKey, { retries: chapterRetries });
          doneChapters += 1;
          uploads += 1;
          this.log.log(`[translate] ${chapterKey} 已上传（${paragraphsZh.length} 段）`);
          // 段落/译文引用在本轮作用域内，进入下一章自然释放
        } catch (err) {
          if (err && err.code === 'unauthorized') throw err;   // 凭据问题：整轮终止
          failures.push({ chapterKey, error: (err && err.message) || String(err) });
          this.log.log(`[translate] ${chapterKey} 失败：${failures[failures.length - 1].error}`);
        }
      }

      const stats = {
        level, translatorId, targets: targets.length, uploaded: uploads,
        skipped, failed: failures.length, failures: failures.slice(0, 10),
        requests, ms: Date.now() - t0,
      };
      const state = failures.length > 0 && uploads === 0 && !shouldStop() ? 'failed' : 'done';
      this.store.finishRun(runId, state, stats);
      this.store.setBookState(bookKey, state);
      return { stats };
    } catch (err) {
      const state = err && err.code === 'unauthorized' ? 'need-auth' : 'failed';
      this.store.finishRun(runId, state, { error: (err && err.message) || String(err) });
      this.store.setBookState(bookKey, state);
      throw err;
    } finally {
      const usage = this.scheduler.takeUsage();
      if (usage.requests > 0) this.store.addUsage({ bookKey, runId, job: 'translate', ...usage });
      this.store.releaseLock(bookKey, holder);
    }
  }
}
