// daemon/glossary-pipeline.mjs —— 单书增强术语管线（状态机）
// SCAN → EXTRACT(多轮种子账本) → VERIFY(证据化核实) → MERGE(实体聚类报告)
//   → ACCEPT(jp-zh 对齐回扫；无译文跳过) → PUBLISH|PROPOSE(指南门槛：干净直写 / 其余提案)
// 内存纪律：正文只在 run 内以局部变量存在，阶段结束即弃；任何阶段超内存阈值立即停止
// （外部看门狗负责拉起进程，状态都在 SQLite 里）。
import crypto from 'node:crypto';
import { LlmScheduler } from './scheduler.mjs';

export class GlossaryPipeline {
  constructor({ store, engine, workers, scheduler, makeClient, log = console, options = {} }) {
    this.store = store;
    this.engine = engine;
    this.workers = workers || [];
    this.makeClient = makeClient;   // (book) => SiteClient（按书的 origin 绑定，token 每次运行时从 config 取）
    this.log = log;
    this.options = {
      budgetChars: 3000,
      maxRounds: 2,
      concurrency: 2,
      seedPolish: true,
      maxSeedRounds: 3,
      verify: true,
      maxRequests: 0,      // 0 = 不限（测试用小值制造中途停止）
      rssLimitMB: 500,
      ...options,
    };
    this.scheduler = scheduler || new LlmScheduler({
      engine,
      store,
      log,
      options: { workers: this.workers },
    });
  }

  memoryOk(limitMB) {
    return process.memoryUsage().rss / 1e6 <= (limitMB || this.options.rssLimitMB);
  }

