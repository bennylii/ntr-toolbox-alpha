// 队列面板行内「筛选」按钮：真的调审计、标记落库、重跑换新、没 worker 时报错；
// 筛选中徽章变「待筛选」+ 按钮禁用，完成即恢复
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-1 + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-queue-audit.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;

// 抓通知（只活 1 秒，必须边出现边抓）
const notes = [];
const obs = new MutationObserver((muts) => {
  muts.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType === 1 && n.className && String(n.className).includes('ntr-notification')) notes.push(n.textContent || '');
  }));
});
obs.observe(document.body, { childList: true, subtree: true });

const mkJob = async (options, entries, title) => {
  const created = await Q.addJobs([{ kind: 'wenku', novelId: 'mock-1', title: title || '筛选按钮用例' }], options);
  const job = created[0];
  job.state = 'review';
  job.entries = entries;
  job.resultCount = entries.length;
  await Q.put(job);
  return job;
};
const entries4 = () => ([
  { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 871 },
  { src: '代々木駅', dst: '代代木站', type: '地名', count: 1 },
  { src: '教室', dst: '教室', type: '地名', count: 9 },
  { src: 'ボブ', dst: '鲍勃', type: '男性人名', count: 30 },
]);
const baseOptions = (endpoint) => ({
  ...Q.extractSettings(),
  testEndpoint: endpoint,
  testModel: 'mock-glossary-1',
  testKey: 'x',
  timeoutMs: 15000,
});
const panelBtn = (label) => {
  const panel = document.getElementById('ntr-queue-overlay');
  return panel && Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === label);
};
// 按任务标题定位那一行的按钮（面板里可能有多条任务）
const rowBtn = (title, label) => {
  const panel = document.getElementById('ntr-queue-overlay');
  if (!panel) return null;
  const tr = Array.from(panel.querySelectorAll('tbody tr')).find((r) => r.textContent.includes(title));
  return tr && Array.from(tr.querySelectorAll('button')).find((b) => b.textContent === label);
};
// 按任务标题读状态徽章文案
const rowBadge = (title) => {
  const panel = document.getElementById('ntr-queue-overlay');
  if (!panel) return null;
  const tr = Array.from(panel.querySelectorAll('tbody tr')).find((r) => r.textContent.includes(title));
  const b = tr && tr.querySelector('.ntr-g-badge');
  return b ? b.textContent : null;
};

