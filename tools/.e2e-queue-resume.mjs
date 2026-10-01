// 队列续跑端到端：
//  1) mock 让部分块失败 -> 任务 failed（chunk2/3 未完成，chunk1 已缓存）
//  2) 换成健康端点 -> 刷新页面重新注入 -> 自动续跑
//  3) 校验：只补发未完成块（mock 请求增量 == 剩余块数），最终状态 review
import { execFileSync } from 'node:child_process';

const cdp = (args) => execFileSync('node', ['tools/cdp.mjs', ...args], { encoding: 'utf8', timeout: 120000 }).trim();
const evalJson = (expr) => {
  const raw = cdp(['eval', expr]);
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  return JSON.parse(raw.slice(i, j + 1));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const volumeId = 'jp.测试卷.测试用.txt';
const results = {};

// mock 统计
const mockStats = async () => JSON.parse(execFileSync('node', ['-e', `
  fetch('http://127.0.0.1:8788/__stats').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('{}'));
`], { encoding: 'utf8' }).trim());

console.log('== 准备：本地卷任务参数直接写在 job.options 上（并发1/轮数1/分块1500/行数120/临时端点=mock）');
cdp(['open', 'https://n.novelia.cc/bookshelf/local']);
cdp(['inject']);
console.log('== 准备：造一个本地卷（清理脚本会把它删掉，跑前要重建）');
console.log('   ' + cdp(['evalf', 'tools/.mk-volume.js']).replace(/\s+/g, ' ').slice(0, 120));

console.log('== 阶段1：加入本地卷任务并运行（预期的失败脚本）');
results.enqueued = evalJson(`(async () => {
  const D = window._NTRGlossaryDev;
  const jobs = await D.GlossaryQueue.list();
  for (const j of jobs) await D.GlossaryQueue.remove(j.id);
  const created = await D.GlossaryQueue.addJobs([{ kind: 'local', volumeId: '${volumeId}', title: '${volumeId}' }], D.GlossaryQueue.extractSettings());
  // 参数直接写在任务的 options 上（改 localStorage 里的配置要等下次加载才生效，且会污染用户配置）；
  // 临时端点必须连 testModel 一起给，否则 resolveWorkers 视为"没填模型"返回空
  const j = await D.GlossaryQueue.get(created[0].id);
  j.options.concurrency = 1;
  j.options.maxRounds = 1;
  j.options.budgetChars = 1500;
  j.options.maxLines = 120;
  j.options.timeoutMs = 8000;
  j.options.testEndpoint = 'http://127.0.0.1:8788?script=ok,429,429&run=' + Date.now();
  j.options.testModel = 'mock-glossary-1';
  await D.GlossaryQueue.put(j);
  return { id: created[0].id };
})()`);

evalJson(`(() => { window._NTRGlossaryDev.GlossaryQueue.runLoop(); return { started: true }; })()`);
let job1 = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  job1 = evalJson(`(async () => { const j = await window._NTRGlossaryDev.GlossaryQueue.get('${results.enqueued.id}'); return { state: j.state, progress: j.progress, error: j.error, resultCount: j.resultCount }; })()`);
  if (job1.state === 'failed' || job1.state === 'review' || job1.state === 'done') break;
}
results.phase1 = job1;
const stats1 = await mockStats();
results.requests1 = stats1.requests;

console.log('阶段1 状态:', JSON.stringify(job1));

console.log('== 阶段2：换健康端点 -> 刷新页面 -> 自动续跑');
evalJson(`(async () => {
  const D = window._NTRGlossaryDev;
  const j = await D.GlossaryQueue.get('${results.enqueued.id}');
  j.options.testEndpoint = 'http://127.0.0.1:8788?script=ok&run=healthy' + Date.now();
  j.options.testModel = 'mock-glossary-1';
  j.state = 'pending';
  await D.GlossaryQueue.put(j);
  return { ok: true };
})()`);
cdp(['open', 'https://n.novelia.cc/bookshelf/local']);   // 刷新（脚本消失）
cdp(['inject']);                                          // 重新注入 -> init() 自动续跑
let job2 = null;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  job2 = evalJson(`(async () => { const j = await window._NTRGlossaryDev.GlossaryQueue.get('${results.enqueued.id}'); return { state: j.state, progress: j.progress, error: j.error, resultCount: j.resultCount, entrySample: (j.entries||[]).slice(0,3).map(e=>e.src+'='+e.dst) }; })()`);
  if (job2.state === 'review' || job2.state === 'done' || job2.state === 'failed') break;
}
results.phase2 = job2;
const stats2 = await mockStats();
results.requests2 = stats2.requests;
results.resumeRequestDelta = stats2.requests - stats1.requests;

console.log('阶段2 状态:', JSON.stringify(job2));
console.log('mock 请求：阶段1 =', results.requests1, ' 阶段2 =', results.requests2, ' 续跑增量 =', results.resumeRequestDelta);

// 断言
// 阶段1：部分成功 -> 待确认（保留部分结果，备注里标注未完成行数）；全部失败才是 failed
const ok1 = (job1.state === 'review' || job1.state === 'failed') && job1.progress && job1.progress.pendingLines > 0;
const ok2 = (job2.state === 'review' || job2.state === 'done') && job2.resultCount > 0;
const ok3 = results.resumeRequestDelta > 0 && results.resumeRequestDelta <= 2;   // 只补未完成块（1~2 个）
console.log('\n阶段1 部分失败:', ok1 ? 'PASS' : 'FAIL');
console.log('阶段2 续跑成功:', ok2 ? 'PASS' : 'FAIL', '(entries=' + job2.resultCount + ', ' + JSON.stringify(job2.entrySample) + ')');
console.log('续跑不重发已完成块:', ok3 ? 'PASS' : 'FAIL', '(增量=' + results.resumeRequestDelta + ')');
process.exit(ok1 && ok2 && ok3 ? 0 : 1);
