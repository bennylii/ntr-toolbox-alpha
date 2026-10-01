// 「术语队列」行尾速览角标：队列（待处理）/ 运行中 的数字要跟着队列状态走
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-queue-glance.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const Q = window._NTRGlossaryDev.GlossaryQueue;
const box = window._NTRToolBox;
const dev = window._NTRGlossaryDev;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glance = () => {
  const h = Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('术语队列'));
  const el = h && h.querySelector('.ntr-module-glance');
  return el ? { text: el.textContent, cls: el.className.replace('ntr-module-glance', '').trim() } : null;
};
const force = async () => { box.refreshQueueGlance(true); await sleep(250); };

try {
  check('面板里有「术语队列」行且带速览角标', !!glance(), glance());

  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);
  await force();
  check('空队列时显示 |队列:0|运行中:0|', glance() && glance().text === '|队列:0|运行中:0|', glance());
  check('空队列时不高亮', glance() && glance().cls === '', glance());

  const target = await dev.resolveGlossaryTarget();
  // 把任务拖慢一点（每块 2.5s、行数 240 → 单个任务要跑十几秒），这样「1 个在跑 + 1 个排队」的状态
  // 稳定存在，角标断言不会因为任务恰好跑完而抖
  const options = { ...Q.extractSettings(), sourceLanguage: 'JA', budgetChars: 1500, maxRounds: 1, concurrency: 1, maxLines: 240, workerId: '', testEndpoint: 'http://127.0.0.1:8788?slow=2500&run=' + Date.now(), testModel: 'mock-glossary-1', testKey: 'x' };
  await Q.addJobs([target], options);
  await Q.addJobs([target], options);
  await force();
  check('两条待处理 → |队列:2|运行中:0|', glance() && glance().text === '|队列:2|运行中:0|', glance());
  check('有待处理时给高亮 class', glance() && /has/.test(glance().cls), glance());

  Q.runLoop();
  const t0 = Date.now();
  let running = null;
  while (Date.now() - t0 < 10000) {
    const j = (await Q.list()).find((x) => x.state === 'running');
    if (j) { running = j; break; }
    await sleep(120);
  }
  check('任务进入「提取中」（能观察运行中计数）', !!running, Q._state());
  await force();
  check('运行中 → |队列:1|运行中:1|', glance() && glance().text === '|队列:1|运行中:1|', glance());
  check('运行中给 busy class', glance() && /busy/.test(glance().cls), glance());

  // 不手动 refresh，验证 1s 节流的轮询也会自己更新
  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);
  await sleep(1600);
  check('停止并清空后，轮询自己把角标刷回 0', glance() && glance().text === '|队列:0|运行中:0|', glance());
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  for (const j of await Q.list()) await Q.remove(j.id);
  out.notes.push('cleanup: 队列已清空、循环已停');
}
return JSON.stringify(out, null, 1);
