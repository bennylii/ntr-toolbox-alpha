// 队列面板"运行翻译器 ▾"：覆盖 pending 任务 / 不动已开跑 + 入队时跟随
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-queue-translator.js
// 依赖：mock 在 8788；测试 profile 下工作区没有真实 worker，但 extractSettingsWithRuntime 用的是「AI提取术语表」设置里的 workerId（默认 ''=全部轮换），写入时改 fake-* 字符串可绕过 resolveWorkers（executeJob 真的跑时才需要 worker 存在；本套件只验证入队与 popover 行为）
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;

const panelEl = () => document.getElementById('ntr-queue-overlay');
const rowByTitle = (title) => {
  const p = panelEl();
  return p ? Array.from(p.querySelectorAll('tbody tr')).find((r) => r.textContent.includes(title)) : null;
};
const tBtn = (label) => {
  const p = panelEl();
  return p && Array.from(p.querySelectorAll('.ntr-g-toolbar button')).find((b) => b.textContent.startsWith(label));
};
const refreshPanel = async (ms = 500) => { const b = tBtn('重新整理'); if (b) b.click(); await sleep(ms); };
const popoverSelect = () => document.querySelector('.ntr-g-popover select');

const mkJob = async (title, patch = {}) => {
  // 注意：队列的入队要带运行时覆盖（这里测的就是这个覆盖是否真的进 job.options）
  // 所以用 extractSettingsWithRuntime()，并且**不要**再额外写 workerId 字段把覆盖盖掉
  const created = await Q.addJobs([{ kind: 'wenku', novelId: 'mock-src', title }], {
    ...Q.extractSettingsWithRuntime(), sourceLanguage: 'JA', maxLines: 0,
    testModel: 'mock-glossary-1', testKey: 'x',
    testEndpoint: 'http://127.0.0.1:8788?run=' + Date.now(),
  });
  const job = created[0];
  Object.assign(job, patch);
  await Q.put(job);
  return job;
};

let autoResumeSetting = null;   // 注意：要声明在 try 外，finally 里才看得到
let origAutoResume;

