// 用真实日文文本核对「倒排表版 searchForContext」与朴素版逐条一致，并给出提速比
// 用法: node tools/.verify-search-real.mjs   （离线，只读 tools/.sakura-real-jp.txt）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'NTR_ToolBox.user.js'), 'utf8');
const start = source.indexOf('// ==GlossaryEngine-START==');
const end = source.indexOf('// ==GlossaryEngine-END==');
const extractPath = path.join(here, '.engine-extract.mjs');
fs.writeFileSync(extractPath, source.slice(start, end) + '\nexport { GlossaryEngine };\n');
const { GlossaryEngine: E } = await import('file://' + extractPath.replace(/\\/g, '/'));

const text = fs.readFileSync(path.join(here, '.sakura-real-jp.txt'), 'utf8');
const lines = E.splitLines(text)
  .filter((line) => E.languageFilter(line, 'JA'))
  .filter((line) => !E.ruleFilter(line));
console.log(`真实文本：${text.length} 字符 → ${lines.length} 行（每行平均 ${(text.length / Math.max(1, lines.length)).toFixed(0)} 字）`);

let seed = 20260925;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
// 术语样本 = 从真实行里随机切 n-gram（2~8 字），再塞几个"长词 + 它的子串"专门压掩码逻辑
const terms = new Set();
while (terms.size < 800) {
  const line = lines[Math.floor(rnd() * lines.length)];
  if (!line || line.length < 3) continue;
  const s = Math.floor(rnd() * (line.length - 2));
  const t = line.slice(s, s + 2 + Math.floor(rnd() * 7));
  if (t.trim().length >= 2) terms.add(t);
}
const longLine = lines.reduce((a, b) => (b.length > (a || '').length ? b : a), '');
if (longLine && longLine.length > 12) { terms.add(longLine.slice(0, 8)); terms.add(longLine.slice(2, 6)); terms.add(longLine.slice(3, 5)); }
const srcs = [...terms];
console.log(`术语样本：${srcs.length} 条（2~8 字，含长词/子串组合）`);

// 朴素版（改动前的行为）
const naive = (glossary, all) => {
  const pool = all.slice();
  const ordered = glossary.slice().sort((a, b) => b.src.length - a.src.length);
  for (const entry of ordered) {
    const src = entry.src;
    const hits = new Set();
    pool.forEach((line, i) => { if (line.includes(src)) hits.add(i); });
    const contexts = [...new Set([...hits].map((i) => all[i]))].sort((a, b) => b.length - a.length);
    entry.context = contexts;
    entry.count = contexts.length;
    hits.forEach((i) => { pool[i] = pool[i].split(src).join('#'.repeat(src.length)); });
  }
  return ordered.sort((a, b) => b.count - a.count);
};

const t0 = process.hrtime.bigint();
const slow = naive(srcs.map((src) => ({ src, dst: '译' })), lines);
const naiveMs = Number(process.hrtime.bigint() - t0) / 1e6;

const t1 = process.hrtime.bigint();
const fast = E.searchForContext(srcs.map((src) => ({ src, dst: '译' })), lines);
const firstMs = Number(process.hrtime.bigint() - t1) / 1e6;

const t2 = process.hrtime.bigint();
E.searchForContext(srcs.map((src) => ({ src, dst: '译' })), lines);
const cachedMs = Number(process.hrtime.bigint() - t2) / 1e6;

assert.deepEqual(
  fast.map((e) => [e.src, e.count, e.context]),
  slow.map((e) => [e.src, e.count, e.context]),
  '索引版与朴素版结果必须逐条一致',
);
const total = fast.reduce((s, e) => s + e.count, 0);
console.log(`逐条一致 ✓（共 ${fast.length} 条，count 合计 ${total}，命中率 ${(fast.filter((e) => e.count > 0).length / fast.length * 100).toFixed(0)}%）`);
console.log(`耗时：朴素 ${naiveMs.toFixed(0)} ms → 索引首次 ${firstMs.toFixed(0)} ms（含建表）→ 复用表 ${cachedMs.toFixed(0)} ms`);
