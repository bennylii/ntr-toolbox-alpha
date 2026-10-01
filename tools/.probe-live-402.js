// 取一次 402 的上游正文：队列面板点「重试」→ 抓完就「停止」
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const qHeader = () => Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('术语队列'));
  qHeader().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(900);
  let ov = document.getElementById('ntr-queue-overlay');
  out.before = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  const retryBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '重试');
  if (retryBtn) retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(7000);
  ov = document.getElementById('ntr-queue-overlay');
  const stopBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '停止');
  if (stopBtn) stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.clicked = { retry: !!retryBtn, stop: !!stopBtn };
  await sleep(1500);
  ov = document.getElementById('ntr-queue-overlay');
  const cb = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  if (cb) cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await new Promise((ok, no) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const j = (await reqP(db.transaction('jobs', 'readonly').objectStore('jobs').getAll()))[0];
  db.close();
  out.after = { state: j.state, err: j.error, progress: j.progress };
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