  async runBook(bookKey, { signal, options } = {}) {
    const opt = { ...this.options, ...(options || {}) };
    const holder = `daemon:${process.pid}`;
    if (!this.store.acquireLock(bookKey, holder)) throw new Error('同书已有运行器在跑（锁被占用）；确认油猴队列没在跑同一本');
    const runId = this.store.startRun(bookKey, 'glossary');
    const t0 = Date.now();
    let requests = 0;
    const overBudget = () => opt.maxRequests > 0 && requests >= opt.maxRequests;
    const shouldStop = () => (signal ? signal.aborted : false) || overBudget() || !this.memoryOk(opt.rssLimitMB);
    try {
      const book = this.store.getBook(bookKey);
      if (!book) throw new Error(`book 不存在: ${bookKey}`);
      const client = this.makeClient(book);   // 每次运行按书绑定 origin + 最新 token

      // ---- SCAN：元数据与现有术语表 ----
      this.log.log(`[scan] ${book.key}（${book.kind} @ ${book.origin}）`);
      const meta = book.kind === 'web'
        ? await client.getNovel(book.providerId, book.novelId)
        : await client.getWenku(book.novelId);
      const title = meta.titleZh || meta.titleJp || book.novelId;
      if (title !== book.title) this.store.setBookTitle(bookKey, title);
      const currentGlossary = meta.glossary || {};

      // ---- 抓正文 + EXTRACT（多轮种子账本；账本读写库，分块缓存落库） ----
      const text = await client.getBookText(book, (m) => this.log.log(`[scan] ${m}`));
      this.store.setTextHash(bookKey, crypto.createHash('sha1').update(text).digest('hex'));
      let lines = this.engine.splitLines(text)
        .filter((line) => this.engine.languageFilter(line, book.sourceLanguage || 'JA'))
        .filter((line) => !this.engine.ruleFilter(line));
      if (lines.length === 0) throw new Error('正文为空或语言过滤后无内容');
      this.log.log(`[extract] ${lines.length} 行`);

      const result = await this.engine.runJob({
        lines,
        callLLM: (messages) => { requests += 1; return this.scheduler.call(messages, { signal }); },
        options: {
          budgetChars: opt.budgetChars,
          maxRounds: opt.maxRounds,
          concurrency: opt.concurrency,
          targetLanguage: '中文',
          seedPolish: opt.seedPolish,
          maxSeedRounds: opt.maxSeedRounds,
          seedLedger: this.store.getLedger(bookKey) || undefined,
        },
        shouldStop,
        cache: {
          namespace: `daemon:${bookKey}`,
          get: (key) => Promise.resolve(this.store.getChunk(bookKey, key)),
          put: (key, value) => Promise.resolve(this.store.putChunk(bookKey, key, value)),
        },
        onProgress: (p) => {
          if (String(p.phase || '').startsWith('seed-')) {
            if (p.phase === 'seed-start') this.log.log(`[seed] 第 ${p.seedRound || 1} 轮：${p.seedCount} 种子 / ${p.totalChunks} 块`);
            return;
          }
          if (p.phase === 'done' || p.phase === 'round-start') {
            this.log.log(`[extract] round=${p.round}/${p.maxRounds} done=${p.chunksDone} fail=${p.chunksFailed} pending=${p.pendingLines}`);
          }
        },
      });
      this.store.setLedger(bookKey, result.seedLedger);

      // ---- VERIFY（证据化核实；fail-open） ----
      let entries = result.glossary;
      let verifyStats = null;
      if (opt.verify !== false && entries.length > 0 && !shouldStop()) {
        verifyStats = await this.engine.verifyEntries({
          entries,
          lines,
          call: (messages) => { requests += 1; return this.scheduler.call(messages, { signal }); },
          concurrency: opt.concurrency,
          shouldStop,
          onProgress: (p) => this.log.log(`[verify] ${p.done}/${p.total} 批（判定 ${p.marks} 条）`),
        });
        entries = verifyStats.entries.map((e) => (e.verifyDrop
          ? { ...e, suspect: [...(e.suspect || []), `核实建议剔除${e.verified && e.verified.reason ? `：${e.verified.reason}` : ''}`] }
          : e));
      }

      // ---- 与站点现有术语表合并（已有条目保留原值/原备注，新增条目待定） ----
      // 测试钩子：smoke 往候选里注入额外条目以驱动提案分支（正常运行为空）
      if (Array.isArray(opt.testExtraEntries) && opt.testExtraEntries.length > 0) {
        entries.push(...opt.testExtraEntries.map((e) => ({ ...e })));
      }
      const merged = Object.keys(currentGlossary).map((src) => ({ src, dst: currentGlossary[src] }));
      const added = [];
      for (const entry of entries) {
        if (merged.some((m) => m.src === entry.src)) continue;
        merged.push(entry);
        added.push(entry);
      }
      let ranked = merged;
      if (ranked.length > 0) ranked = this.engine.searchForContext(ranked, lines);

      // ---- MERGE（实体聚类报告；只提示不自动合并） ----
      const clusters = this.engine.buildEntityClusters({ entries: ranked, lines });
      if (clusters.clusters.length > 0) {
        this.log.log(`[merge] 疑似同实体 ${clusters.clusters.length} 组：${clusters.clusters.slice(0, 3).map((c) => c.members.join(' ↔ ')).join('；')}`);
      }

      // ---- ACCEPT（jp-zh 对齐回扫；无译文自动跳过） ----
      let acceptStats = null;
      const aligned = await client.getAlignedPairs(book, (m) => this.log.log(`[accept] ${m}`));
      if (aligned.pairs.length > 0 && (aligned.translationMissing || 0) === 0) {
        const jpLines = aligned.pairs.map((p) => p.jp);
        const zhLines = aligned.pairs.map((p) => p.zh);
        acceptStats = this.engine.scanAcceptance({ entries: ranked, jpLines, zhLines });
        this.log.log(`[accept] 落地率 ${(acceptStats.stats.rate * 100).toFixed(1)}%（可检 ${acceptStats.stats.checkable} / 未落地 ${acceptStats.stats.missed}）`);
      } else {
        this.log.log('[accept] 跳过：该小说暂无可用译文');
      }

      // ---- PUBLISH | PROPOSE（指南门槛：干净新增直写，其余进提案） ----
      const isClean = (e) => !e.verifyDrop
        && this.engine.suspectReasons(e.src).length === 0
        && !this.engine.looksLikeSourceTampering(e.src);
      const clean = added.filter(isClean);
      const unclean = added.filter((e) => !isClean(e));
      let published = 0;
      let proposalId = null;
      if (clean.length > 0) {
        this.store.addSnapshot(bookKey, currentGlossary, `daemon 写入：新增 ${clean.length}`);
        const next = { ...currentGlossary };
        for (const entry of clean) {
          const value = this.engine.formatGlossaryValue(entry.dst, entry.type || entry.info);
          if (value !== '') next[entry.src] = value;
        }
        await client.putGlossaryRaw(book, next);
        published = clean.length;
        this.log.log(`[publish] 直写 ${published} 条（含备注格式）`);
      }
      if (unclean.length > 0) {
        proposalId = this.store.addProposal({
          bookKey,
          kind: 'glossary',
          entries: unclean.map((e) => ({
            src: e.src, dst: e.dst, type: e.type || '', suspect: e.suspect || [],
            verifyDrop: e.verifyDrop === true,
          })),
          note: `增强管线未达标条目（本轮干净直写 ${published} 条）`,
        });
        this.log.log(`[propose] ${unclean.length} 条进提案（id=${proposalId}），等人工审核`);
      }

      const stats = {
        lines: lines.length, entries: merged.length, added: added.length,
        published, proposed: unclean.length,
        seedRounds: result.seedRounds || 0, seedChunks: result.polishChunks || 0,
        verifyDropped: verifyStats ? verifyStats.dropped : 0, verifyFailedBatches: verifyStats ? verifyStats.failedBatches : 0,
        acceptRate: acceptStats ? acceptStats.stats.rate : null,
        requests, ms: Date.now() - t0,
      };
      this.store.finishRun(runId, 'done', stats);
      this.store.setBookState(bookKey, 'done');
      return { stats, clusters: clusters.clusters.length, proposalId };
    } catch (e) {
      const state = e.code === 'unauthorized' ? 'need-auth' : 'failed';
      this.store.finishRun(runId, state, { error: String((e && e.message) || e) });
      this.store.setBookState(bookKey, state);
      throw e;
    } finally {
      const usage = this.scheduler.takeUsage();
      if (usage.requests > 0) this.store.addUsage({ bookKey, runId, job: 'glossary', ...usage });
      this.store.releaseLock(bookKey, holder);
    }
  }
}
