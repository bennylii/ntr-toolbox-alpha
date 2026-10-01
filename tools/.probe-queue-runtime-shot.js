// 截图用：起一个慢速任务，让面板上出现「并发 / 逾时」的生效值（跑法见 .e2e-queue-live-settings.js 头部）
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
Q.stop();
for (const j of await Q.list()) await Q.remove(j.id);
await Q.addJobs([{ kind: 'wenku', novelId: 'mock-src', title: '进度预计演示' }], {
  ...Q.extractSettings(),
  sourceLanguage: 'JA', budgetChars: 300, maxRounds: 1, maxLines: 0, workerId: '',
  testEndpoint: 'http://127.0.0.1:8788?slow=4000&run=' + Date.now(),
  testModel: 'mock-glossary-1', testKey: 'x',
});
await Q.openPanel();
Q.runLoop();
await sleep(1200);
const job = (await Q.list())[0];
return JSON.stringify({ state: job.state, eta: (document.getElementById('ntr-g-eta') || {}).textContent });
