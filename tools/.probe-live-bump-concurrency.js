// 把正在跑的整本任务提到更高并发（利用分块缓存续跑，不重跑已完成的块）
// 步骤：队列面板「停止」→ 等循环退出（任务回到 pending）→ 直接把 job.options.concurrency 调大 → 「开始/续跑」
const out = {};
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const openDB = () => new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const jobOf = async () => {
  const db = await openDB();
  const all = await reqP(db.transaction('jobs', 'readonly').objectStore('jobs').getAll());
  db.close();
  return all[0];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const NEW_CONCURRENCY = Number(window.__conc || 0) || 6;
  const qHeader = () => Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('术语队列'));

  // 1) 停止
  qHeader().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(900);
  let ov = document.getElementById('ntr-queue-overlay');
  const stopBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '停止');
  if (stopBtn) stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);
  const closeBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  if (closeBtn) closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  // 2) 等循环真的退出（在跑的那一块收尾）
  const t0 = Date.now();
  let j = await jobOf();
  while (j && j.state === 'running' && Date.now() - t0 < 180000) {
    await sleep(2000);
    j = await jobOf();
  }
  out.stopped = { state: j && j.state, doneBefore: j && j.progress && j.progress.chunksDone, error: j && j.error };

  // 3) 改并发（直接写 IDB 的 job.options；循环已退出，不会被回写覆盖）
  const db = await openDB();
  const jtx = db.transaction('jobs', 'readwrite');
  const store = jtx.objectStore('jobs');
  const cur = await reqP(store.getAll());
  const job = cur[0];
  job.options.concurrency = NEW_CONCURRENCY;
  job.state = 'pending';
  await reqP(store.put(job));
  await new Promise((r) => { jtx.oncomplete = r; jtx.onerror = r; });
  db.close();
  out.patched = { id: job.id, concurrency: job.options.concurrency, state: job.state };

  // 4) 重新开始
  qHeader().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(900);
  ov = document.getElementById('ntr-queue-overlay');
  out.panelBefore = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  const startBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '开始/续跑');
  if (startBtn) startBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(2000);
  ov = document.getElementById('ntr-queue-overlay');
  out.panelAfter = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  const cb = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  if (cb) cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.glance = (qHeader().querySelector('.ntr-module-glance') || {}).textContent;
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
