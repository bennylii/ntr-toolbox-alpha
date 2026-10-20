// tools/.probe-context-preview.mjs —— 相邻段上下文探针（只读）：用真站点章节预演「参考上文/参考下文」
//
// 目的：在真站点数据上量出「开上下文后每个段实际会带几行、提示词涨多少字符、正文行数不变」，
// 以及句末标点门槛在真实正文上的命中率（很多行不以句末标点结尾 → 上文可能为空）。
// 复用 daemon 自己的实现（segmentLines / collectContextLines / buildTranslateMessages），
// 与线上路径同一份代码，不做任何写入、不发任何 LLM 请求。
//
// 用法：
//   node tools/.probe-context-preview.mjs                          # 库内第一本书，前 1 章，上文 2 / 下文 1
//   node tools/.probe-context-preview.mjs --book web:syosetu/nXXX --chapters 2 --before 3 --after 2
//   node tools/.probe-context-preview.mjs --db daemon/daemon.db
//
// 前置：daemon 已同步站点凭据（控制台「从站点同步」或 daemon auth <token>）；
//       站点只能走代理且链路抖动，探针复用 config.site.retries 与 daemon/proxy.mjs（失败会自动重试）。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const imp = (name) => import(pathToFileURL(path.join(repo, 'daemon', name)).href);
const { Store } = await imp('store.mjs');
const { loadEngine } = await imp('engine.mjs');
const { SiteClient } = await imp('site-client.mjs');
const { createProxyFetch } = await imp('proxy.mjs');
const { segmentLines, splitEmptyParagraphs, collectContextLines, buildTranslateMessages } = await imp('translate.mjs');

const args = process.argv.slice(2);
const flag = (name, dflt = '') => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const DB_PATH = path.resolve(flag('db', path.join(repo, 'daemon', 'daemon.db')));
const BOOK_KEY = flag('book', '');
const CHAPTERS = Math.max(1, Number(flag('chapters', '1')) || 1);
const BEFORE = Math.max(0, Math.min(20, Number(flag('before', '2')) || 0));
const AFTER = Math.max(0, Math.min(20, Number(flag('after', '1')) || 0));

const store = new Store(DB_PATH);
const engine = await loadEngine();
const token = store.getConfig('token') || '';
if (!token) {
  console.error(`没有站点凭据（${DB_PATH} 的 config.token 为空）：先启动 daemon 在控制台点「从站点同步」，或 daemon auth <token>`);
  process.exit(2);
}
const book = BOOK_KEY ? store.getBook(BOOK_KEY) : store.listBooks()[0];
if (!book) {
  console.error(BOOK_KEY ? `book 不存在：${BOOK_KEY}` : '库里还没有登记的书（daemon add <novel-url>）');
  process.exit(2);
}
const siteCfg = store.getConfig('site') || {};
const retries = Number.isFinite(Number(siteCfg.retries)) ? Math.max(0, Math.min(8, Math.floor(Number(siteCfg.retries)))) : 3;
const proxyFetch = createProxyFetch({ getProxy: () => store.getConfig('proxy') });
const client = new SiteClient({
  origin: book.origin || store.getConfig('origin') || 'https://n.novelia.cc',
  token, engine, fetchImpl: proxyFetch, retries,
  onRetry: (e, n, label) => console.log(`  [重试 ${n}/${retries}] ${(e && e.message) || e}（${String(label).slice(0, 80)}）`),
});

console.log(`书：${book.key}（${book.kind}）· 前 ${CHAPTERS} 章 · 上文 ${BEFORE} 行 / 下文 ${AFTER} 行 · 站点请求重试 ${retries} 次`);
const tasks = await client.getTranslateTasks(book, 'gpt');
const flat = [];
for (const task of tasks) {
  for (const item of task.toc || []) {
    if (item.chapterId) flat.push({ chapterId: item.chapterId, volumeId: task.volumeId || '', title: item.titleJp || '' });
  }
}
if (flat.length === 0) { console.error('toc 为空：这本书在站点上没有可翻译章节'); process.exit(1); }

const userLen = (lines, preceding, following) => buildTranslateMessages(lines, {}, { preceding, following })[1].content.length;
let segTotal = 0;
let segWithPre = 0;
let segWithFol = 0;
let preLines = 0;
let folLines = 0;
let linesTotal = 0;
let charsOn = 0;
let charsOff = 0;
let lastLineSentenceEnd = 0;
let nonEmptyTotal = 0;

