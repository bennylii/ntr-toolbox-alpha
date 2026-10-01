// 线上演示速览角标：入队一条（只入队不跑）→ 看 |队列:1| → 清掉 → 回到 0
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glance = () => {
  const h = Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('术语队列'));
  const el = h && h.querySelector('.ntr-module-glance');
  return el ? el.textContent : null;
};
const clearJobs = async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const names = ['jobs', 'chunks'].filter((n) => db.objectStoreNames.contains(n));
  const tx = db.transaction(names, 'readwrite');
  names.forEach((n) => tx.objectStore(n).clear());
  await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  db.close();
};
try {
  out.before = glance();
  await clearJobs();
  await sleep(1300);
  out.afterClear = glance();
  const header = Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('AI提取术语表'));
  header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(1600);
  out.afterEnqueue = glance();
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const jobs = await new Promise((res) => { const g = db.transaction('jobs', 'readonly').objectStore('jobs').getAll(); g.onsuccess = () => res(g.result); });
  out.job = jobs.map((j) => ({ id: j.id, state: j.state, maxLines: j.options.maxLines }));
  db.close();
  out.note = '截图后清空（注意：只入队不跑，别刷新页面——刷新会触发自动续跑）';
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
