// 队列运行类参数（并发/RPM/逾时）：右键「术语队列」设置里可覆盖（0=跟随「AI提取术语表」）；
// 内容类参数仍用入队快照
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-queue-live-settings.js
// 依赖：mock 在 8788
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra: extra === undefined ? undefined : JSON.parse(JSON.stringify(extra === null ? null : extra)) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;

const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === 'AI提取术语表');
const setSetting = (name, value) => {
  const s = mod.settings.find((x) => x.name === name);
  if (!s) throw new Error('找不到设置项：' + name);
  s.value = value;
};
const origSettings = {};
['并发', 'RPM', '逾时(秒)', '分块字数', '最大轮数', '行数上限'].forEach((n) => {
  const s = mod.settings.find((x) => x.name === n);
  origSettings[n] = s && s.value;
});
// 队列自己的运行类覆盖（右键「术语队列」设置里那三项）
const qMod = window._NTRToolBox.configuration.modules.find((m) => m.name === '术语队列');
const setQ = (name, value) => {
  const s = qMod.settings.find((x) => x.name === name);
  if (!s) throw new Error('找不到队列设置项：' + name);
  s.value = value;
};
const origQueue = {};
['并发(0=跟随)', 'RPM(0=跟随)', '逾时(秒,0=跟随)'].forEach((n) => {
  const s = qMod.settings.find((x) => x.name === n);
  origQueue[n] = s && s.value;
});

let origCreate = null;
let origRun = null;
const reqCaptured = [];
const runCaptured = [];
const target = { kind: 'wenku', novelId: 'mock-src', title: 'mock-src' };
// 纯函数用例：故意用一组"不像真的会跑"的内容类参数，证明它们原样保留
const contentOptions = () => ({
  sourceLanguage: 'KO',
  budgetChars: 600,
  maxTokens: 0,
  maxRounds: 1,
  concurrency: 3,
  rpm: 0,
  timeoutMs: 300000,
  maxLines: 7,
  workerId: 'w1',
  testEndpoint: `${location.origin}`,
  testModel: 'mock-glossary-1',
  testKey: 'x',
});
// 实跑用例：mock 正文是日文，语言过滤必须用 JA，否则整篇被清空 → 正文为空
const runOptions = () => ({
  sourceLanguage: 'JA',
  budgetChars: 300,
  maxTokens: 0,
  maxRounds: 1,
  concurrency: 3,
  rpm: 0,
  timeoutMs: 300000,
  maxLines: 0,
  workerId: '',
  testEndpoint: `${location.origin}`,
  testModel: 'mock-glossary-1',
  testKey: 'x',
});
// 跑到任务不再是 running 为止；返回见过的进度预计文案
const waitJob = async (jobId, samples, maxTick) => {
  const etaSeen = [];
  let sawRunning = false;
  for (let i = 0; i < (maxTick || 24); i++) {
    await sleep(700);
    const job = (await Q.list()).find((j) => j.id === jobId) || {};
    if (job.state === 'running') {
      sawRunning = true;
      const el = document.getElementById('ntr-g-eta');
      if (el && el.textContent) etaSeen.push(el.textContent);
    }
    if (sawRunning && job.state !== 'running') break;
  }
  if (samples) etaSeen.forEach((t) => samples.push(t));
  return sawRunning;
};

