// 线上（测试 profile）验证：左键点「AI提取术语表」→ 只入队，不现场跑
// 跑法：cdp open https://n.novelia.cc/novel/kakyomu/... 后 node tools/cdp.mjs evalf tools/.probe-live-enqueue.js
const out = { before: null, after: null, newJob: null, probe: null, queuePanel: null, removed: null, notes: [] };
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const withJobs = async (fn) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction('jobs', 'readwrite');
  const store = tx.objectStore('jobs');
  const all = await reqP(store.getAll());
  const ret = await fn(store, all);
  await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  db.close();
  return ret;
};

try {
  const before = await withJobs(async (_s, all) => all);
  out.before = before.map((j) => ({ id: j.id, state: j.state, title: j.target && j.target.title }));
  const beforeIds = new Set(before.map((j) => j.id));

  // 先关掉可能开着的设置面板（右键切换），再左键执行模块
  const header = Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('AI提取术语表'));
  if (!header) throw new Error('找不到「AI提取术语表」模块行');
  if (document.querySelector('.ntr-settings-container')) header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  await new Promise((r) => setTimeout(r, 300));
  header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1500));
  out.probe = window.__probe || null;

  const after = await withJobs(async (_s, all) => all);
  out.after = after.map((j) => ({ id: j.id, state: j.state, title: j.target && j.target.title }));
  const fresh = after.filter((j) => !beforeIds.has(j.id));
  out.newJob = fresh.map((j) => ({ id: j.id, state: j.state, target: j.target, options: { workerId: j.options && j.options.workerId, budgetChars: j.options && j.options.budgetChars, maxRounds: j.options && j.options.maxRounds, timeoutMs: j.options && j.options.timeoutMs, testEndpoint: j.options && j.options.testEndpoint } }));

  // 队列面板（左键「术语队列」）
  const qHeader = Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('术语队列'));
  qHeader.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 800));
  const ov = document.getElementById('ntr-queue-overlay');
  out.queuePanel = ov ? { stats: ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent, hasPending: /待处理/.test(ov.textContent), hasTitle: !!out.newJob[0] && ov.textContent.includes(String(out.newJob[0].target && (out.newJob[0].target.title || ''))) } : 'no overlay';
  if (ov) ov.remove();

  // 收尾：删掉这次新入队的任务，恢复现场
  out.removed = await withJobs(async (store, _all) => {
    for (const j of fresh) await reqP(store.delete(j.id));
    return fresh.map((j) => j.id);
  });
  const final = await withJobs(async (_s, all) => all);
  out.notes.push(`收尾后队列剩 ${final.length} 条（与开始时一致：${final.length === before.length}）`);
  const st = document.getElementById('ntr-glossary-status');
  if (st) { out.notes.push(`提取浮窗文本：${st.textContent.replace(/\s+/g, ' ').slice(0, 60)}`); st.remove(); }
  else out.notes.push('提取浮窗：没有出现（符合预期）');
} catch (e) {
  out.notes.push('ERR ' + String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
