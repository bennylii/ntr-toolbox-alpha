// daemon/agent-tools-lg.mjs —— Agent 工具：LG 源文导出 / 译文结果导入（GPT 槽提交）
// 依赖注入：ctx.deps = { engine, makeClient, queueBusy, exportsDir }
// 上传走站点既有 gpt 契约（uploadChapter：glossaryId + 段落数严格一致 + sakuraVersion 0.9），
// 与翻译工作区同一入口，即"模拟 GPT 翻译器提交"。
import fs from 'node:fs';
import path from 'node:path';
import { collectChapters, buildSourceExport, manifestOf, splitResultLines, verifyImport } from './lg-align.mjs';

const safeName = (s) => String(s || '').replace(/[/|\\:*?"<>]/g, '').slice(0, 60) || 'book';

export function createLgTools() {
  const getDeps = (ctx) => {
    const deps = ctx && ctx.deps;
    if (!deps || !deps.makeClient) throw Object.assign(new Error('Agent 依赖未装配（makeClient）'), { code: 'deps_unavailable' });
    return deps;
  };
  const getBook = (store, key) => {
    const book = store.getBook(String(key || ''));
    if (!book) throw Object.assign(new Error(`book 不存在：${key || '(空)'}`), { code: 'book_not_found' });
    return book;
  };
  const assertIdle = (deps) => {
    if (deps.queueBusy && deps.queueBusy()) {
      throw Object.assign(new Error('有翻译任务正在运行（单队列占用中），请等它结束再操作'), { code: 'busy' });
    }
  };
  const clientOf = (deps, book) => deps.makeClient(book);
  const getChapterFn = (client, book) => (chapterId, volumeId) => client.getChapterTask(book, chapterId, 'gpt', volumeId);

  const verifyFromFile = async (ctx, args) => {
    const deps = getDeps(ctx);
    const book = getBook(ctx.store, args.book);
    const txt = fs.readFileSync(String(args.txtPath || ''), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(String(args.manifestPath || ''), 'utf8'));
    if (manifest.version !== 1) throw Object.assign(new Error(`清单版本不支持：${manifest.version}`), { code: 'bad_manifest' });
    if (manifest.book && manifest.book.key && manifest.book.key !== book.key) {
      throw Object.assign(new Error(`清单属于另一本书：${manifest.book.key} ≠ ${book.key}`), { code: 'bad_manifest' });
    }
    return verifyImport({
      resultLines: splitResultLines(txt),
      manifest,
      getChapter: getChapterFn(clientOf(deps, book), book),
    });
  };

  return [
    {
      name: 'export_lg_source',
      description: '把一本书的站点原文导出为纯文本（一行一段，无标记），并生成对齐清单；用户把它交给 LinguaGacha 建项目翻译，完成后用 import_lg_result 导回。',
      parameters: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          out: { type: 'string', description: '可选输出路径；默认 daemon/exports/lg-src-<书名>.txt' },
        },
        required: ['book'],
      },
      async execute(args, ctx) {
        const deps = getDeps(ctx);
        assertIdle(deps);
        const book = getBook(ctx.store, args.book);
        const client = clientOf(deps, book);
        const chapters = await collectChapters(client, book, (n, t) => ctx.onEvent && ctx.onEvent({ type: 'doing', text: `导出原文 ${n}：${t}` }));
        if (chapters.length === 0) throw Object.assign(new Error('没有可导出的章节'), { code: 'empty' });
        const built = buildSourceExport(chapters);
        const dir = deps.exportsDir || path.join(process.cwd(), 'exports');
        fs.mkdirSync(dir, { recursive: true });
        const file = (typeof args.out === 'string' && args.out !== '' && args.out !== 'true')
          ? path.resolve(args.out)
          : path.join(dir, `lg-src-${safeName(book.title || book.novelId)}.txt`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, built.text, 'utf8');
        fs.writeFileSync(`${file}.manifest.json`, JSON.stringify(manifestOf(book, built), null, 2), 'utf8');
        return { file, manifest: `${file}.manifest.json`, linesTotal: built.linesTotal, chapters: chapters.length, note: '交给 LG 翻译（txt 建项目即可，行数会原样保持）；完成后用 import_lg_result 导入。' };
      },
    },
    {
      name: 'import_lg_result',
      description: '导入 LinguaGacha 的译文结果 txt 并提交到站点 GPT 端。强制按清单校验行号对齐（总行数/每章行数/空模式/源 sha1），未通过校验的章不会上传。apply=false 时只出校验报告。',
      parameters: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          txtPath: { type: 'string', description: 'LG 译文结果 txt 的本地路径' },
          manifestPath: { type: 'string', description: 'export_lg_source 生成的 .manifest.json 路径' },
          apply: { type: 'boolean', description: '默认 true；false 时只校验出报告' },
          limit: { type: 'number', description: '本次最多上传章数，默认 0=不限' },
        },
        required: ['book', 'txtPath', 'manifestPath'],
      },
      requiresApproval: true,
      async preview(args, ctx) {
        const report = await verifyFromFile(ctx, args);
        const issues = report.chapters.filter((c) => !c.ok).slice(0, 10)
          .map((c) => ({ chapter: c.title || c.chapterId, reason: c.reason }));
        return {
          action: args.apply === false ? '校验 LG 译文（不提交）' : '校验并提交到站点 GPT 端',
          book: String(args.book),
          linesTotal: report.total > 0 ? undefined : undefined,
          okChapters: report.okCount,
          totalChapters: report.total,
          untranslatedLines: report.untranslated,
          globalError: report.globalError || '',
          issues,
          note: '提交即写入站点译文（模拟 GPT 翻译器：glossaryId + 段落数一致 + sakuraVersion 0.9）。',
        };
      },
      async execute(args, ctx) {
        assertIdle(getDeps(ctx));
        const report = await verifyFromFile(ctx, args);
        if (report.globalError) {
          return { ok: false, error: 'align_failed', details: report.globalError, okChapters: 0, totalChapters: report.total };
        }
        if (args.apply === false) {
          return { ok: true, verifiedOnly: true, okChapters: report.okCount, totalChapters: report.total, untranslatedLines: report.untranslated, issues: report.chapters.filter((c) => !c.ok).map((c) => ({ chapter: c.title || c.chapterId, reason: c.reason })) };
        }
        const deps = getDeps(ctx);
        const book = getBook(ctx.store, args.book);
        const client = clientOf(deps, book);
        const limit = Math.max(0, Math.floor(Number(args.limit) || 0));
        let uploaded = 0;
        let failed = 0;
        const results = [];
        for (const ch of report.chapters) {
          if (!ch.ok) { results.push({ chapter: ch.title || ch.chapterId, state: 'skipped', reason: ch.reason }); continue; }
          if (limit > 0 && uploaded >= limit) { results.push({ chapter: ch.title || ch.chapterId, state: 'pending' }); continue; }
          try {
            await client.uploadChapter(book, ch.chapterId, { glossaryId: ch.glossaryId, paragraphsZh: ch.paragraphsZh }, 'gpt', ch.volumeId);
            uploaded += 1;
            results.push({ chapter: ch.title || ch.chapterId, state: 'uploaded', paragraphs: ch.paragraphsZh.length });
            ctx.onEvent && ctx.onEvent({ type: 'doing', text: `已提交 ${uploaded}：${ch.title || ch.chapterId}` });
          } catch (e) {
            failed += 1;
            results.push({ chapter: ch.title || ch.chapterId, state: 'failed', reason: String((e && e.message) || e).slice(0, 160) });
          }
        }
        return { ok: failed === 0 && report.okCount === report.total, uploaded, failed, pending: report.total - report.okCount, okChapters: report.okCount, totalChapters: report.total, untranslatedLines: report.untranslated, results };
      },
    },
  ];
}
