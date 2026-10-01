// 规模基准：几千条术语 / 几万行正文时，引擎里几个热点函数的实际耗时
// 用法: node tools/.bench-scale.mjs   （只读、离线，不碰网络）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'NTR_ToolBox.user.js'), 'utf8');
const start = source.indexOf('// ==GlossaryEngine-START==');
const end = source.indexOf('// ==GlossaryEngine-END==');
const extractPath = path.join(here, '.engine-extract.mjs');
fs.writeFileSync(extractPath, source.slice(start, end) + '\nexport { GlossaryEngine };\n');
const { GlossaryEngine: E } = await import('file://' + extractPath.replace(/\\/g, '/'));

// 固定种子伪随机，便于复现（必须用 Math.imul，否则 32 位乘法丢精度 → 序列退化卡死）
let seed = 20260924;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const POOL = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン魔導書剣姫聖女騎士団長悪魔天使精霊竜王国民軍都冒険者';
const word = (n) => { let s = ''; for (let i = 0; i < n; i++) s += POOL[Math.floor(rnd() * POOL.length)]; return s; };
const makeTerms = (m) => {
  const set = new Set();
  for (let guard = 0; set.size < m && guard < m * 200; guard++) set.add(word(3 + Math.floor(rnd() * 6)));
  if (set.size < m) throw new Error(`词表生成失败：只造出 ${set.size}/${m} 个唯一词`);
  return [...set];
};
const makeLines = (n, terms) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const parts = [];
    const len = 4 + Math.floor(rnd() * 6);
    for (let k = 0; k < len; k++) parts.push(rnd() < 0.22 ? terms[Math.floor(rnd() * terms.length)] : word(2 + Math.floor(rnd() * 4)));
    out.push(parts.join('、') + '。');
  }
  return out;
};
const ms = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };

const LINES = 15000;
console.log(`正文 ${LINES} 行（每行 15~45 字），术语字符串由同一字符池生成（偏同质，真实日文更分散）\n`);
console.log('  条数    searchForContext    searchForContext    uncoveredLines   审计提示词长度');
console.log('          （含建倒排表）        （复用倒排表）');
const heapMB = () => (process.memoryUsage().heapUsed / 1048576).toFixed(0);
const heap0 = heapMB();
for (const m of [200, 1000, 3000]) {
  const terms = makeTerms(m);
  const lines = makeLines(LINES, terms);
  const entries = terms.map((t) => ({ src: t, dst: '译' }));
  const [tFirst] = ms(() => E.searchForContext(entries.map((e) => ({ ...e })), lines));
  const [tCached] = ms(() => E.searchForContext(entries.map((e) => ({ ...e })), lines));
  // 缓存记录覆盖 ~90% 的行，模拟"重试只补剩余行"时的差集计算
  const records = [{ lines: lines.slice(0, Math.floor(LINES * 0.9)) }];
  const [tUncov] = ms(() => E.uncoveredLines(lines, records));
  const batch = entries.slice(0, 300).map((e) => ({ ...e, type: '人名', count: 12 }));
  const [tPrompt, prompt] = ms(() => E.buildAuditPrompt({ entries: batch, context: null }));
  console.log(`  ${String(m).padEnd(6)} ${tFirst.toFixed(0).padStart(12)} ms   ${tCached.toFixed(0).padStart(12)} ms   ${tUncov.toFixed(1).padStart(8)} ms   ${prompt.length} 字符/批(300 条)`);
}
console.log(`\n倒排表建完后堆占用 ≈ ${heapMB()} MB（起点 ${heap0} MB，三个规模各一份、随 lines 数组一起被回收）`);

// 审计批次数与提示词总量（决定「再次筛选」要发多少请求）
const terms3000 = makeTerms(3000);
const entries3000 = terms3000.map((t, i) => ({ src: t, dst: '译', type: '人名', count: 3 + (i % 40) }));
const perEntry = E.buildAuditPrompt({ entries: entries3000.slice(0, 50) }).length / 50;
console.log(`\n再次筛选 3000 条 → ${Math.ceil(entries3000.length / 300)} 个请求（每批 300 条；并行度由调用方传的「并发」决定），每条目约 ${perEntry.toFixed(0)} 字符；\n提示词总量约 ${((perEntry * 3000) / 1000).toFixed(0)} K 字符 ≈ ${Math.round((perEntry * 3000) / 1.5)} tokens 输入`);
