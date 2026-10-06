// daemon/agent-tools-read.mjs —— Agent 只读工具（A2）：书目/正文/译文/提案/快照/质检/技能
// 依赖注入：ctx.deps = { engine, makeClient, skills, textCache }（由 index.mjs 装配；测试可给假件）
import { checkAligned } from './quality.mjs';

const cut = (text, n) => {
  const s = String(text == null ? '' : text);
  return s.length > n ? `${s.slice(0, n)}…（已截断）` : s;
};

export function createReadTools({ store, engine, makeClient, log = console, textCache = new Map() } = {}) {
  const TEXT_TTL_MS = 10 * 60 * 1000;
  const getBook = (key) => {
    const book = store.getBook(String(key || ''));
    if (!book) throw Object.assign(new Error(`book 不存在：${key || '(空)'}；先用 list_books 查看已登记的书`), { code: 'book_not_found' });
    return book;
  };
  const bookText = async (book) => {
    const hit = textCache.get(book.key);
    if (hit && Date.now() - hit.at < TEXT_TTL_MS) return hit.text;
    const text = await makeClient(book).getBookText(book);
    textCache.set(book.key, { text, at: Date.now() });
    return text;
  };
  const BOOK_PARAM = { type: 'string', description: '书的 key（如 web:syosetu/nXXXXxx 或 wenku:xxxx），先用 list_books 查' };

  return [
    {
      name: 'list_books',
      description: '列出 daemon 已登记的书（key/类型/标题/状态/已译章数）。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const books = store.listBooks().map((b) => ({
          key: b.key, kind: b.kind, title: b.title || '', state: b.state,
          progress: store.listProgress(b.key).length,
        }));
        return { count: books.length, books };
      },
    },
    {
      name: 'book_status',
      description: '查看一本书的状态：进度、最近运行、站点术语表条数、快照与未决提案数量。',
      parameters: { type: 'object', properties: { book: BOOK_PARAM }, required: ['book'] },
      async execute(args) {
        const book = getBook(args.book);
        let glossaryCount = null;
        let glossaryError = '';
        try { glossaryCount = Object.keys(await makeClient(book).getGlossary(book)).length; } catch (e) { glossaryError = cut((e && e.message) || e, 160); }
        return {
          key: book.key, kind: book.kind, title: book.title || '', state: book.state,
          progress: store.listProgress(book.key).length,
          runs: store.listRuns(50).filter((r) => r.bookKey === book.key).slice(0, 5)
            .map((r) => ({ job: r.job, state: r.state, stats: r.stats, startedAt: r.startedAt })),
          glossaryCount,
          glossaryError,
          snapshots: store.listSnapshots(book.key).length,
          proposals: store.listProposals(book.key).filter((p) => p.status === 'open').length,
        };
      },
    },
    {
      name: 'read_book',
      description: '按行窗口读取一本书的原文（行号从 1 开始）。大书请配合 offset/limit 分页；maxChars 控制返回体积。',
      parameters: {
        type: 'object',
        properties: {
          book: BOOK_PARAM,
          offset: { type: 'number', description: '起始行（0 基），默认 0' },
          limit: { type: 'number', description: '最多返回行数（默认 200，上限 500）' },
          maxChars: { type: 'number', description: '返回文本上限（默认 6000 字符）' },
        },
        required: ['book'],
      },
      async execute(args) {
        const book = getBook(args.book);
        const text = await bookText(book);
        const lines = engine.splitLines(text);
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const limit = Math.min(500, Math.max(1, Math.floor(Number(args.limit) || 200)));
        const maxChars = Math.min(20000, Math.max(500, Math.floor(Number(args.maxChars) || 6000)));
        const window = [];
        let used = 0;
        let truncated = false;
        for (let i = offset; i < Math.min(lines.length, offset + limit); i += 1) {
          const line = lines[i];
          if (used + line.length > maxChars) { truncated = true; break; }
          used += line.length;
          window.push({ n: i + 1, text: line });
        }
        return { book: book.key, totalLines: lines.length, offset, count: window.length, truncated, lines: window };
      },
    },
    {
      name: 'read_translations',
      description: '按窗口读取「原文 + 译文」对齐对（网络小说走 jp-zh 下载，文库逐章）。用于核对术语落地与译文质量。',
      parameters: {
        type: 'object',
        properties: {
          book: BOOK_PARAM,
          offset: { type: 'number' },
          limit: { type: 'number', description: '最多返回对数（默认 20，上限 200）' },
        },
        required: ['book'],
      },
      async execute(args) {
        const book = getBook(args.book);
        const aligned = await makeClient(book).getAlignedPairs(book);
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 20)));
        return {
          book: book.key,
          total: aligned.pairs.length,
          translationMissing: aligned.translationMissing || 0,
          chapterMissing: aligned.chapterMissing || 0,
          offset,
          count: aligned.pairs.slice(offset, offset + limit).length,
          pairs: aligned.pairs.slice(offset, offset + limit).map((p) => ({ jp: cut(p.jp, 400), zh: cut(p.zh, 400), chapter: p.chapter || '' })),
        };
      },
    },
    {
      name: 'list_proposals',
      description: '列出待审提案（glossary/quality/import 等）：默认只看 open。',
      parameters: {
        type: 'object',
        properties: {
          book: { type: 'string', description: '可选：只看某本书' },
          limit: { type: 'number', description: '默认 20，上限 50' },
          onlyOpen: { type: 'boolean', description: '默认 true' },
        },
      },
      async execute(args) {
        const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit) || 20)));
        let rows = store.listProposals(args.book ? String(args.book) : undefined);
        if (args.onlyOpen !== false) rows = rows.filter((p) => p.status === 'open');
        return {
          count: rows.length,
          proposals: rows.slice(0, limit).map((p) => ({
            id: p.id, bookKey: p.bookKey, kind: p.kind, status: p.status, at: p.at, note: p.note,
            entries: (p.entries || []).slice(0, 20),
            entriesTotal: (p.entries || []).length,
          })),
        };
      },
    },
    {
      name: 'list_snapshots',
      description: '列出某本书的术语表快照（写入前自动留存；回滚需要审批）。',
      parameters: { type: 'object', properties: { book: BOOK_PARAM }, required: ['book'] },
      async execute(args) {
        const book = getBook(args.book);
        const rows = store.listSnapshots(book.key);
        return { book: book.key, count: rows.length, snapshots: rows.slice(0, 20) };
      },
    },
    {
      name: 'quality_report',
      description: '对一本书跑一次只读质检（七码：假名残留/相似度/术语未落地/标点/缺译/保留段/重试阈值），返回计数与样例。不会修改任何数据。',
      parameters: {
        type: 'object',
        properties: {
          book: BOOK_PARAM,
          codes: { type: 'array', items: { type: 'string' }, description: '可选：只看这些码' },
          limit: { type: 'number', description: '样例上限，默认 20' },
        },
        required: ['book'],
      },
      async execute(args) {
        const book = getBook(args.book);
        const client = makeClient(book);
        const glossary = await client.getGlossary(book);
        const aligned = await client.getAlignedPairs(book);
        const retriesByChapter = {};
        for (const row of store.listChapterMeta(book.key)) {
          if ((row.retries || 0) >= 2) retriesByChapter[row.chapterKey] = row.retries;
        }
        const report = checkAligned({
          pairs: aligned.pairs,
          glossary,
          engine,
          rules: store.listRules(book.key),
          translationMissing: aligned.translationMissing || 0,
          retriesByChapter,
          limit: Math.min(50, Math.max(1, Math.floor(Number(args.limit) || 20))),
          codes: Array.isArray(args.codes) && args.codes.length > 0 ? args.codes : null,
        });
        return { book: book.key, pairs: report.pairs, translationMissing: report.translationMissing, codes: report.codes, samples: report.samples };
      },
    },
    {
      name: 'list_warnings',
      description: '读取上次质检（check 任务）落库的警告列表（不需重跑）：按码计数 + 明细（章节/行号/代码/细节/证据）。找要处理的译文问题时先看这里。',
      parameters: {
        type: 'object',
        properties: {
          book: BOOK_PARAM,
          code: { type: 'string', description: '可选：只看某个码（如 FOREIGN_CHAR_RESIDUE / TEXT_PRESERVE）' },
          limit: { type: 'number', description: '条数上限，默认 100' },
        },
        required: ['book'],
      },
      async execute(args) {
        const book = getBook(args.book);
        const summary = store.warningSummary(book.key);
        const warnings = store.listWarnings(book.key, {
          code: String(args.code || ''),
          limit: Math.min(500, Math.max(1, Math.floor(Number(args.limit) || 100))),
        });
        return {
          book: book.key,
          summary,
          note: summary.total === 0 ? '暂无落库警告（先跑 check 任务）' : '来自最近一次 check 落库',
          warnings,
        };
      },
    },
    {
      name: 'list_skills',
      description: '列出可用技能包（名称/描述/文件数）。',
      parameters: { type: 'object', properties: {} },
      async execute(args, ctx) {
        const skills = ctx && ctx.deps && ctx.deps.skills;
        if (!skills) return { count: 0, skills: [] };
        const list = skills.list();
        return { count: list.length, skills: list.map((s) => ({ name: s.name, description: cut(s.description, 200), files: s.files.length })) };
      },
    },
    {
      name: 'read_skill',
      description: '读取技能包内的文件（默认 SKILL.md）。技能是处理术语/翻译/质检任务的操作指南，需要时先读再动手。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（见 list_skills）' },
          path: { type: 'string', description: '包内相对路径，默认 SKILL.md' },
        },
        required: ['name'],
      },
      async execute(args, ctx) {
        const skills = ctx && ctx.deps && ctx.deps.skills;
        if (!skills) throw Object.assign(new Error('技能目录未装配'), { code: 'skills_unavailable' });
        const result = skills.read(args.name, args.path || 'SKILL.md');
        return { name: result.skill, path: result.path, basePath: result.basePath, content: cut(result.content, 8000) };
      },
    },
  ];
}
