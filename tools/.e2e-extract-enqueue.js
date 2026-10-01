// 「AI提取术语表」的任务方式：默认只入队（不现场跑），切成「直接提取」才现场跑
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-1 + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-extract-enqueue.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const listJobs = async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction('jobs', 'readonly');
  const all = await reqP(tx.objectStore('jobs').getAll());
  db.close();
  return all;
};
const clearJobs = async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const names = ['jobs', 'chunks'].filter((n) => db.objectStoreNames.contains(n));
  const tx = db.transaction(names, 'readwrite');
  names.forEach((n) => tx.objectStore(n).clear());
  await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  db.close();
};

// 抓「提取浮窗出现」和提示文案（浮窗/通知都很短命）
const floats = [];
const notes = [];
const mo = new MutationObserver((muts) => {
  muts.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.id === 'ntr-glossary-status') floats.push(n.textContent.replace(/\s+/g, ' ').slice(0, 60));
    if (n.classList && n.classList.contains('ntr-notification-message')) notes.push(n.textContent);
    if (n.querySelectorAll) n.querySelectorAll('.ntr-notification-message').forEach((x) => notes.push(x.textContent));
  }));
});
mo.observe(document.body, { childList: true, subtree: true });

const llmCalls = () => performance.getEntriesByType('resource').filter((e) => /chat\/completions/.test(e.name)).length;

const setSetting = (mod, name, value) => { const s = mod.settings.find((x) => x.name === name); if (s) s.value = value; return s; };
const getSetting = (mod, name) => { const s = mod.settings.find((x) => x.name === name); return s && s.value; };

try {
  const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === 'AI提取术语表');
  check('模块存在', !!mod);
  const modeSetting = mod.settings.find((s) => s.name === '任务方式');
  check('新增设置「任务方式」，默认「加入队列」', !!modeSetting && modeSetting.type === 'select' && modeSetting.value === '加入队列', modeSetting);
  check('选项为 加入队列 / 直接提取', JSON.stringify(modeSetting.options) === JSON.stringify(['加入队列', '直接提取']), modeSetting.options);

  await clearJobs();
  const callsBefore = llmCalls();

  // A) 默认（加入队列）：点模块 → 只入队，不弹浮窗、不发 LLM 请求、不启动队列循环
  await mod.run(mod);
  await new Promise((r) => setTimeout(r, 400));
  const jobs = await listJobs();
  check('入队模式：队列里多了一条 pending', jobs.length === 1 && jobs[0].state === 'pending', jobs.map((j) => ({ id: j.id, state: j.state, target: j.target })));
  const job = jobs[0];
  check('入队的任务带上了当前提取设置（翻译器/分块字数/输出上限/逾时…）',
    job && job.options && 'budgetChars' in job.options && 'maxTokens' in job.options && 'maxRounds' in job.options && 'timeoutMs' in job.options && 'workerId' in job.options,
    job && job.options);
  check('入队模式：没有弹提取浮窗', floats.length === 0, floats);
  check('入队模式：没有发 LLM 请求', llmCalls() === callsBefore, { before: callsBefore, after: llmCalls() });
  check('入队模式：没有自动启动队列循环', window._NTRGlossaryDev.GlossaryQueue._state().loopActive === false);
  check('入队模式：提示里说明去哪里跑', notes.some((t) => /已加入队列/.test(t) && /术语队列/.test(t)), notes.slice(-3));

  // B) 切成「直接提取」：现场跑（会弹浮窗、走提取链路），队列数量不变
  //    离线页面里没有工作区翻译器，先给「临时端点」填上 mock LLM，让提取链路能起来
  setSetting(mod, '使用临时端点', true);
  setSetting(mod, '临时端点', 'http://127.0.0.1:8788/v1');
  setSetting(mod, '临时模型', 'mock-glossary-1');
  modeSetting.value = '直接提取';
  await mod.run(mod);
  await new Promise((r) => setTimeout(r, 800));
  check('直接提取：弹出了提取浮窗', floats.length > 0, floats);
  const stopBtn = document.querySelector('#ntr-glossary-status button.ntr-g-btn');
  if (stopBtn) stopBtn.click();   // 浮窗都在了，剩下的链路不用跑完
  await new Promise((r) => setTimeout(r, 200));
  check('直接提取：没有再往队列里加任务', (await listJobs()).length === 1, (await listJobs()).length);
  // 还原临时端点设置，收尾时也会再兜一次
  setSetting(mod, '使用临时端点', false);
  setSetting(mod, '临时端点', '');
  setSetting(mod, '临时模型', '');

  // C) 队列面板里能看到刚入队的那条
  window._NTRGlossaryDev.GlossaryQueue.openPanel();
  await new Promise((r) => setTimeout(r, 600));
  const ov = document.getElementById('ntr-queue-overlay');
  check('队列面板列出了刚入队的任务', !!ov && /共 1 \|/.test(ov.querySelector('.ntr-g-stats').textContent), ov && ov.querySelector('.ntr-g-stats').textContent);
  check('队列面板里那条是「待处理」', !!ov && /待处理/.test(ov.textContent));
  if (ov) ov.remove();
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  mo.disconnect();
  await clearJobs();
  const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === 'AI提取术语表');
  if (mod) {
    setSetting(mod, '任务方式', '加入队列');
    setSetting(mod, '使用临时端点', false);
    setSetting(mod, '临时端点', '');
    setSetting(mod, '临时模型', '');
    if (typeof window._NTRToolBox.saveConfiguration === 'function') window._NTRToolBox.saveConfiguration();
  }
  const st = document.getElementById('ntr-glossary-status');
  if (st) st.remove();
  const ov = document.getElementById('ntr-glossary-overlay');
  if (ov) ov.remove();
  out.notes.push('cleanup: 队列已清空、任务方式复原为「加入队列」、临时端点已还原/清空');
}
return JSON.stringify(out, null, 1);
