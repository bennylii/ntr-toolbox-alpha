// tools/.probe-empty-paragraphs.mjs —— 空行场景探针（只读）：统计站点章节 paragraphJp 里的空段
//
// 目的：核实「生产翻译输入是否存在空段」——mock 的 paragraphJp 全非空，而 LG 对比里
// 112/300 空行只出现在本地 txt 合成摘录；本探针用真站点数据（库内第一本书前 3 章）给出实测结论，
// 决定 daemon 是否需要「分段前过滤空行 + 提交前原位回填」（见 docs/lg-compare.md 第四节第 2 条）。
//
// 零写入：只调 getTranslateTasks / getChapterTask（读接口），不提交、不改库。
//
// 用法：
//   node tools/.probe-empty-paragraphs.mjs                # 库内第一本书，前 3 章
//   node tools/.probe-empty-paragraphs.mjs --book web:syosetu/nXXXXxx --chapters 5
//   node tools/.probe-empty-paragraphs.mjs --db daemon/daemon.db
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

const args = process.argv.slice(2);
const flag = (name, dflt = '') => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const DB_PATH = path.resolve(flag('db', path.join(repo, 'daemon', 'daemon.db')));
const BOOK_KEY = flag('book', '');
const CHAPTERS = Math.max(1, Number(flag('chapters', '3')) || 3);

const store = new Store(DB_PATH);
const engine = await loadEngine();
const token = store.getConfig('token') || '';
if (!token) {
  console.error(`没有站点凭据（${DB_PATH} 的 config.token 为空）：先启动 daemon 在控制台点「从站点同步」，或 daemon auth <token>`);
  process.exit(2);
}
const books = store.listBooks();
const book = BOOK_KEY ? store.getBook(BOOK_KEY) : books[0];
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

console.log(`书：${book.key}（${book.kind}）· 探针范围：前 ${CHAPTERS} 章 · 站点请求重试 ${retries} 次`);
const tasks = await client.getTranslateTasks(book, 'gpt');
const flat = [];
for (const task of tasks) {
  for (const item of task.toc || []) {
    if (item.chapterId) flat.push({ chapterId: item.chapterId, volumeId: task.volumeId || '', title: item.titleJp || '' });
  }
}
console.log(`章节目录：${flat.length} 章（toc）`);
if (flat.length === 0) { console.error('toc 为空：这本书在站点上没有可翻译章节'); process.exit(1); }

let totalParagraphs = 0;
let totalEmpty = 0;
let chaptersWithEmpty = 0;
for (const item of flat.slice(0, CHAPTERS)) {
  const dto = await client.getChapterTask(book, item.chapterId, 'gpt', item.volumeId);
  const paragraphs = (dto.paragraphJp || []).map((p) => String(p == null ? '' : p));
  const emptyIdx = paragraphs.map((p, i) => (p.trim() === '' ? i : -1)).filter((i) => i >= 0);
  totalParagraphs += paragraphs.length;
  totalEmpty += emptyIdx.length;
  if (emptyIdx.length > 0) chaptersWithEmpty += 1;
  console.log(`  ${item.chapterId}${item.title ? `（${item.title}）` : ''}：${paragraphs.length} 段，空段 ${emptyIdx.length}` +
    (emptyIdx.length > 0 ? `（下标 ${emptyIdx.slice(0, 10).join('、')}${emptyIdx.length > 10 ? '…' : ''}）` : ''));
}

console.log('');
console.log(`实测：${Math.min(CHAPTERS, flat.length)} 章 / ${totalParagraphs} 段，空段合计 ${totalEmpty}（有空的章 ${chaptersWithEmpty}）`);
if (totalEmpty === 0) {
  console.log('结论：生产 paragraphJp 无空段——「分段前过滤空行」在站点在线路径没有收益，不实装（仅 import-lg/txt 合成摘录场景存在空行）。');
} else {
  console.log('结论：发现空段——需要评估 translate-pipeline 分段前过滤 + 提交前原位回填（上传契约不变），并补 translate-test 用例。');
}
