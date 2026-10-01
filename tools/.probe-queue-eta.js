// 冒烟：队列统计行右侧的「进度预计」在实际跑动时是否更新
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { samples: [], errors: [] };
const etaText = () => {
  const el = document.getElementById('ntr-g-eta');
  return el ? el.textContent : '(no el)';
};
try {
  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);
  const target = { kind: 'wenku', novelId: 'mock-src', title: 'mock-src' };
  const options = {
    ...Q.extractSettings(),
    sourceLanguage: 'JA',
    budgetChars: 300,
    maxRounds: 1,
    concurrency: 1,
    maxLines: 0,
    workerId: '',
    testEndpoint: 'http://127.0.0.1:8788?slow=2500&run=' + Date.now(),
    testModel: 'mock-glossary-1',
    testKey: 'x',
  };
  const created = await Q.addJobs([target], options);
  out.jobId = created[0].id;
  await Q.openPanel();
  await sleep(300);
  out.etaIdle = etaText();
  Q.runLoop();
  for (let i = 0; i < 9; i++) {
    await sleep(1500);
    const jobs = await Q.list();
    const job = jobs.find((j) => j.id === out.jobId) || {};
    const p = job.progress || {};
    out.samples.push({ t: i, state: job.state, done: p.chunksDone, base: p.chunksBase, total: p.totalChunks, eta: etaText() });
    if (job.state !== 'running' && job.state !== 'pending') break;
  }
  // 纯函数直测：8 块/分 × 剩 40 块 → 5 分钟
  const t0 = 1_700_000_000_000;
  out.etaPure = Q.etaFor(
    { round: 0, chunksDone: 10, totalChunks: 50, chunksBase: 0, roundStartedAt: t0 - 60 * 1000 },
    [{ t: t0 - 60 * 1000, done: 0 }, { t: t0 - 56 * 1000, done: 4 }, { t: t0, done: 8 }],
    t0,
  );
  out.etaNothing = Q.etaFor({ round: 0, chunksDone: 0, totalChunks: 0 }, [], t0);
  out.etaDone = Q.etaFor({ round: 0, chunksDone: 50, totalChunks: 50, chunksBase: 0 }, [], t0);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  try { Q.stop(); } catch (e) { }
  await sleep(500);
  for (const j of await Q.list()) await Q.remove(j.id);
  out.cleanup = '队列已清空';
}
return JSON.stringify(out, null, 1);