try {
  // 清状态
  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);
  localStorage.removeItem('ntr-queue-runtime');
  // ⚠️ 关掉「自动续跑」：GlossaryQueue.init() 在注入后 ~2.5s 会自己触发一次 runLoop，
  // 那时用例刚建的 pending 任务会被真跑掉（跑完变 review + 全覆盖 → isJobOverridable=false）
  // → "跟随清除 workerId" / "pending 对齐" 这类断言必挂。用例期间临时改内存里的模块设置，末尾还原。
  const qMod = window._NTRToolBox.configuration.modules.find((m) => m.name === '术语队列');
  autoResumeSetting = qMod && qMod.settings.find((s) => s.name === '自动续跑');
  origAutoResume = autoResumeSetting && autoResumeSetting.value;
  if (autoResumeSetting) autoResumeSetting.value = false;
  // init() 的定时器（注入后 ~2.5s）还会把 state:'running' 的任务归一成 pending —— 本套件会多次把任务
  // 摆成 running 来测覆盖，正好撞上就会把刚写入的状态盖掉（假失败）→ 先等定时器烧完再往下走
  await sleep(2800);

  // ---------- A. 初始状态：默认跟随 ----------
  check('默认 ntr-queue-runtime 为空（跟随）', Q.readQueueRuntime().workerId === '');
  check('默认 extractSettingsWithRuntime == base（workerId 字段不动）',
    Q.extractSettingsWithRuntime().workerId === Q.extractSettings().workerId);

  // 打开面板
  await Q.openPanel();
  await sleep(400);
  await refreshPanel();
  check('工具栏出现「运行翻译器 ▾」按钮', !!tBtn('运行翻译器'));
  check('默认状态：按钮文案不含「：」（表示没选具体 worker）', !/运行翻译器：/.test(tBtn('运行翻译器').textContent), tBtn('运行翻译器').textContent);
  check('默认状态：按钮 title 写明跟随', /跟随「AI提取术语表」/.test(tBtn('运行翻译器').title), tBtn('运行翻译器').title);

  // ---------- B. 点开 popover：选项含「跟随 [AI 提取术语表 当前：xxx]」 ----------
  tBtn('运行翻译器').click();
  await sleep(200);
  check('点击后弹出 popover，里面至少 1 个选项（跟随项；测试 profile 没有真实 worker）',
    popoverSelect() && popoverSelect().options.length >= 1,
    popoverSelect() && Array.from(popoverSelect().options).map(o => ({ v: o.value, t: o.textContent })));
  const followOpt = popoverSelect().options[0];
  check('第一项是「跟随 [AI提取术语表 当前：xxx]」', /^跟随 \[/.test(followOpt.textContent), followOpt.textContent);
  check('第一项 value 为空字符串（跟随 = 不覆盖）', followOpt.value === '');

  // ---------- C. 选一个 fake-worker-A：写入 localStorage + 关闭 popover + 按钮文案变化 ----------
  const fakeSelect = document.createElement('select');
  // 直接调用写运行时（绕开 popover 的 worker 选项 —— 测试 profile 没真实 worker，只能用 fake-* 字符串）
  await Q.writeQueueRuntime({ workerId: 'fake-worker-A' });
  await sleep(200);
  check('写入后 readQueueRuntime 返回新值', Q.readQueueRuntime().workerId === 'fake-worker-A');
  check('写入后 extractSettingsWithRuntime 返回带覆盖的设置',
    Q.extractSettingsWithRuntime().workerId === 'fake-worker-A');
  await refreshPanel();
  check('写入后面板按钮文案含「运行翻译器：fake-worker-A」', /运行翻译器：fake-worker-A/.test(tBtn('运行翻译器').textContent), tBtn('运行翻译器').textContent);
  check('按钮 title 含「当前覆盖：fake-worker-A」+ 写明未跑完的对齐、写入完成的不动',
    /当前覆盖：fake-worker-A/.test(tBtn('运行翻译器').title) && /未跑完/.test(tBtn('运行翻译器').title) && /写入完成.*不动/.test(tBtn('运行翻译器').title),
    tBtn('运行翻译器').title);

  // ---------- D. 入队两条 pending：options.workerId 用覆盖值 ----------
  const jobA = await mkJob('trans-A');
  const jobB = await mkJob('trans-B');
  check('新入队的任务 options.workerId == 队列面板覆盖值',
    jobA.options.workerId === 'fake-worker-A' && jobB.options.workerId === 'fake-worker-A',
    { a: jobA.options.workerId, b: jobB.options.workerId });

  // ---------- E. 切换覆盖：所有 pending 任务应被重写 ----------
  await Q.writeQueueRuntime({ workerId: 'fake-worker-B' });
  await sleep(200);
  const list1 = await Q.list();
  const aligned = list1.filter((j) => j.state === 'pending').every((j) => j.options.workerId === 'fake-worker-B');
  check('切到 fake-worker-B 后所有 pending 任务都被重写',
    aligned && list1.length >= 2, list1.map((j) => ({ t: j.title, wid: j.options.workerId, st: j.state })));

  // ---------- F. running 但还没覆盖完（covered < totalLines）：再切覆盖，要被改 ----------
  // 模拟"跑了 30%，剩下 70% 还没跑"，覆盖应该生效
  const jobR = list1.find((j) => j.title === 'trans-A');
  jobR.state = 'running';
  jobR.progress = { round: 1, maxRounds: 3, chunksDone: 1, chunksFailed: 0, pendingLines: 25, totalLines: 37, covered: 12, uncovered: 25, totalChunks: 4, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() };
  await Q.put(jobR);
  await Q.writeQueueRuntime({ workerId: 'fake-worker-C' });
  await sleep(200);
  const after = await Q.list();
  const transA = after.find((j) => j.title === 'trans-A');
  const transB = after.find((j) => j.title === 'trans-B');
  check('running 中但未覆盖完（covered<totalLines）的任务 options.workerId 被覆盖',
    transA.options.workerId === 'fake-worker-C', { wid: transA.options.workerId, state: transA.state, covered: transA.progress && transA.progress.covered, total: transA.progress && transA.progress.totalLines });
  check('pending 的任务被覆盖到 fake-worker-C',
    transB.options.workerId === 'fake-worker-C', { wid: transB.options.workerId, state: transB.state });

  // ---------- F2. 已覆盖完成（covered === totalLines）：再切覆盖，保留原值 ----------
  // 模拟"已跑完缓存全部到位"，再切 worker 也不会发请求，保留原值
  transA.state = 'review';
  transA.progress = { round: 3, maxRounds: 3, chunksDone: 4, chunksFailed: 0, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 4, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() };
  transA.entries = [{ src: 'アリス', dst: '爱丽丝' }];
  transA.resultCount = 1;
  await Q.put(transA);
  await Q.writeQueueRuntime({ workerId: 'fake-worker-D' });
  await sleep(200);
  const afterF2 = await Q.list();
  const transA2 = afterF2.find((j) => j.title === 'trans-A');
  const transB2 = afterF2.find((j) => j.title === 'trans-B');
  check('已覆盖完成（covered===totalLines）的 review 任务不动（仍是 fake-worker-C）',
    transA2.options.workerId === 'fake-worker-C', { wid: transA2.options.workerId, state: transA2.state, covered: transA2.progress.covered, total: transA2.progress.totalLines });
  check('仍在 pending（也是未覆盖完）的任务继续被覆盖到 fake-worker-D',
    transB2.options.workerId === 'fake-worker-D', { wid: transB2.options.workerId, state: transB2.state });

  // ---------- G. 写回 ''（跟随）：未跑完任务的 workerId 字段应被清除 ----------
  await Q.writeQueueRuntime({ workerId: '' });
  await sleep(200);
  const reset = await Q.list();
  const transB3 = reset.find((j) => j.title === 'trans-B');
  const transA3 = reset.find((j) => j.title === 'trans-A');
  check('跟随后未跑完（pending）任务的 options.workerId 字段被清除', !('workerId' in transB3.options),
    { wid: transB3.options.workerId, has: 'workerId' in transB3.options, state: transB3.state, runtime: Q.readQueueRuntime(), live: Q.extractSettings().workerId, allJobs: reset.map((j) => ({ t: j.title, s: j.state, wid: j.options.workerId })) });
  check('跟随后已覆盖完成的任务 options.workerId 不动（仍是 fake-worker-C）',
    transA3.options.workerId === 'fake-worker-C');
  await refreshPanel();
  check('面板按钮文案恢复为「运行翻译器 ▾」（不再带 worker 名）',
    tBtn('运行翻译器').textContent === '运行翻译器 ▾', tBtn('运行翻译器').textContent);

  // ---------- H. executeJob 兜底：未跑完的任务被覆盖（包含 running 状态） ----------
  // 把 trans-B 改回 pending，把 trans-A 改回 running（已覆盖完），覆盖一个 trans-D
  transB3.state = 'pending';
  await Q.put(transB3);
  // trans-A3（review 已覆盖完）不动
  await Q.writeQueueRuntime({ workerId: 'fake-worker-E' });
  // 此时 trans-B 应被覆盖到 E，trans-A 应不动
  const afterH = await Q.list();
  const transA4 = afterH.find((j) => j.title === 'trans-A');
  const transB4 = afterH.find((j) => j.title === 'trans-B');
  check('writeQueueRuntime(E) 后 pending(trans-B) 被覆盖到 E',
    transB4.options.workerId === 'fake-worker-E');
  check('writeQueueRuntime(E) 后已覆盖完（review 100%）的 trans-A 不动（仍是 fake-worker-C）',
    transA4.options.workerId === 'fake-worker-C');
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  for (const j of await Q.list()) await Q.remove(j.id);
  localStorage.removeItem('ntr-queue-runtime');
  if (typeof autoResumeSetting !== 'undefined' && autoResumeSetting) autoResumeSetting.value = origAutoResume;
  const p = document.getElementById('ntr-queue-overlay');
  if (p) p.remove();
  document.querySelectorAll('.ntr-g-popover').forEach((el) => el.remove());
  out.notes.push('cleanup: 队列清空、面板关闭、localStorage 复位、popover 清理、自动续跑已还原');
}
return JSON.stringify(out, null, 1);