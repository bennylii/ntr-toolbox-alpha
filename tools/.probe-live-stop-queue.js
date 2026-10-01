// 停掉测试浏览器里自动续跑的队列循环（它会用工作区翻译器的真实 key 调上游），并清掉测试残留
const out = {};
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const openDB = () => new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
try {
  // 1) 打开队列面板，点「停止」
  const qHeader = Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('术语队列'));
  qHeader.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 800));
  let ov = document.getElementById('ntr-queue-overlay');
  const stopBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '停止');
  out.stopBtnFound = !!stopBtn;
  if (stopBtn) { stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
  await new Promise((r) => setTimeout(r, 1500));
  ov = document.getElementById('ntr-queue-overlay');
  out.panelAfterStop = ov ? { stats: ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent, hasStopped: /停止|已停/.test(ov.textContent) } : 'no overlay';
  if (ov) ov.remove();

  // 2) 清掉任务与分块（测试残留）
  const db = await openDB();
  const names = ['jobs', 'chunks', 'snapshots'].filter((n) => db.objectStoreNames.contains(n));
  const tx = db.transaction(names, 'readwrite');
  const before = {};
  for (const n of names) { const s = tx.objectStore(n); before[n] = (await reqP(s.getAll())).map((x) => `${x.id || ''}:${x.state || ''}`); s.clear(); }
  await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  db.close();
  out.cleared = before;
  await new Promise((r) => setTimeout(r, 1200));
  const db2 = await openDB();
  out.jobsAfterClear = (await reqP(db2.transaction('jobs', 'readonly').objectStore('jobs').getAll())).length;
  db2.close();

  // 3) 快照一下当前对外请求时间线（用于稍后对比是否还有新请求）
  const now = performance.now();
  out.llmTimeline = performance.getEntriesByType('resource')
    .filter((e) => /deepseek|chat\/completions|generativelanguage|openai/i.test(e.name))
    .map((e) => Math.round((now - e.startTime) / 1000))
    .slice(-8);
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
