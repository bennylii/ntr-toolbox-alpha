// 队列面板：进度文案（轮次 + 块数 + 行覆盖率 + 累计失败）、「重试 / 重跑 / 预览」入口、工具栏禁用态、工具栏「重试未完成」
// 注意：重试类动作只把任务转「待处理」，不自动开跑（与启动/暂停解耦）——断言里都要显式点「开始/续跑」
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-queue-retry-btn.js
// 依赖：mock 在 8788
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;

const panelEl = () => document.getElementById('ntr-queue-overlay');
const rowByTitle = (title) => {
  const panel = panelEl();
  if (!panel) return null;
  return Array.from(panel.querySelectorAll('tbody tr')).find((r) => r.textContent.includes(title)) || null;
};
const rowBtn = (title, label) => {
  const tr = rowByTitle(title);
  return tr && Array.from(tr.querySelectorAll('button')).find((b) => b.textContent === label);
};
const rowBtnLabels = (title) => {
  const tr = rowByTitle(title);
  return tr ? Array.from(tr.querySelectorAll('button')).map((b) => b.textContent) : [];
};
const tBtn = (label) => {
  const panel = panelEl();
  return panel && Array.from(panel.querySelectorAll('.ntr-g-toolbar button')).find((b) => b.textContent === label);
};
const progText = (title) => {
  const tr = rowByTitle(title);
  return tr ? tr.children[2].textContent : null;
};
// 面板 1.5s 轮询一次，刚建的任务可能还没被渲染进去 → 等到出现想要的文案
const waitRowText = async (title, re, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const t = progText(title);
    if (t && re.test(t)) return t;
    if (Date.now() - t0 > ms) return t;
    await sleep(300);
  }
};
// 强制重绘面板（点「重新整理」），不用等 1.5s 轮询
const refreshPanel = async (ms = 500) => { const b = tBtn('重新整理'); if (b) b.click(); await sleep(ms); };
// 等「停止」变灰 = 循环真的退出了（!loopActive && !runningJobId）
const waitStopDisabled = async (ms = 9000) => {
  const t0 = Date.now();
  for (;;) {
    if (tBtn('停止') && tBtn('停止').disabled) return true;
    if (Date.now() - t0 > ms) return false;
    await refreshPanel(300);
  }
};
// 通知 toast：NotificationUtils 往 .ntr-notification-container 里塞，1.3s 后自动消失
// 注意：只能清空内容、不能移除容器节点 —— NotificationUtils 持有容器引用，
// 移除后新 toast 会塞进游离节点（页面上看不到），测试就永远等不到提示
const clearToasts = () => { document.querySelectorAll('.ntr-notification-container').forEach((c) => { c.textContent = ''; }); };
const toasts = () => Array.from(document.querySelectorAll('.ntr-notification-container')).map((c) => c.textContent).join(' | ');
const waitToast = async (re, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const t = toasts();
    if (re.test(t)) return t;
    if (Date.now() - t0 > ms) return t;
    await sleep(120);
  }
};
const mkJob = async (title, patch) => {
  const created = await Q.addJobs([{ kind: 'wenku', novelId: 'mock-src', title }], {
    ...Q.extractSettings(), sourceLanguage: 'JA', maxLines: 0, workerId: '',
    testModel: 'mock-glossary-1', testKey: 'x',
    testEndpoint: `${location.origin}?run=` + Date.now(),
  });
  const job = created[0];
  Object.assign(job, patch);
  await Q.put(job);
  return job;
};
const origConfirm = window.confirm;
let confirmQueue = [];
let confirmCalls = [];
window.confirm = (msg) => { confirmCalls.push(String(msg)); return confirmQueue.length ? confirmQueue.shift() : true; };
const origPath = window.location.pathname;
// inject 后 ~2.5s 的「自动续跑」会自己 runLoop()（默认开）——本套件有"只转待处理、不自动开跑"的断言，
// 它会在中途把任务真跑掉 → 内存里关掉（localStorage 不动；恢复放 finally，声明必须在 try 外）
const qMod = window._NTRToolBox.configuration.modules.find((m) => m.name === '术语队列');
let autoResumeSetting = null;
let origAutoResume;
if (qMod) {
  autoResumeSetting = qMod.settings.find((s) => s.name === '自动续跑');
  if (autoResumeSetting) { origAutoResume = autoResumeSetting.value; autoResumeSetting.value = false; }
}

