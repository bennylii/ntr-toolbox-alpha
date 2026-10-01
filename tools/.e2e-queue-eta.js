// 队列「进度预计」：纯函数 + 实跑文案
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-queue-eta.js
// 依赖：mock 在 8788（用 ?slow= 拖慢才有得看）
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;
const etaText = () => { const el = document.getElementById('ntr-g-eta'); return el ? el.textContent : null; };

try {
  // ---------- A. 纯函数 ----------
  const t0 = 1_700_000_000_000;
  const rate = Q.etaFor(
    { round: 0, chunksDone: 10, totalChunks: 50, chunksBase: 0, roundStartedAt: t0 - 60000 },
    [{ t: t0 - 60000, done: 0 }, { t: t0 - 56000, done: 4 }, { t: t0, done: 8 }],
    t0,
  );
  check('8 块/分 × 剩 40 块 → 5 分钟', rate && Math.round(rate.perMin) === 8 && Math.round(rate.etaMs / 60000) === 5, rate);
  const based = Q.etaFor({ round: 1, chunksDone: 30, totalChunks: 10, chunksBase: 25, timerBase: 25, roundStartedAt: t0 - 60000 }, [], t0);
  check('done 已扣掉轮内基数（chunksBase）：30-25=5/10，剩 5 块', based && based.done === 5 && based.total === 10, based);
  check('轮内基数扣完即完成 → null', Q.etaFor({ round: 1, chunksDone: 35, totalChunks: 10, chunksBase: 25, roundStartedAt: t0 - 60000 }, [], t0) === null);
  check('没有 totalChunks → null', Q.etaFor({ round: 0, chunksDone: 1, totalChunks: 0 }, [], t0) === null);
  check('已经跑完 → null', Q.etaFor({ round: 0, chunksDone: 50, totalChunks: 50, chunksBase: 0 }, [], t0) === null);
  const single = Q.etaFor({ round: 0, chunksDone: 3, totalChunks: 20, chunksBase: 0, roundStartedAt: t0 - 60000, timerBase: 0 }, [], t0);
  check('样本不足时用"本轮已耗时"兜底（3 块/分）', single && Math.round(single.perMin) === 3, single);
  const cachedOnly = Q.etaFor({ round: 0, chunksDone: 3, totalChunks: 20, chunksBase: 0, roundStartedAt: t0, timerBase: 3 }, [], t0);
  check('刚重放完缓存（计时基准=当前进度）→ 速度未知，不瞎报', cachedOnly && cachedOnly.perMin === 0 && cachedOnly.etaMs === null, cachedOnly);

  // ---------- B. 面板空队列 ----------
  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);
  await Q.openPanel();
  await sleep(300);
  check('空队列不显示进度预计', etaText() === '', etaText());

  // ---------- C. 实跑（慢速 mock） ----------
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
  const jobId = created[0].id;
  await sleep(200);
  Q.runLoop();
  const texts = [];
  let sawRunning = false;
  for (let i = 0; i < 12; i++) {
    await sleep(1200);
    const jobs = await Q.list();
    const job = jobs.find((j) => j.id === jobId) || {};
    if (job.state === 'running') {
      sawRunning = true;
      texts.push(etaText());
    }
    if (sawRunning && job.state !== 'running') break;
  }
  const runningTexts = texts.filter((t) => t);
  check('跑动时显示了「块」进度', sawRunning && runningTexts.length > 0 && runningTexts.every((t) => /块/.test(t)), texts);
  check('文案含「速度计算中…」或「块/分 + 预计还需」',
    runningTexts.every((t) => /速度计算中…/.test(t) || (/块\/分/.test(t) && /预计还需/.test(t))), runningTexts);
  const withRate = runningTexts.find((t) => /块\/分/.test(t));
  check('有速率后给出分钟级预估', !withRate || /预计还需 (\d+ 分|不到 1 分|\d+ 小时 \d+ 分)/.test(withRate), withRate);
  check('进度格式形如 n/m 块', runningTexts.every((t) => /^\d+\/\d+ 块/.test(t)) || runningTexts.some((t) => /第 \d+ 轮 \d+\/\d+ 块/.test(t)), runningTexts);
  for (let i = 0; i < 12 && etaText() !== ''; i++) await sleep(500);   // 面板自己会刷，等它刷到空
  check('任务结束后清空进度预计', etaText() === '', etaText());

  // 排队任务提示
  const created2 = await Q.addJobs([target], options);
  const created3 = await Q.addJobs([target], options);
  Q.runLoop();
  await sleep(1500);
  const t2 = etaText();
  check('还有排队任务时提示「还有 N 个排队」', /（还有 \d+ 个排队）/.test(t2), t2);
  Q.stop();
  await sleep(2600);
  for (const j of await Q.list()) await Q.remove(j.id);
  out.notes.push('cleanup: 队列已清空、循环已停');
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  for (const j of await Q.list()) await Q.remove(j.id);
}
return JSON.stringify(out, null, 1);
