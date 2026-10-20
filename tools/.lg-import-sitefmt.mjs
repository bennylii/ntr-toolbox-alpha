// tools/.lg-import-sitefmt.mjs —— 站点格式的 LG 译文 → export-src 契约结果 txt（离线转换 / 排查用）
//
// 说明：控制台「导入 LG 译文」与 CLI `import-lg` 现在**已经自动识别**站点「下载原文」格式（mode=jp）的
// LG 译文——本工具只是把同一套对齐算法离线跑一遍，用于：① 想事先落一份契约格式文件；② 对齐不过时
// 看逐章诊断（--report）；③ 手里有站点原文快照（--jp）不想让 daemon 再抓一次。
//   对齐内核在 daemon/lg-align.mjs：convertSiteFormat / fetchSiteExportLines / alignLgResult
//
// 用法：
//   node tools/.lg-import-sitefmt.mjs --book web:syosetu/n7608cw \
//     --zh "C:\...\jp.书名_译文\jp.书名.txt" \
//     --manifest daemon/exports/lg-src-<书名>.txt.manifest.json \
//     [--jp <站点mode=jp快照.txt>] [--out <结果.txt>] [--report <诊断.json>]
//
// 之后（两种都可以）：直接把这个 txt 交给控制台「导入 LG 译文」，或
//   node daemon/index.mjs import-lg --book <key> --txt <结果.txt> --manifest <清单.json> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const imp = (name) => import(pathToFileURL(path.join(repo, 'daemon', name)).href);
const { convertSiteFormat, splitResultLines, looksLikeSiteFormat, fetchSiteExportLines } = await imp('lg-align.mjs');

const args = process.argv.slice(2);
const flag = (name, dflt = '') => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const BOOK_KEY = flag('book');
const ZH_FILE = flag('zh');
const MANIFEST = flag('manifest');
const JP_FILE = flag('jp');
const OUT_FILE = flag('out');
const REPORT_FILE = flag('report');
if (!BOOK_KEY || !ZH_FILE || !MANIFEST) {
  console.error('用法: node tools/.lg-import-sitefmt.mjs --book <key> --zh <LG译文.txt> --manifest <清单.json> [--jp <站点mode=jp快照.txt>] [--out <结果.txt>] [--report <json>]');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.resolve(MANIFEST), 'utf8'));
const zhLines = splitResultLines(fs.readFileSync(path.resolve(ZH_FILE), 'utf8'));
const srcTxtGuess = path.resolve(MANIFEST).replace(/\.manifest\.json$/, '');
if (fs.existsSync(srcTxtGuess)) {
  const srcLines = splitResultLines(fs.readFileSync(srcTxtGuess, 'utf8'));
  let selfOk = 0;
  const { createHash } = await import('node:crypto');
  const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex');
  for (const e of manifest.chapters) if (sha1(srcLines.slice(e.start, e.start + e.count).join('\n')) === e.jpSha1) selfOk += 1;
  console.log(`自检：同目录源文导出 vs 清单 sha1 命中 ${selfOk}/${manifest.chapters.length}`);
}

let jpLines;
if (JP_FILE) {
  jpLines = splitResultLines(fs.readFileSync(path.resolve(JP_FILE), 'utf8'));
} else {
  const { Store } = await imp('store.mjs');
  const { createProxyFetch } = await imp('proxy.mjs');
  const { SiteClient } = await imp('site-client.mjs');
  const { loadEngine } = await imp('engine.mjs');
  const store = new Store(path.join(repo, 'daemon', 'daemon.db'));
  const book = store.getBook(BOOK_KEY);
  if (!book) throw new Error(`book 未登记：${BOOK_KEY}（先 daemon/index.mjs add <url>）`);
  const client = new SiteClient({
    origin: book.origin || store.getConfig('origin'), token: store.getConfig('token') || '',
    engine: await loadEngine(), fetchImpl: createProxyFetch({ getProxy: () => store.getConfig('proxy') }),
    onRetry: (e, n, label) => console.error(`  站点请求失败，重试 ${n}：${(e && e.message) || e}`),
  });
  console.log('抓取站点原文（mode=jp）…');
  jpLines = await fetchSiteExportLines(client, book);
}

if (!looksLikeSiteFormat(zhLines)) console.error('提示：这份译文里没看到 `############` / `# 标题` 行，可能本来就不是站点导出格式。');
const conv = convertSiteFormat({ zhLines, jpLines, manifest });
if (!conv.ok) {
  console.error(`对齐失败：${conv.reason}`);
  console.error('（不写结果文件：宁可拒绝，不导错位数据。可加 --jp 指定与译文配套的站点原文快照再试）');
  process.exit(1);
}
const shifted = conv.chapters.filter((c) => c.fileStart !== c.titlePos + 2).length;
console.log(`逐章对齐：成功 ${conv.chapters.length}/${manifest.chapters.length}（其中 ${shifted} 章靠 ±2 偏移兜底：前面是无章号的卷/分组标题）`);

const outFile = OUT_FILE ? path.resolve(OUT_FILE)
  : path.join(path.dirname(path.resolve(MANIFEST)), `lg-result-${manifest.book ? manifest.book.novelId : 'book'}.txt`);
// convertSiteFormat 已按清单章序输出契约行，这里只按条数切开写文件
const lines = [];
let cursor = 0;
for (const e of manifest.chapters) {
  lines.push(...conv.lines.slice(cursor, cursor + e.count));
  cursor += e.count;
}
fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log(`结果 txt → ${outFile}（${lines.length} 行，清单 ${manifest.linesTotal}；疑似未翻 ${conv.untranslated} 行——多为「◇」「「…………」」这类两侧同形的符号行）`);
console.log(`可直接交给控制台「导入 LG 译文」，或：node daemon/index.mjs import-lg --book ${BOOK_KEY} --txt "${outFile}" --manifest "${path.resolve(MANIFEST)}"`);
if (REPORT_FILE) fs.writeFileSync(path.resolve(REPORT_FILE), JSON.stringify({ manifest: path.resolve(MANIFEST), okCount: conv.chapters.length, chapters: conv.chapters }, null, 1), 'utf8');
