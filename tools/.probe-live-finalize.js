// 让任务收尾：所有分块都在缓存里，再「开始/续跑」一次就会跑成「待确认」（不会再发请求）
const out = {};
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const jobOf = async () => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const all = await reqP(db.transaction('jobs', 'readonly').objectStore('jobs').getAll());
  db.close();
  return all[0];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const callsBefore = performance.getEntriesByType('resource').filter((e) => /deepseek/i.test(e.name)).length;
  const qHeader = () => Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('术语队列'));
  qHeader().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(900);
  let ov = document.getElementById('ntr-queue-overlay');
  const startBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '开始/续跑');
  if (startBtn) startBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  let j = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    await sleep(1500);
    j = await jobOf();
    if (!j || (j.state !== 'running' && j.state !== 'pending')) break;
    ov = document.getElementById('ntr-queue-overlay');
    if (ov) { const s = ov.querySelector('.ntr-g-stats'); if (s) out.liveStats = s.textContent; }
  }
  out.final = { state: j && j.state, error: j && j.error, progress: j && j.progress, entries: j && j.resultCount, optionConcurrency: j && j.options && j.options.concurrency };
  out.callsDelta = performance.getEntriesByType('resource').filter((e) => /deepseek/i.test(e.name)).length - callsBefore;
  ov = document.getElementById('ntr-queue-overlay');
  out.panel = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  const cb = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  if (cb) cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