try {
  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);
  await Q.openPanel();
  await sleep(400);

  // ---------- T1. 空队列：工具栏四个状态按钮全部禁用（点不动 > 点了没反应） ----------
  await waitStopDisabled();
  await refreshPanel();
  check('空队列 →「开始/续跑」禁用', tBtn('开始/续跑').disabled);
  check('空队列 →「停止」禁用', tBtn('停止').disabled);
  check('空队列 →「汇出备份」禁用', tBtn('汇出备份').disabled);
  check('空队列 →「清理已完成」禁用', tBtn('清理已完成').disabled);
  check('空队列 →「重试未完成」禁用', tBtn('重试未完成').disabled);
  check('禁用态 title 有解释（不是哑按钮）',
    /没有待处理/.test(tBtn('开始/续跑').title || '') && /没有任务在跑/.test(tBtn('停止').title || '')
    && /队列是空的/.test(tBtn('汇出备份').title || '') && /没有「完成」/.test(tBtn('清理已完成').title || '')
    && /没有需要重试/.test(tBtn('重试未完成').title || ''),
    [tBtn('开始/续跑').title, tBtn('停止').title, tBtn('汇出备份').title, tBtn('清理已完成').title, tBtn('重试未完成').title]);

  // ---------- F. 「加入当前页」的路径守卫（非小说页不再静默弹"选本地卷"） ----------
  history.pushState({}, '', '/not-a-novel-page');
  clearToasts(); confirmCalls = [];
  tBtn('加入当前页').click();
  const guardToast = await waitToast(/只在小说详情页/);
  history.pushState({}, '', origPath);
  check('非小说页点「加入当前页」→ 提示只在 /novel|/wenku 生效', /只在小说详情页/.test(guardToast), guardToast);
  check('非小说页点「加入当前页」不会入队', (await Q.list()).length === 0);
  check('非小说页点「加入当前页」不弹 confirm（没进到选择流程）', confirmCalls.length === 0, confirmCalls);

  // ---------- R. 工具栏「重试未完成」：一键把没跑完的转回待处理（不自动开跑，与「开始/续跑」解耦） ----------
  const jobR1 = await mkJob('用例R1-没跑完', {
    state: 'review',
    entries: [{ src: 'アリス', dst: '爱丽丝' }],
    resultCount: 1,
    progress: { round: 1, maxRounds: 3, chunksDone: 2, chunksFailed: 1, pendingLines: 20, totalLines: 37, covered: 17, uncovered: 20, totalChunks: 2, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  // 拖慢它：后面点「开始/续跑」时要能观察到 running 过渡态
  jobR1.options = { ...jobR1.options, testEndpoint: `${location.origin}?slow=1500&run=` + Date.now() };
  await Q.put(jobR1);
  const jobR2 = await mkJob('用例R2-已完成', {
    state: 'done',
    entries: [{ src: 'アリス', dst: '爱丽丝' }],
    resultCount: 1,
    progress: { round: 1, maxRounds: 3, chunksDone: 2, chunksFailed: 0, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 2, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  const jobR3 = await mkJob('用例R3-满覆盖待确认', {
    state: 'review',
    entries: [{ src: 'アリス', dst: '爱丽丝' }],
    resultCount: 1,
    progress: { round: 1, maxRounds: 3, chunksDone: 2, chunksFailed: 0, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 2, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  await refreshPanel(400);
  check('有没跑完的任务 →「重试未完成」可点', !tBtn('重试未完成').disabled, tBtn('重试未完成').title);
  check('title 只数没跑完的（1 个）', /1 个/.test(tBtn('重试未完成').title || ''), tBtn('重试未完成').title);
  confirmQueue = []; confirmCalls = []; clearToasts();
  tBtn('重试未完成').click();
  const toastR = await waitToast(/已把 1 个/);
  check('点一键重试 → 提示已转待处理（且不弹确认框）',
    /已把 1 个/.test(toastR) && /转回待处理/.test(toastR) && confirmCalls.length === 0, { toastR, confirms: confirmCalls.length });
  await sleep(1200);
  await refreshPanel(300);
  const r1a = await Q.get(jobR1.id);
  const r2 = await Q.get(jobR2.id);
  const r3 = await Q.get(jobR3.id);
  check('解耦：只转「待处理」，不自动开跑（「停止」仍禁用）',
    r1a.state === 'pending' && tBtn('停止').disabled, { state: r1a.state, stopDisabled: tBtn('停止').disabled });
  check('已完成（done）的不动', r2.state === 'done', r2.state);
  check('满覆盖的待确认不动', r3.state === 'review', r3.state);
  check('「开始/续跑」此时可点（有待处理任务）', !tBtn('开始/续跑').disabled, tBtn('开始/续跑').title);
  tBtn('开始/续跑').click();
  let r1Run = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const j = await Q.get(jobR1.id);
    if (j.state === 'running' || j.state === 'review') { r1Run = j.state; break; }
  }
  check('点「开始/续跑」才开跑', r1Run === 'running' || r1Run === 'review', r1Run);
  Q.stop();
  await waitStopDisabled();
  for (const id of [jobR1.id, jobR2.id, jobR3.id]) await Q.remove(id);
  await refreshPanel(300);

  // ---------- A. 曾失败但都救回来了（全覆盖）：文案 + 重跑按钮 ----------
  const jobA = await mkJob('用例A-曾有失败', {
    state: 'review',
    entries: [{ src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 12 }],
    resultCount: 1,
    progress: { round: 3, maxRounds: 3, chunksDone: 5, chunksFailed: 9, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 4, chunksBase: 1, timerBase: 1, roundStartedAt: Date.now() },
  });
  await refreshPanel(400);
  const textA = progText('用例A-曾有失败');
  check('进度不再写"5 完成 / 9 失败"这种累计块次误导数', !/完成 \/|完成\/|9 失败/.test(textA || ''), textA);
  check('进度写清"已跑几轮 / 本轮块数 / 行覆盖率"', /已跑 3\/3 轮/.test(textA) && /本轮 4\/4 块/.test(textA) && /已覆盖 37\/37 行/.test(textA), textA);
  check('累计失败单独标注为"曾有 N 块次失败"', /曾有 9 块次失败/.test(textA), textA);
  check('全覆盖时不给「重试」（没有未处理的正文行）', !rowBtn('用例A-曾有失败', '重试'));
  check('待确认的任务能开「预览」', !!rowBtn('用例A-曾有失败', '预览'), rowBtnLabels('用例A-曾有失败'));
  check('不是 running 的已完成任务 → 出现「重跑」按钮', !!rowBtn('用例A-曾有失败', '重跑'), rowBtnLabels('用例A-曾有失败'));
  check('有失败块时「重跑」是常规样式（不是置灰提示态）', ((rowBtn('用例A-曾有失败', '重跑') || {}).style || {}).opacity !== '0.65');

  // 点重跑：确认后只转「待处理」（与「开始/续跑」解耦），点「开始/续跑」才真的重跑
  confirmQueue = [true]; confirmCalls = []; clearToasts();
  rowBtn('用例A-曾有失败', '重跑').click();
  await sleep(400);
  check('有失败块时点「重跑」→ 先弹确认，写明失败块会重发',
    confirmCalls.length === 1 && /重跑《用例A-曾有失败》/.test(confirmCalls[0]) && /曾有 9 块次失败/.test(confirmCalls[0]), confirmCalls);
  const clickedA = await Q.get(jobA.id);
  check('解耦：确认后只转「待处理」（progress/entries 重置），不自动开跑',
    clickedA.state === 'pending' && !clickedA.progress && !clickedA.entries, { state: clickedA.state, progress: clickedA.progress });
  await refreshPanel(300);
  tBtn('开始/续跑').click();
  let aSeenRunning = false;
  let aDone = false;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const j = await Q.get(jobA.id);
    if (j.state === 'running') aSeenRunning = true;
    if (j.state === 'review') { aDone = true; break; }
  }
  const afterRerun = await Q.get(jobA.id);
  check('点「开始/续跑」后真的重新跑（重跑完成回到「待确认」）', aDone, { seenRunning: aSeenRunning, state: afterRerun.state, progress: afterRerun.progress });
  Q.stop();
  await waitStopDisabled();

  // ---------- B. 有未处理行（待 > 0）：给「重试」而不是「重跑」 ----------
  const jobB = await mkJob('用例B-还有待处理', {
    state: 'review',
    entries: [{ src: 'アリス', dst: '爱丽丝' }],
    resultCount: 1,
    progress: { round: 3, maxRounds: 3, chunksDone: 7, chunksFailed: 3, pendingLines: 59, totalLines: 200, covered: 141, uncovered: 59, totalChunks: 5, chunksBase: 3, timerBase: 3, roundStartedAt: Date.now() },
  });
  const textB = await waitRowText('用例B-还有待处理', /已覆盖 141\/200 行/);
  check('未覆盖行数按实际显示（200-141=59）', /已覆盖 141\/200 行 · 待 59/.test(textB || ''), textB);
  check('有未处理行时给「重试」', !!rowBtn('用例B-还有待处理', '重试'));
  check('「重试」按钮 title 写明只补没覆盖到的行', /只补没覆盖到的 59 行/.test((rowBtn('用例B-还有待处理', '重试') || {}).title || ''), (rowBtn('用例B-还有待处理', '重试') || {}).title);
  check('「review」还有未处理行时不再给「重跑」（避免两个按钮混淆）', !rowBtn('用例B-还有待处理', '重跑'));
  check('本轮块数扣掉轮内基数（7-3=4/5）', /本轮 4\/5 块/.test(textB || ''), textB);

  // ---------- B2. 「failed」状态（Failed to fetch 场景）：不能被挡住「重跑」 ----------
  // B2a: 取文/网络早期失败 —— 没跑过任何块、没有覆盖率数据（progress 只有 sync）
  const jobB2 = await mkJob('用例B2-取文失败', {
    state: 'failed',
    error: 'TypeError: Failed to fetch',
    progress: { sync: '取文中…' },
  });
  await refreshPanel(400);
  check('取文失败（无覆盖率数据）→ 有「重跑」', !!rowBtn('用例B2-取文失败', '重跑'), rowBtnLabels('用例B2-取文失败'));
  check('取文失败的「重跑」是常规样式（不是"全在缓存里"的置灰提示）',
    ((rowBtn('用例B2-取文失败', '重跑') || {}).style || {}).opacity !== '0.65');
  confirmQueue = [true]; confirmCalls = []; clearToasts();
  rowBtn('用例B2-取文失败', '重跑').click();
  await sleep(400);
  check('取文失败点「重跑」→ 弹确认且不写 undefined 块次失败',
    confirmCalls.length === 1 && /重跑《用例B2-取文失败》/.test(confirmCalls[0]) && !/undefined/.test(confirmCalls[0]), confirmCalls);
  const b2click = await Q.get(jobB2.id);
  check('解耦：确认后只转「待处理」，不自动开跑', b2click.state === 'pending' && !b2click.progress, { state: b2click.state, progress: b2click.progress });
  await refreshPanel(300);
  tBtn('开始/续跑').click();
  let b2SeenRunning = false;
  let b2Done = false;
  for (let i = 0; i < 35; i++) {
    await sleep(400);
    const j = await Q.get(jobB2.id);
    if (j.state === 'running') b2SeenRunning = true;
    if (j.state === 'review' || j.state === 'failed') { b2Done = j.state === 'review'; break; }
  }
  const afterB2 = await Q.get(jobB2.id);
  check('点「开始/续跑」后真的重新跑起来（跑到「待确认」）',
    b2Done, { seenRunning: b2SeenRunning, state: afterB2.state, progress: afterB2.progress && { totalLines: afterB2.progress.totalLines, round: afterB2.progress.round } });
  Q.stop();
  await waitStopDisabled();

  // B2b: 全部块请求都失败（failed + 还有未覆盖行）→ 「重试」「重跑」都要在，且重跑是真按钮
  const jobB2b = await mkJob('用例B2b-全失败', {
    state: 'failed',
    error: '37 行全部提取失败',
    entries: null,
    everFailed: true,
    progress: { round: 1, maxRounds: 3, chunksDone: 0, chunksFailed: 4, pendingLines: 37, totalLines: 37, covered: 0, uncovered: 37, totalChunks: 4, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  await refreshPanel(400);
  check('全失败（failed + 有未覆盖行）→ 有「重试」', !!rowBtn('用例B2b-全失败', '重试'));
  check('全失败 → 也有「重跑」（失败状态不被"还有未覆盖行"挡住）', !!rowBtn('用例B2b-全失败', '重跑'), rowBtnLabels('用例B2b-全失败'));
  check('全失败的「重跑」是常规样式（不是置灰）', ((rowBtn('用例B2b-全失败', '重跑') || {}).style || {}).opacity !== '0.65');
  await Q.remove(jobB2b.id);
  await refreshPanel(300);

  // B2c: 「失败但分块缓存齐全」（比如'没有提取到术语'）→ 也必须能真重跑：先清缓存、全部重新请求
  const jobB2c = await mkJob('用例B2c-缓存齐全但失败', {
    state: 'failed',
    error: '没有提取到术语',
    entries: null,
    progress: { round: 1, maxRounds: 3, chunksDone: 3, chunksFailed: 0, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 3, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  // 埋一个"旧分块缓存"（id 用引擎绝不会重写的形态，避免被重跑后的新缓存覆盖、干扰断言）
  const seedId = 'job:' + jobB2c.id + '/rX/legacy-seed';
  await D.GlossaryDB.put('chunks', { id: seedId, lines: ['アリス'], entries: [{ src: 'アリス', dst: '爱丽丝' }], at: Date.now() });
  await refreshPanel(400);
  const bB2c = rowBtn('用例B2c-缓存齐全但失败', '重跑');
  check('失败但缓存齐全（零失败块）→ 仍有「重跑」', !!bB2c, rowBtnLabels('用例B2c-缓存齐全但失败'));
  check('失败但缓存齐全 → 「重跑」不置灰（失败的任务必须点得动）', !!bB2c && ((bB2c.style || {}).opacity !== '0.65'), { opacity: bB2c && bB2c.style.opacity });
  confirmQueue = [true]; confirmCalls = []; clearToasts();
  if (bB2c) bB2c.click();
  await sleep(400);
  check('点「重跑」→ 确认写明会清掉分块缓存、全部重新请求（而不是"不会发请求"）',
    confirmCalls.length === 1 && /清掉它的分块缓存/.test(confirmCalls[0]) && !/不会发任何请求/.test(confirmCalls[0]), confirmCalls);
  const seedRecs = (await D.GlossaryDB.getAll('chunks')).filter((c) => String(c.id) === seedId);
  check('点「重跑」→ 该任务的旧分块缓存被清掉（不原样回放）', seedRecs.length === 0, { seedId, left: seedRecs.length });
  const b2cClick = await Q.get(jobB2c.id);
  check('解耦：确认后只转「待处理」，不自动开跑', b2cClick.state === 'pending' && !b2cClick.progress, { state: b2cClick.state, progress: b2cClick.progress });
  await refreshPanel(300);
  tBtn('开始/续跑').click();
  let b2cStarted = false;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const j = await Q.get(jobB2c.id);
    if (j.state === 'running' || j.state === 'review') { b2cStarted = true; break; }
  }
  const afterB2c = await Q.get(jobB2c.id);
  check('点「开始/续跑」后任务真的重新跑起来（不是空跑）', b2cStarted, { state: afterB2c.state, progress: afterB2c.progress && { round: afterB2c.progress.round, totalLines: afterB2c.progress.totalLines } });
  Q.stop();
  await waitStopDisabled();

  // ---------- C. 干净完成 / 老任务（没有覆盖率字段） ----------
  const jobC = await mkJob('用例C-干净完成', {
    state: 'review',
    entries: [{ src: 'アリス', dst: '爱丽丝' }],
    resultCount: 1,
    progress: { round: 1, maxRounds: 3, chunksDone: 3, chunksFailed: 0, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 3, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  const jobC2 = await mkJob('用例C2-老进度', {
    state: 'review',
    entries: [{ src: 'アリス', dst: '爱丽丝' }],
    resultCount: 1,
    progress: { round: 1, maxRounds: 3, chunksDone: 3, chunksFailed: 0, pendingLines: 0, totalLines: 37, totalChunks: 3, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  const textC = await waitRowText('用例C-干净完成', /已覆盖 37\/37 行/);
  check('干净完成：无误导性失败字样', !/失败/.test(textC || '') && /已覆盖 37\/37 行/.test(textC || ''), textC);
  check('干净完成不给「重试」', !rowBtn('用例C-干净完成', '重试'));
  const bC = rowBtn('用例C-干净完成', '重跑');
  check('干净完成：「重跑」还在但点了没用 → 置灰显示', !!bC && ((bC.style || {}).opacity === '0.65'), { labels: rowBtnLabels('用例C-干净完成'), opacity: bC && bC.style.opacity });
  check('置灰「重跑」的 title 写明不会发请求', /不会发任何请求/.test((bC || {}).title || ''), (bC || {}).title);
  confirmQueue = []; confirmCalls = []; clearToasts();
  if (bC) bC.click();
  const warnC = await waitToast(/不会发任何请求/);
  const dbC = await Q.get(jobC.id);
  check('点置灰「重跑」→ 只弹提示、不弹确认、任务不动（没有空跑）',
    /不会发任何请求/.test(warnC) && confirmCalls.length === 0 && dbC.state === 'review' && (dbC.entries || []).length === 1,
    { warnC, confirms: confirmCalls.length, state: dbC.state, entries: (dbC.entries || []).length });
  const textC2 = await waitRowText('用例C2-老进度', /待 0 行/);
  const dbC2 = await Q.get(jobC2.id);
  check('没有覆盖率字段的老任务回落到"待 N 行"', /待 0 行/.test(textC2 || '') && !/已覆盖/.test(textC2 || ''), { textC2, state: dbC2 && dbC2.state, progress: dbC2 && dbC2.progress && { round: dbC2.progress.round, pendingLines: dbC2.progress.pendingLines } });

  // ---------- D. 停止 → 续跑：没轮到的行不会显示成 0（引擎侧已单测，这里走真实队列） ----------
  const jobD = await mkJob('用例D-中途停止', {});
  await Q.put(await Q.get(jobD.id));
  const jobD2 = await Q.get(jobD.id);
  jobD2.options = { ...jobD2.options, budgetChars: 200, maxRounds: 1, concurrency: 1, testEndpoint: `${location.origin}?slow=2500&run=` + Date.now() };
  await Q.put(jobD2);
  Q.runLoop();
  await sleep(1500);
  const textRun = progText('用例D-中途停止');
  check('运行中也显示行覆盖率', /已覆盖 \d+\/37 行/.test(textRun || ''), textRun);
  check('跑动中：「开始/续跑」禁用（避免重复启动）、「停止」可点',
    tBtn('开始/续跑').disabled && !tBtn('停止').disabled, { run: tBtn('开始/续跑').disabled, stop: tBtn('停止').disabled });
  Q.stop();
  for (let i = 0; i < 20; i++) { await sleep(400); const j = await Q.get(jobD.id); if (j.state !== 'running') break; }
  const afterD = await Q.get(jobD.id);
  check('停止后状态回到「待处理」并给出重试', afterD.state === 'pending' && /已停止/.test(afterD.error || ''), { state: afterD.state, error: afterD.error });
  check('停止后给出「还剩 N 行没跑」而不是含糊的"已提取的分块已缓存"', /还剩 \d+ 行没跑/.test(afterD.error || ''), afterD.error);
  check('停止后「待处理行数」不为 0（没轮到的块也算）', (afterD.progress || {}).pendingLines > 0, afterD.progress);
  check('停止后覆盖率账目自洽（covered + uncovered = 总行数）',
    (afterD.progress.covered || 0) + (afterD.progress.uncovered || 0) === afterD.progress.totalLines,
    { covered: afterD.progress.covered, uncovered: afterD.progress.uncovered, totalLines: afterD.progress.totalLines });
  await sleep(1200);
  check('停止的任务行有「重试」按钮', !!rowBtn('用例D-中途停止', '重试'));
  const stoppedIdle = await waitStopDisabled();
  check('停止后：工具栏「停止」禁用、「开始/续跑」看有没有待处理任务',
    stoppedIdle && tBtn('停止').disabled, { stoppedIdle, stopDisabled: tBtn('停止').disabled });

  // ---------- E. 刚入队、一行都没跑的新鲜任务：不该顶着「重试 / 重跑 / 预览」 ----------
  await mkJob('用例E-刚入队', {});
  const jobsE = await Q.list();
  await refreshPanel(400);
  check('刚入队(pending 无 progress)不给「重试」', !rowBtn('用例E-刚入队', '重试'), rowBtnLabels('用例E-刚入队'));
  check('刚入队也不给「重跑」（还没跑过）', !rowBtn('用例E-刚入队', '重跑'), rowBtnLabels('用例E-刚入队'));
  check('刚入队没有条目 → 不给「预览」', !rowBtn('用例E-刚入队', '预览'), rowBtnLabels('用例E-刚入队'));
  const anyPendingE = jobsE.some((j) => j.state === 'pending');
  check('「开始/续跑」禁用与否 == 是否真的没有待处理任务', tBtn('开始/续跑').disabled === !anyPendingE,
    { disabled: tBtn('开始/续跑').disabled, anyPending: anyPendingE });
  const anyDoneE = jobsE.some((j) => j.state === 'done');
  check('「清理已完成」禁用与否 == 是否真的没有完成任务', tBtn('清理已完成').disabled === !anyDoneE,
    { disabled: tBtn('清理已完成').disabled, anyDone: anyDoneE });

  // ---------- E2. 「完成」的任务：预览可用 / 清理已完成可点 / 重跑置灰 ----------
  await mkJob('用例E2-已完成', {
    state: 'done',
    entries: [{ src: 'アリス', dst: '爱丽丝' }],
    resultCount: 1,
    progress: { round: 1, maxRounds: 3, chunksDone: 3, chunksFailed: 0, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 3, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  await waitRowText('用例E2-已完成', /已覆盖 37\/37 行/);
  await refreshPanel(300);
  check('「完成」的任务也能开「预览」（看/再筛）', !!rowBtn('用例E2-已完成', '预览'), rowBtnLabels('用例E2-已完成'));
  check('完成且无失败 → 「重跑」是置灰提示态', ((rowBtn('用例E2-已完成', '重跑') || {}).style || {}).opacity === '0.65', rowBtnLabels('用例E2-已完成'));
  check('有 done 任务后 →「清理已完成」可点', !tBtn('清理已完成').disabled, tBtn('清理已完成').title);
  check('有任务时「汇出备份」可点', !tBtn('汇出备份').disabled);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  window.confirm = origConfirm;
  try { if (window.location.pathname !== origPath) history.replaceState({}, '', origPath); } catch (e) { }
  if (autoResumeSetting) autoResumeSetting.value = origAutoResume;   // 还原「自动续跑」
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  for (const j of await Q.list()) await Q.remove(j.id);
  const p = document.getElementById('ntr-queue-overlay');
  if (p) p.remove();
  clearToasts();
  out.notes.push('cleanup: 队列已清空、面板已关、confirm/URL 已还原、toast 已清、「自动续跑」已还原');
}
return JSON.stringify(out, null, 1);
