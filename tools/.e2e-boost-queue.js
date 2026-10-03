// 增强管线在队列里跑通：多轮种子账本（持久化）+ 证据核实（剔除条目不自动写入）
// 跑法：node tools/cdp.mjs open http://127.0.0.1:8788/wenku/mock-boost && node tools/cdp.mjs inject && node tools/cdp.mjs evalf tools/.e2e-boost-queue.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const setSetting = (mod, name, value) => { const s = mod.settings.find((x) => x.name === name); if (s) s.value = value; return s; };
const getSetting = (mod, name) => { const s = mod.settings.find((x) => x.name === name); return s && s.value; };

const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;
const orig = {};

try {
  const mod = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === 'AI提取术语表');
  const queueMod = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === '术语队列');
  check('模块新增设置「种子轮数 / 证据核实」', !!mod && ['种子轮数', '证据核实'].every((n) => (mod.settings || []).some((s) => s.name === n)));
  check('队列设置快照含增强字段', (() => { try { const o = Q.extractSettings(); return typeof o.maxSeedRounds === 'number' && typeof o.verify === 'boolean'; } catch (e) { return false; } })());

  orig.useTest = getSetting(mod, '使用临时端点');
  orig.endpoint = getSetting(mod, '临时端点');
  orig.autoConfirm = queueMod ? getSetting(queueMod, '自动确认纯新增') : undefined;
  setSetting(mod, '使用临时端点', true);
  setSetting(mod, '临时端点', `${location.origin}/v1?verify=drop-first`);
  setSetting(mod, '临时模型', 'mock-glossary-1');
  setSetting(mod, '种子补漏', true);
  setSetting(mod, '种子轮数', 2);
  setSetting(mod, '证据核实', true);
  if (queueMod) setSetting(queueMod, '自动确认纯新增', true);

  await clearJobs();
  try { Q.stop(); } catch (e) { }
  await mod.run(mod);   // 任务方式默认「加入队列」
  await sleep(300);
  const jobs0 = await listJobs();
  check('任务已入队', jobs0.length === 1 && jobs0[0].state === 'pending', jobs0.map((j) => j.state));
  const jobId = jobs0[0].id;

  await Q.runLoop();
  let job = null;
  for (let i = 0; i < 120; i += 1) {
    job = (await listJobs()).find((j) => j.id === jobId);
    if (job && ['done', 'review', 'failed'].includes(job.state)) break;
    await sleep(200);
  }
  check('任务跑完（done/review，非 failed）', !!job && ['done', 'review'].includes(job.state), job && { state: job.state, error: job.error });

  // 账本（多轮种子）与持久化
  check('种子轮 ≥1 且账本随任务持久化', !!job && job.boost && job.boost.seedRounds >= 1
    && job.seedLedger && Array.isArray(job.seedLedger.rounds) && job.seedLedger.rounds.length >= 1, job && { boost: job.boost, rounds: job.seedLedger && job.seedLedger.rounds });
  const seedPatterns = job && job.seedLedger ? job.seedLedger.rounds.flatMap((r) => r.seeds) : [];
  check('账本记录了敬称/称谓类种子（アリスさん / ローズちゃん）', seedPatterns.includes('アリスさん') || seedPatterns.includes('ローズちゃん'), seedPatterns);

  // 证据核实：mock 首条剔除
  check('核实剔除 1 条', !!job && job.boost && job.boost.verifyDrops === 1, job && job.boost);
  const dropped = job ? (job.entries || []).find((e) => e.verifyDrop) : null;
  check('剔除条目保留在任务里并带「核实建议剔除」标记', !!dropped && (dropped.suspect || []).some((s) => /核实建议剔除/.test(s)), dropped && { src: dropped.src, suspect: dropped.suspect });

  // 自动确认：剔除不写入、其余照常写
  check('自动确认完成（done）', !!job && job.state === 'done', job && { state: job.state, error: job.error });
  const stats = await fetch('/__stats').then((r) => r.json());
  const put = stats.lastGlossaryPut;
  check('写入站点且不含被剔除条目', !!put && /mock-boost/.test(put.path) && dropped && !Object.prototype.hasOwnProperty.call(put.body, dropped.src), put && { path: put.path, keys: Object.keys(put.body || {}) });
  check('其余条目正常写入', !!put && put.body && Object.keys(put.body).length >= 1, put && put.body);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  try { Q.stop(); } catch (e) { }
  const mod = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === 'AI提取术语表');
  const queueMod = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === '术语队列');
  if (mod) {
    if (orig.useTest !== undefined) setSetting(mod, '使用临时端点', orig.useTest);
    if (orig.endpoint !== undefined) setSetting(mod, '临时端点', orig.endpoint);
  }
  if (queueMod && orig.autoConfirm !== undefined) setSetting(queueMod, '自动确认纯新增', orig.autoConfirm);
  await clearJobs();
  out.notes.push('cleanup: 队列已清空、设置已还原');
}
return JSON.stringify(out, null, 1);
