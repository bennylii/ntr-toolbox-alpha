// 冷却机制验证：单槽位 + 时长抖动的慢上游下，runJob 不应连环撞 "busy"（被放弃的任务仍占着上游）
// 用法：
//   1) 以特殊模式重启 mock：
//      MOCK_SLOTS=1 MOCK_SLOW_MS=6000 MOCK_SLOW_JITTER=4000 MOCK_BUSY_AFTER=3 node mock-llm/server.mjs
//   2) node tools/cooldown-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const userscript = path.join(here, '..', 'NTR_ToolBox.user.js');
const extractPath = path.join(here, '.engine-extract.mjs');

const source = fs.readFileSync(userscript, 'utf8');
const start = source.indexOf('// ==GlossaryEngine-START==');
const end = source.indexOf('// ==GlossaryEngine-END==');
if (start < 0 || end < 0) {
  console.error('未找到 GlossaryEngine 标记段');
  process.exit(2);
}
fs.writeFileSync(extractPath, source.slice(start, end) + '\nexport { GlossaryEngine };\n');
const { GlossaryEngine: E } = await import('file://' + extractPath.replace(/\\/g, '/'));

const MOCK = 'http://127.0.0.1:8788';
const stats = () => fetch(MOCK + '/__stats').then((r) => r.json());

const before = await stats();
console.log('mock 起始统计:', { requests: before.requests, busyRejects: before.busyRejects });

const lines = [];
for (let i = 0; i < 30; i++) lines.push(`第${i}段：魔導具師ダリヤとヴォルフレッドが王都カルロッツァで出会った。`);

const phases = [];
const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: MOCK, key: 'x' }];
const requester = E.createRequester(workers, { timeoutMs: 5000 });

const t0 = Date.now();
const result = await E.runJob({
  lines,
  callLLM: requester.call,
  options: { budgetChars: 40, maxRounds: 1, concurrency: 1 },
  onProgress: (p) => { if (p.phase === 'cooldown' || p.phase === 'round-start') phases.push(p.phase); },
});
const after = await stats();

const busy = after.busyRejects - before.busyRejects;
const reqs = after.requests - before.requests;
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | 请求 ${reqs} | busy 拒绝 ${busy} | 完成块 ${result.chunksDone} | 失败块 ${result.chunksFailed}`);
console.log('cooldown 上报次数:', phases.filter((p) => p === 'cooldown').length);

assert.ok(busy <= 2, `busy 拒绝应接近 0，实际 ${busy}`);
assert.ok(phases.includes('cooldown'), '超时后应上报 cooldown 阶段（冷却生效）');
console.log('\n通过：单槽位抖动上游下冷却生效，未出现 busy 风暴');