for (const item of flat.slice(0, CHAPTERS)) {
  const dto = await client.getChapterTask(book, item.chapterId, 'gpt', item.volumeId);
  const paragraphs = (dto.paragraphJp || []).map((p) => String(p == null ? '' : p));
  const { filled } = splitEmptyParagraphs(paragraphs);   // 与线上一致：空段不进分段/请求
  const segments = segmentLines(filled);
  const offsets = [];
  { let off = 0; for (const seg of segments) { offsets.push(off); off += seg.length; } }
  let pre = 0, fol = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const start = offsets[i];
    const got = collectContextLines(filled, { start, end: start + segments[i].length }, { before: BEFORE, after: AFTER });
    const lenOff = userLen(segments[i], [], []);
    const lenOn = userLen(segments[i], got.preceding, got.following);
    charsOff += lenOff;
    charsOn += lenOn;
    segTotal += 1;
    if (got.preceding.length > 0) { segWithPre += 1; pre += got.preceding.length; }
    if (got.following.length > 0) { segWithFol += 1; fol += got.following.length; }
    if (i === 0) console.log(`  ${item.chapterId} 段1/${segments.length}：正文 ${segments[i].length} 行 · 上文 ${got.preceding.length} 行 / 下文 ${got.following.length} 行 · user 消息 ${lenOff} → ${lenOn} 字符`);
    if (i === 1) console.log(`  ${item.chapterId} 段2/${segments.length}：正文 ${segments[i].length} 行 · 上文 ${got.preceding.length} 行 / 下文 ${got.following.length} 行 · user 消息 ${lenOff} → ${lenOn} 字符`);
  }
  preLines += pre;
  folLines += fol;
  linesTotal += filled.length;
  nonEmptyTotal += filled.length;
  for (const p of paragraphs) if (p.trim() !== '' && /[.。?？!！…」』]$/.test(p.trim())) lastLineSentenceEnd += 1;
  console.log(`  ${item.chapterId}${item.title ? `（${item.title}）` : ''}：${paragraphs.length} 段（非空 ${filled.length}）→ ${segments.length} 个段；带上文 ${segments.filter((s, i) => collectContextLines(filled, { start: offsets[i], end: offsets[i] + s.length }, { before: BEFORE, after: AFTER }).preceding.length > 0).length} 个 / 带下文 ${segments.filter((s, i) => collectContextLines(filled, { start: offsets[i], end: offsets[i] + s.length }, { before: BEFORE, after: AFTER }).following.length > 0).length} 个`);
}

console.log('');
console.log(`实测：${Math.min(CHAPTERS, flat.length)} 章 / 非空 ${nonEmptyTotal} 行 / ${segTotal} 个段`);
console.log(`  段覆盖：带上文 ${segWithPre}/${segTotal}（${(segWithPre / Math.max(1, segTotal) * 100).toFixed(1)}%）· 带下文 ${segWithFol}/${segTotal}`);
console.log(`  行数：上文累计 ${preLines} 行 · 下文累计 ${folLines} 行（正文 ${linesTotal} 行不变）`);
console.log(`  user 消息字符：关闭 ${charsOff} → 开启 ${charsOn}（+${(charsOn / Math.max(1, charsOff) * 100 - 100).toFixed(1)}%）；提示词上限默认 12000 字符`);
console.log(`  正文行以句末标点结尾的比例：${lastLineSentenceEnd}/${nonEmptyTotal}（${(lastLineSentenceEnd / Math.max(1, nonEmptyTotal) * 100).toFixed(1)}%）—— 门槛越严，带上文的段越少`);
if (segTotal <= 1) {
  console.log('结论：本章只切出 1 个段（1500 字符/30 行没到限）——上下文在这类短章上无用；多段章才受益。');
} else if (segWithPre + segWithFol === 0) {
  console.log('结论：没有任何段拿到上下文——正文行普遍不以句末标点结尾（门槛太严），可考虑只开下文或调大行数。');
} else {
  console.log('结论：上下文可用（见上面的段覆盖与字符增幅）；如需更强语境，可调大上文行数或先看上面的句末标点比例。');
}
console.log('零写入：本探针只调读接口（toc / chapter-task）+ 本地纯函数，不发 LLM 请求、不提交章节。');