try {
  // ---------- A. 纯函数：运行类实时 / 内容类快照 ----------
  setSetting('并发', 5);
  setSetting('RPM', 120);
  setSetting('逾时(秒)', 45);
  setSetting('分块字数', 3000);
  setSetting('最大轮数', 3);
  setSetting('行数上限', 0);
  const merged = Q.jobRuntime(contentOptions());
  check('并发/RPM/逾时 用实时公用设置',
    merged.concurrency === 5 && merged.rpm === 120 && merged.timeoutMs === 45000,
    { concurrency: merged.concurrency, rpm: merged.rpm, timeoutMs: merged.timeoutMs });
  check('分块字数/最大轮数/行数上限/原文语言/翻译器选择 仍是入队快照',
    merged.budgetChars === 600 && merged.maxRounds === 1 && merged.maxLines === 7 && merged.sourceLanguage === 'KO'
    && merged.workerId === 'w1' && merged.testEndpoint === `${location.origin}`,
    { budgetChars: merged.budgetChars, maxRounds: merged.maxRounds, sourceLanguage: merged.sourceLanguage });
  const noSnap = Q.jobRuntime(null);
  check('老备份（无 job.options）→ 整份用实时设置', noSnap.concurrency === 5 && noSnap.timeoutMs === 45000 && noSnap.budgetChars === 3000 && noSnap.sourceLanguage === 'JA',
    { concurrency: noSnap.concurrency, budgetChars: noSnap.budgetChars });

  // ---------- B. 实跑：请求层拿到的是实时值 ----------
  Q.stop();
  await sleep(200);
  for (const j of await Q.list()) await Q.remove(j.id);
  origCreate = D.GlossaryEngine.createRequester;
  origRun = D.GlossaryEngine.runJob;
  D.GlossaryEngine.createRequester = (w, o) => { reqCaptured.push({ ...(o || {}) }); return origCreate(w, o); };
  D.GlossaryEngine.runJob = (a) => { runCaptured.push({ ...((a && a.options) || {}) }); return origRun(a); };

  setSetting('并发', 1);
  setSetting('RPM', 0);
  setSetting('逾时(秒)', 45);
  const created = await Q.addJobs([target], { ...runOptions(), testEndpoint: `${location.origin}?slow=1000&run=` + Date.now() });
  const jobId = created[0].id;
  await Q.openPanel();
  await sleep(300);
  Q.runLoop();
  const etaSeen = [];
  const sawRunning = await waitJob(jobId, etaSeen);
  const job1 = await Q.get(jobId);

  check('实跑用实时并发（入队 3 → 现 1）', reqCaptured.length > 0 && reqCaptured.every((o) => o.rps === 1), reqCaptured);
  check('实跑用实时逾时（入队 300s → 现 45s）', reqCaptured.length > 0 && reqCaptured.every((o) => o.timeoutMs === 45000), reqCaptured);
  check('引擎轮次参数里的并发也走实时值', runCaptured.length > 0 && runCaptured.every((o) => o.concurrency === 1), runCaptured);
  check('分块字数仍用入队快照（300，面板改 3000 也不动）', runCaptured.length > 0 && runCaptured.every((o) => o.budgetChars === 300), runCaptured);
  check('面板进度预计右侧标出生效值', sawRunning && etaSeen.some((t) => /并发 1/.test(t) && /逾时 45s/.test(t)), etaSeen.slice(-3));
  check('任务确实跑完（到 review）', job1 && job1.state === 'review' && job1.progress && job1.progress.pendingLines === 0, job1 && { state: job1.state, p: job1.progress });

  const foot = document.querySelector('#ntr-queue-overlay .ntr-g-warn');
  check('面板底部说明写清覆盖入口、哪些实时、哪些快照',
    !!foot && /右键「术语队列」的设置里可覆盖/.test(foot.textContent) && /0=跟随/.test(foot.textContent) && /在入队时固定/.test(foot.textContent),
    foot && foot.textContent);

  // 「说明」默认收起（页脚只占一行），点开全文、再点收起
  const hintBtn = [...document.querySelectorAll('#ntr-queue-overlay .ntr-g-foot button')].find((b) => b.textContent.startsWith('说明'));
  check('页脚「说明」默认收起：按钮文案 ▸、正文不可见（文案仍在 DOM）',
    !!hintBtn && hintBtn.textContent === '说明 ▸' && getComputedStyle(foot).display === 'none' && foot.textContent.length > 100,
    { btn: hintBtn && hintBtn.textContent, disp: foot && getComputedStyle(foot).display });
  hintBtn.click();
  await sleep(50);
  check('点「说明」展开全文（▾ + 可见）', hintBtn.textContent === '说明 ▾' && getComputedStyle(foot).display !== 'none', hintBtn.textContent);
  hintBtn.click();
  await sleep(50);
  check('再点收起（▸ + 不可见）', hintBtn.textContent === '说明 ▸' && getComputedStyle(foot).display === 'none', hintBtn.textContent);

  // 改设置：同一个已入队任务立刻跟着变（证明是执行时读，不是入队时读）
  setSetting('并发', 3);
  setSetting('逾时(秒)', 90);
  reqCaptured.length = 0;
  runCaptured.length = 0;
  const created2 = await Q.addJobs([target], { ...runOptions(), testEndpoint: `${location.origin}?slow=400&run=` + Date.now() });
  Q.runLoop();
  await waitJob(created2[0].id, null);
  await sleep(400);
  check('改设置后，已入队的任务按新值跑',
    reqCaptured.some((o) => o.rps === 3 && o.timeoutMs === 90000) && runCaptured.some((o) => o.concurrency === 3),
    { req: reqCaptured, run: runCaptured });

  // ---------- C. 审计（再次筛选）也用实时值 ----------
  setSetting('并发', 2);
  setSetting('RPM', 120);
  setSetting('逾时(秒)', 45);
  const auditRow = (await Q.addJobs([target], { ...runOptions(), testEndpoint: `${location.origin}?audit=1&run=` + Date.now() }))[0];
  auditRow.state = 'review';
  auditRow.entries = [
    { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 871 },
    { src: '代々木駅', dst: '代代木站', type: '地名', count: 1 },
  ];
  auditRow.resultCount = 2;
  await Q.put(auditRow);
  reqCaptured.length = 0;
  await Q.auditJob(auditRow.id);
  const afterAudit = await Q.get(auditRow.id);
  check('审计请求也用实时值（逾时 45s / RPM 120）',
    reqCaptured.length > 0 && reqCaptured.every((o) => o.timeoutMs === 45000 && o.rpm === 120), reqCaptured);
  check('审计仍写入标记（功能没被改坏）', afterAudit.entries.filter((e) => e.audit).length === 1, afterAudit.entries.map((e) => [e.src, !!e.audit]));
  out.notes.push('阶段小结：job1=' + (job1 && job1.state) + '，审计标记=' + afterAudit.entries.filter((e) => e.audit).length);

  // ---------- D. 队列设置里的运行类覆盖（右键「术语队列」→ 设置；0=跟随） ----------
  // 此刻公用设置 = 并发 2 / RPM 120 / 逾时 45
  setQ('并发(0=跟随)', 7); setQ('RPM(0=跟随)', 60); setQ('逾时(秒,0=跟随)', 33);
  const over = Q.jobRuntime(contentOptions());
  check('队列覆盖优先：三项都按队列设置走（不是公用设置）',
    over.concurrency === 7 && over.rpm === 60 && over.timeoutMs === 33000,
    { concurrency: over.concurrency, rpm: over.rpm, timeoutMs: over.timeoutMs });
  check('覆盖只动运行类：分块字数/语言/轮数仍是入队快照',
    over.budgetChars === 600 && over.sourceLanguage === 'KO' && over.maxRounds === 1,
    { budgetChars: over.budgetChars, sourceLanguage: over.sourceLanguage });
  setQ('RPM(0=跟随)', 0); setQ('逾时(秒,0=跟随)', 0);
  const partialOv = Q.jobRuntime(contentOptions());
  check('单项覆盖：只覆盖并发，RPM/逾时回落到公用设置（120 / 45s）',
    partialOv.concurrency === 7 && partialOv.rpm === 120 && partialOv.timeoutMs === 45000,
    { concurrency: partialOv.concurrency, rpm: partialOv.rpm, timeoutMs: partialOv.timeoutMs });
  setQ('并发(0=跟随)', 0);
  const followOv = Q.jobRuntime(contentOptions());
  check('全 0 = 跟随：三项都回落到公用设置',
    followOv.concurrency === 2 && followOv.rpm === 120 && followOv.timeoutMs === 45000,
    { concurrency: followOv.concurrency, rpm: followOv.rpm, timeoutMs: followOv.timeoutMs });
  // 实跑：请求层拿到的是队列覆盖值（公用 2 / 队列 8）
  setQ('并发(0=跟随)', 8);
  reqCaptured.length = 0; runCaptured.length = 0;
  const created3 = await Q.addJobs([target], { ...runOptions(), testEndpoint: `${location.origin}?slow=400&run=` + Date.now() });
  Q.runLoop();
  await waitJob(created3[0].id, null);
  await sleep(400);
  check('实跑：请求层用队列覆盖的并发（公用 2 / 队列 8）',
    reqCaptured.length > 0 && reqCaptured.every((o) => o.rps === 8) && runCaptured.length > 0 && runCaptured.every((o) => o.concurrency === 8),
    { req: reqCaptured.slice(0, 2), run: runCaptured.slice(0, 2) });
  setQ('并发(0=跟随)', 0);
  out.notes.push('D 段小结：覆盖值进请求层 = ' + (reqCaptured.length > 0 && reqCaptured.every((o) => o.rps === 8)));
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  if (origCreate) D.GlossaryEngine.createRequester = origCreate;
  if (origRun) D.GlossaryEngine.runJob = origRun;
  Object.keys(origSettings).forEach((n) => setSetting(n, origSettings[n]));
  Object.keys(origQueue).forEach((n) => {
    const s = qMod && qMod.settings.find((x) => x.name === n);
    if (s) s.value = origQueue[n];
  });
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  for (const j of await Q.list()) await Q.remove(j.id);
  const p = document.getElementById('ntr-queue-overlay');
  if (p) p.remove();
  out.notes.push('cleanup: 队列已清空、面板已关、设置已还原 ' + JSON.stringify(origSettings) + ' / 队列覆盖 ' + JSON.stringify(origQueue));
}
return JSON.stringify(out, null, 1);
