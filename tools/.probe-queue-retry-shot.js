// 截图用：造一个"首轮整批失败、后轮救回"的任务，让面板出现「曾有 N 块次失败」+ 重跑按钮
const D = window._NTRGlossaryDev, Q = D.GlossaryQueue;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
Q.stop();
for (const j of await Q.list()) await Q.remove(j.id);
const created = await Q.addJobs([{ kind: 'wenku', novelId: 'mock-src', title: '重跑入口演示' }], {
  ...Q.extractSettings(), sourceLanguage: 'JA', maxLines: 0, workerId: '',
  budgetChars: 150, maxRounds: 3,
  testEndpoint: 'http://127.0.0.1:8788?script=' + Array(9).fill('empty').join(',') + ',ok&run=' + Date.now(),
  testModel: 'mock-glossary-1', testKey: 'x',
});
Q.runLoop();
for (let i = 0; i < 60; i++) { await sleep(400); const j = await Q.get(created[0].id); if (j.state !== 'running' && j.state !== 'pending') break; }
const job = await Q.get(created[0].id);
await Q.openPanel();
await sleep(600);
const tr = Array.from(document.querySelectorAll('#ntr-queue-overlay tbody tr')).find((r) => r.textContent.includes('重跑入口演示'));
return JSON.stringify({ state: job.state, progress: job.progress, progText: tr && tr.children[2].textContent, ops: tr && Array.from(tr.querySelectorAll('button')).map((b) => b.textContent) });
