// 队列「重试」= 只补没覆盖到的正文行（不再整本重发）；「重跑」= 整本重来但成功的块走缓存
// 注意：两者都只转「待处理」（与启动/暂停解耦）——套件里点完按钮后显式 Q.runLoop()
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-queue-fill-gaps.js
// 依赖：mock 在 8788（会把「AI提取术语表」的并发临时设成 1，跑完还原）
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra: extra === undefined ? null : extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const GE = D.GlossaryEngine;
const Q = D.GlossaryQueue;
const TB = window._NTRToolBox;
const stats = () => fetch('http://127.0.0.1:8788/__stats').then((r) => r.json());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const mod = TB.configuration.modules.find((m) => m.name === 'AI提取术语表');
const origSettings = {};
const pushed = [];
const setVal = (name, value) => {
  const s = mod.settings.find((x) => x.name === name);
  if (!s) { mod.settings.push({ name, value }); pushed.push(name); return; }
  if (!(name in origSettings)) origSettings[name] = s.value;
  s.value = value;
};

const rowByTitle = (title) => {
  const panel = document.getElementById('ntr-queue-overlay');
  if (!panel) return null;
  return Array.from(panel.querySelectorAll('tbody tr')).find((r) => r.textContent.includes(title)) || null;
};
const rowBtn = (title, label) => {
  const tr = rowByTitle(title);
  return tr && Array.from(tr.querySelectorAll('button')).find((b) => b.textContent === label);
};
const progText = (title) => { const tr = rowByTitle(title); return tr ? tr.children[2].textContent : null; };
// 点完按钮/开跑之后：IDB 里可能还是上一次的状态快照，所以等"队列循环停了 + 没有在跑的任务"再读
const waitSettled = async (job, ms = 120000) => {
  const t0 = Date.now();
  await sleep(400);
  for (;;) {
    const st = Q._state();
    const j = await Q.get(job.id);
    if (!st.loopActive && !st.runningJobId && j && j.state !== 'pending' && j.state !== 'running') {
      out.notes.push(`waitSettled(${job.id}) 用了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return j;
    }
    if (Date.now() - t0 > ms) { out.notes.push(`waitSettled(${job.id}) 超时`); return j; }
    await sleep(300);
  }
};

const origConfirm = window.confirm;
window.confirm = () => true;
let realRunJob = null;
// inject 后 ~2.5s 的「自动续跑」会自己 runLoop()（默认开）→ 会干扰本套件显式开跑的节奏；
// 内存里关掉（localStorage 不动；恢复放 finally，声明必须在 try 外）
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

  // 并发=1：请求顺序 == 块顺序，才能断言「只有失败过的块被重发」
  setVal('使用临时端点', true);
  setVal('临时端点', 'http://127.0.0.1:8788');
  setVal('临时模型', 'mock-glossary-1');
  setVal('临时Key', 'x');
  setVal('原文语言', 'JA');
  setVal('分块字数', 200);
  setVal('最大轮数', 1);
  setVal('行数上限', 0);
  setVal('输出上限', 0);
  setVal('并发', 1);
  setVal('RPM', 0);
  setVal('逾时(秒)', 60);

  // 正文 = 队列要跑的那份（mock 文库 37 行），预期分块在测试里现算
  const src = await D.loadGlossarySourceText({ kind: 'wenku', novelId: 'mock-src' });
  const allLines = GE.splitLines(src.text).filter((l) => GE.languageFilter(l, 'JA') && !GE.ruleFilter(l));
  const chunks = GE.makeChunks(allLines, 200);
  if (chunks.length < 4) throw new Error('mock 正文分块数太少，用例前提不成立：' + chunks.length);
  const failIdx = new Set([1, 3]);
  // 失败注入用 empty（200 + 空内容）：引擎按失败处理，且不会触发 429 那种 30s 上游冷却（否则用例要跑几分钟）
  const script = chunks.map((c, i) => (failIdx.has(i) ? 'empty' : 'ok')).join(',') + ',ok,ok,ok,ok,ok,ok,ok';
  const successLines = chunks.filter((c, i) => !failIdx.has(i)).flatMap((c) => c.lines);
  // 期望的「待补行」：用多重集差集算（mock 正文里 第1..12 行出现两次，重复行按次数扣，
  // 所以顺序/内容跟"失败块的行"不是逐位对应 —— 这里独立实现一遍，不直接调引擎的函数）
  const expectedPending = (() => {
    const pool = new Map();
    successLines.forEach((l) => pool.set(l, (pool.get(l) || 0) + 1));
    return allLines.filter((l) => {
      const n = pool.get(l) || 0;
      if (n > 0) { pool.set(l, n - 1); return false; }
      return true;
    });
  })();
  const expectSet = new Set(expectedPending);
  const closedOnly = [...new Set(successLines)].filter((l) => !expectSet.has(l));   // 只被成功块覆盖过的内容
  const endpoint = `http://127.0.0.1:8788?script=${script}&run=${Date.now()}`;
  const aliceLines = new Set(allLines.filter((l) => l.includes('アリス'))).size;   // 全文里含该词的不同行数（count 的语义）
  const fillChunks = GE.makeChunks(expectedPending, 200);
  out.notes.push(`正文 ${allLines.length} 行 → ${chunks.length} 块（${chunks.map((c) => c.lines.length).join('/')}），让第 ${[...failIdx].join('/')} 块失败 ⇒ 待补 ${expectedPending.length} 行 → ${fillChunks.length} 块`);

  const created = await Q.addJobs([{ kind: 'wenku', novelId: 'mock-src', title: '补跑用例' }], {
    ...Q.extractSettings(), sourceLanguage: 'JA', maxLines: 0, workerId: '', timeoutMs: 60000,
    testEndpoint: endpoint, testModel: 'mock-glossary-1', testKey: 'x',
  });
  const job = created[0];
  await Q.openPanel();
  await sleep(300);

  // ---------- 第一轮：两个块失败 ----------
  const before1 = (await stats()).requests;
  Q.runLoop();
  const j1 = await waitSettled(job);
  const after1 = (await stats()).requests;
  check('第一轮按脚本失败 2 块', (j1.progress || {}).chunksFailed === 2, j1.progress && { chunksFailed: j1.progress.chunksFailed, round: j1.progress.round });
  check('第一轮请求数 == 块数（没有缓存可分）', after1 - before1 === chunks.length, { delta: after1 - before1, chunks: chunks.length });
  check('覆盖账目：已覆盖 = 总行数 - 失败块行数',
    j1.progress.covered === allLines.length - expectedPending.length && j1.progress.uncovered === expectedPending.length,
    { covered: j1.progress.covered, uncovered: j1.progress.uncovered, expectPending: expectedPending.length });
  check('备注写"N 行未能提取"（不是"全部失败"）', new RegExp(expectedPending.length + ' 行未能提取').test(j1.error || ''), j1.error);
  const alice1 = (j1.entries || []).find((e) => e.src === 'アリス');
  check('条目次数按全文重算（含没跑到的行，25 = 全文里含该词的不同行数）', alice1 && alice1.count === aliceLines, alice1 && { src: alice1.src, count: alice1.count, expect: aliceLines });
  check('面板显示行覆盖率', /已覆盖 \d+\/37 行/.test(progText('补跑用例') || ''), progText('补跑用例'));
  check('有未处理行 → 行上给「重试」、不给「重跑」', !!rowBtn('补跑用例', '重试') && !rowBtn('补跑用例', '重跑'));
  const recs1 = (await D.GlossaryDB.getAll('chunks')).filter((c) => String(c.id).startsWith('job:' + job.id));
  check('分块缓存只落了成功块的记录', recs1.length === chunks.length - failIdx.size, recs1.map((c) => c.id));

  // ---------- 点「重试」：只补没覆盖到的行 ----------
  const captured = [];
  realRunJob = GE.runJob;
  GE.runJob = (args) => { captured.push(args.lines.slice()); return realRunJob(args); };
  const before2 = (await stats()).requests;
  rowBtn('补跑用例', '重试').click();
  // 「重试」只转「待处理」（与启动/暂停解耦）→ 测试里显式开跑
  for (let i = 0; i < 10; i++) { await sleep(150); if ((await Q.get(job.id)).state === 'pending') break; }
  Q.runLoop();
  const j2 = await waitSettled(job);
  const after2 = (await stats()).requests;
  GE.runJob = realRunJob;
  realRunJob = null;

  const capturedFlat = captured.flat();
  check('补跑发出去的行 == 没覆盖到的那些行（顺序一致）', same(capturedFlat, expectedPending), { got: capturedFlat.length, want: expectedPending.length, head: capturedFlat.slice(0, 2) });
  check('补跑不会重发只被成功块覆盖过的内容', !capturedFlat.some((l) => closedOnly.includes(l)), { closedOnly: closedOnly.length, sample: closedOnly.slice(0, 2) });
  const fillRecs = (await D.GlossaryDB.getAll('chunks')).filter((c) => String(c.id).startsWith('job:' + job.id + '/fill/'));
  check('补跑按预算重新切块（不是照搬原来的块）',
    same(fillRecs.map((c) => c.lines.length), GE.makeChunks(expectedPending, 200).map((c) => c.lines.length)),
    { got: fillRecs.map((c) => c.lines.length), want: GE.makeChunks(expectedPending, 200).map((c) => c.lines.length) });
  check('补跑请求数 == 补跑的块数（没有整本重发）', after2 - before2 === fillRecs.length && after2 - before2 < chunks.length, { delta: after2 - before2, fillChunks: fillRecs.length });
  check('补跑后全覆盖、无备注', j2.progress.covered === allLines.length && j2.progress.uncovered === 0 && !j2.error, { covered: j2.progress.covered, error: j2.error });
  const alice2 = (j2.entries || []).find((e) => e.src === 'アリス');
  check('合并后条目不重复、次数保持全文口径', (j2.entries || []).filter((e) => e.src === 'アリス').length === 1 && alice2.count === aliceLines, alice2 && { src: alice2.src, count: alice2.count, expect: aliceLines });
  check('补跑不丢已有结果', (j2.entries || []).length === (j1.entries || []).length, { before: (j1.entries || []).length, after: (j2.entries || []).length });
  const recs2 = (await D.GlossaryDB.getAll('chunks')).filter((c) => String(c.id).startsWith('job:' + job.id));
  check('补跑写 /fill 子命名空间：不覆盖整本那轮的缓存',
    recs2.filter((c) => String(c.id).includes('/fill/')).length === fillRecs.length && recs2.filter((c) => !String(c.id).includes('/fill/')).length === recs1.length,
    recs2.map((c) => c.id));
  await sleep(1600);
  check('全覆盖后行上给「重跑」而不是「重试」', !!rowBtn('补跑用例', '重跑') && !rowBtn('补跑用例', '重试'));
  // 回归锁：补跑把覆盖修满 ≠ 整本缓存补满（那 2 块在 /fill 里，整本命名空间仍有窟窿）
  // → 此刻的「重跑」必须是真按钮，不能是"不会发请求"的置灰提示
  check('补跑修满后「重跑」仍是真按钮（整本缓存还有窟窿，重跑有活干）',
    ((rowBtn('补跑用例', '重跑') || {}).style || {}).opacity !== '0.65',
    { opacity: (rowBtn('补跑用例', '重跑') || {}).style && rowBtn('补跑用例', '重跑').style.opacity });
  check('全覆盖后进度写"已覆盖 37/37 行"', /已覆盖 37\/37 行/.test(progText('补跑用例') || ''), progText('补跑用例'));

  // ---------- 点「重跑」：整本重来，成功的块走缓存 ----------
  const before3 = (await stats()).requests;
  rowBtn('补跑用例', '重跑').click();
  // 「重跑」同样只转「待处理」→ 显式开跑
  for (let i = 0; i < 10; i++) { await sleep(150); if ((await Q.get(job.id)).state === 'pending') break; }
  Q.runLoop();
  const j3 = await waitSettled(job);
  const after3 = (await stats()).requests;
  check('重跑只补"整本那轮从没成功过的块"，其余走缓存', after3 - before3 === failIdx.size, { delta: after3 - before3, expect: failIdx.size });
  const alice3 = (j3.entries || []).find((e) => e.src === 'アリス');
  check('重跑后结果整批重算且覆盖完整', j3.progress.covered === allLines.length && !!alice3 && alice3.count === aliceLines, { covered: j3.progress.covered, count: alice3 && alice3.count, expect: aliceLines });
  // 这轮重跑自己零失败 → 整本缓存已补满 →「重跑」该退回置灰提示（再点不会发请求）
  await sleep(1600);
  check('零失败的整本重跑之后：「重跑」转为置灰提示态（点了不会空跑）',
    ((rowBtn('补跑用例', '重跑') || {}).style || {}).opacity === '0.65',
    { opacity: (rowBtn('补跑用例', '重跑') || {}).style && rowBtn('补跑用例', '重跑').style.opacity, everFailed: (await Q.get(job.id)).everFailed });
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  window.confirm = origConfirm;
  if (autoResumeSetting) autoResumeSetting.value = origAutoResume;   // 还原「自动续跑」
  if (realRunJob) GE.runJob = realRunJob;
  for (const [name, value] of Object.entries(origSettings)) {
    const s = mod.settings.find((x) => x.name === name);
    if (s) s.value = value;
  }
  for (const name of pushed) {
    const i = mod.settings.findIndex((x) => x.name === name);
    if (i >= 0) mod.settings.splice(i, 1);
  }
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  for (const j of await Q.list()) await Q.remove(j.id);
  const p = document.getElementById('ntr-queue-overlay');
  if (p) p.remove();
  out.notes.push('cleanup: 队列清空、面板关闭、confirm 还原、设置还原');
}
return JSON.stringify(out, null, 1);