try {
  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);

  // ---------- A. 正常筛选 ----------
  const jobA = await mkJob(baseOptions('http://127.0.0.1:8788?audit=2&run=' + Date.now()), entries4(), '用例A-正常');
  await Q.openPanel();
  await sleep(400);
  check('待确认任务的行内有「筛选」按钮', !!rowBtn('用例A-正常', '筛选') || !!panelBtn('筛选'), Array.from((document.getElementById('ntr-queue-overlay') || document).querySelectorAll('button')).map((b) => b.textContent).slice(0, 12));
  notes.length = 0;
  rowBtn('用例A-正常', '筛选').click();
  for (let i = 0; i < 40; i++) { if (notes.some((n) => /筛选完成|筛选失败/.test(n))) break; await sleep(250); }
  const afterA = await Q.get(jobA.id);
  const markedA = afterA.entries.filter((e) => e.audit);
  check('点「筛选」真的跑了审计并写回标记（2 条）', markedA.length === 2 && markedA.every((e) => e.audit.why && e.audit.note), afterA.entries.map((e) => [e.src, !!e.audit]));
  check('job.auditAt 有值（标记随任务持久化）', !!afterA.auditAt);
  check('面板提示写清结果', notes.some((n) => /筛选完成：2 条建议删/.test(n)), notes);
  check('没被标的条目不带 audit 字段', afterA.entries.filter((e) => !e.audit).length === 2);

  // ---------- A2. 筛选中：徽章「待筛选」+「筛选」按钮禁用；完成即恢复 ----------
  const jobA2 = await mkJob(baseOptions('http://127.0.0.1:8788?audit=2&slow=3000&run=' + Date.now()), entries4(), '用例A2-慢筛选');
  await Q.openPanel();   // put() 不触发重绘，强制渲染出带「筛选」的行（同 A/C 段）
  await sleep(400);
  notes.length = 0;
  rowBtn('用例A2-慢筛选', '筛选').click();
  let auditingSeen = false;
  for (let i = 0; i < 25; i++) { await sleep(150); if (Q._state().auditingIds.includes(jobA2.id)) { auditingSeen = true; break; } }
  await sleep(200);
  const badgeMid = rowBadge('用例A2-慢筛选');
  const bFilterMid = rowBtn('用例A2-慢筛选', '筛选');
  check('筛选中：_state 里能看到正在筛选的任务', auditingSeen, Q._state());
  check('筛选中：徽章从「待确认」变「待筛选」', badgeMid === '待筛选', { badgeMid });
  check('筛选中：「筛选」按钮禁用 + 置灰（防止重复开跑）',
    !!bFilterMid && bFilterMid.disabled === true && (bFilterMid.style || {}).opacity === '0.65',
    { disabled: bFilterMid && bFilterMid.disabled, title: bFilterMid && bFilterMid.title });
  for (let i = 0; i < 60; i++) { if (notes.some((n) => /筛选完成/.test(n))) break; await sleep(250); }
  await sleep(300);
  const badgeAfter = rowBadge('用例A2-慢筛选');
  const bFilterAfter = rowBtn('用例A2-慢筛选', '筛选');
  const afterA2 = await Q.get(jobA2.id);
  check('筛选完成：徽章回到「待确认」、按钮恢复、标记已写',
    badgeAfter === '待确认' && !!bFilterAfter && bFilterAfter.disabled !== true
    && afterA2.entries.filter((e) => e.audit).length === 2 && !Q._state().auditingIds.includes(jobA2.id),
    { badgeAfter, disabled: bFilterAfter && bFilterAfter.disabled, marked: afterA2.entries.filter((e) => e.audit).length, auditing: Q._state().auditingIds });

  // ---------- B. 重跑换新（audit=1 → 标记整批替换） ----------
  const jobB = await mkJob(baseOptions('http://127.0.0.1:8788?audit=1&run=' + Date.now()), entries4(), '用例B-重跑');
  jobB.entries[0].audit = { why: '5', note: '旧标记' };   // 先塞一个旧标记，验证会被替换/清掉
  jobB.state = 'review';
  await Q.put(jobB);
  notes.length = 0;
  await Q.auditJob(jobB.id);
  const afterB = await Q.get(jobB.id);
  const markedB = afterB.entries.filter((e) => e.audit);
  check('重跑后标记整批换新（只剩 1 条，且不是旧标记）', markedB.length === 1 && markedB[0].note !== '旧标记', afterB.entries.map((e) => [e.src, e.audit ? e.audit.note : null]));

  // ---------- C. 没有可用翻译器时报错 ----------
  const jobC = await mkJob({ ...baseOptions(''), workerId: '不存在的翻译器', testModel: '' }, entries4(), '用例C-无worker');
  jobC.state = 'review';
  await Q.put(jobC);
  await Q.openPanel();
  await sleep(400);
  notes.length = 0;
  rowBtn('用例C-无worker', '筛选').click();
  for (let i = 0; i < 20; i++) { if (notes.length > 0) break; await sleep(250); }
  check('没有 worker 时给出明确报错', notes.some((n) => /没有可用的翻译器/.test(n)), notes);
  const afterC = await Q.get(jobC.id);
  check('报错时不动数据（仍无标记）', afterC.entries.every((e) => !e.audit));
  check('同一条待确认任务同时有「预览」', !!rowBtn('用例A-正常', '预览'));
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  obs.disconnect();
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  for (const j of await Q.list()) await Q.remove(j.id);
  const p = document.getElementById('ntr-queue-overlay');
  if (p) p.remove();
  out.notes.push('cleanup: 队列已清空、队列面板已关闭');
}
return JSON.stringify(out, null, 1);
