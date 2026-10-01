// 「复制翻译器到BETA工作区」模块：老工作区 workspace-gpt → 新工作区 workspace-gpt-pipeline
// 跑法：cdp open <页面> + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-translator-copy.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });

const OLD = 'workspace-gpt';
const BETA = 'workspace-gpt-pipeline';
const oldBackup = localStorage.getItem(OLD);
const betaBackup = localStorage.getItem(BETA);
const setStore = (k, obj) => localStorage.setItem(k, JSON.stringify(obj));
const getStore = (k) => { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; };
const clearKey = (k) => localStorage.removeItem(k);

// 通知只活 1 秒：用 MutationObserver 在它们出现时抓
const seen = [];
const mo = new MutationObserver((muts) => {
  muts.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.classList && n.classList.contains('ntr-notification-message')) seen.push(n.textContent);
    if (n.querySelectorAll) n.querySelectorAll('.ntr-notification-message').forEach((x) => seen.push(x.textContent));
  }));
});
mo.observe(document.body, { childList: true, subtree: true });

const storageEvents = [];
const onStorage = (e) => storageEvents.push({ key: e.key, len: (e.newValue || '').length });
window.addEventListener('storage', onStorage);

const wA = { id: 'A', type: 'api', model: 'm-a', endpoint: 'http://127.0.0.1:8788/v1', key: 'k-a' };
const wB = { id: 'B', type: 'api', model: 'm-b', endpoint: 'http://127.0.0.1:8788/v1', key: 'k-b' };

try {
  const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === '复制翻译器到BETA工作区');
  check('模块存在于面板配置里', !!mod);
  if (!mod) throw new Error('模块不存在');
  const setOverwrite = (v) => { mod.settings.find((s) => s.name === '覆盖同名翻译器').value = v; };
  const run = async () => { await mod.run(mod, true); await new Promise((r) => setTimeout(r, 80)); };

  // A) 老工作区为空 → 什么都不做
  clearKey(OLD); clearKey(BETA);
  setOverwrite(false);
  await run();
  check('老工作区为空时不创建 BETA 存储', localStorage.getItem(BETA) === null);
  check('老工作区为空时给出提示', seen.some((t) => /没有可复制的翻译器/.test(t)), seen.slice(-3));

  // B) 复制 2 个翻译器，且不动 BETA 里已有的任务数据
  setStore(OLD, { workers: [wA, wB], jobs: [{ task: 'old-job' }], uncompletedJobs: [] });
  setStore(BETA, { workers: [], jobs: [{ task: 'beta-job' }], uncompletedJobs: [{ task: 'beta-un' }] });
  await run();
  const betaB = getStore(BETA);
  check('复制了 2 个翻译器（id/model/endpoint/key 都带过去）',
    betaB && betaB.workers.length === 2
    && betaB.workers.some((w) => w.id === 'A' && w.model === 'm-a' && w.endpoint === 'http://127.0.0.1:8788/v1' && w.key === 'k-a')
    && betaB.workers.some((w) => w.id === 'B'), betaB && betaB.workers);
  check('BETA 里原有的任务队列没被动', betaB.jobs.length === 1 && betaB.jobs[0].task === 'beta-job' && betaB.uncompletedJobs.length === 1);
  check('老工作区的数据没被改动', getStore(OLD).workers.length === 2 && getStore(OLD).jobs[0].task === 'old-job');
  check('派发了 storage 事件（让已打开的 BETA 页面同步，不被它回写顶掉）',
    storageEvents.some((e) => e.key === BETA && e.len > 0), storageEvents.slice(-3));
  check('成功提示里带复制数量', seen.some((t) => /已复制 2 个翻译器到 BETA 工作区/.test(t)), seen.slice(-3));

  // C) 同名但不勾选覆盖 → 跳过，保留 BETA 自己的那份
  setStore(BETA, { workers: [{ id: 'A', type: 'api', model: 'beta-model', endpoint: 'http://beta.local/v1', key: 'beta-key' }], jobs: [], uncompletedJobs: [] });
  setOverwrite(false);
  storageEvents.length = 0;
  await run();
  const betaC = getStore(BETA);
  check('同名不覆盖：保留 BETA 原来的配置', betaC.workers.find((w) => w.id === 'A').endpoint === 'http://beta.local/v1', betaC.workers);
  check('同名不覆盖：BETA 里 B 也被补上了', betaC.workers.some((w) => w.id === 'B'), betaC.workers);
  check('同名不覆盖：没有重复项', betaC.workers.filter((w) => w.id === 'A').length === 1);
  check('同名跳过时提示里说明跳过数量', seen.some((t) => /已复制 1 个翻译器到 BETA 工作区，跳过同名 1 个/.test(t)), seen.slice(-3));

  // C2) 全都同名、且没勾选覆盖 → 什么都不写，提示去勾选
  setStore(OLD, { workers: [wA], jobs: [], uncompletedJobs: [] });
  setStore(BETA, { workers: [{ id: 'A', type: 'api', model: 'beta-model', endpoint: 'http://beta.local/v1', key: 'beta-key' }], jobs: [], uncompletedJobs: [] });
  setOverwrite(false);
  await run();
  check('全同名时不重复写入（BETA 保持原样）', getStore(BETA).workers[0].endpoint === 'http://beta.local/v1');
  check('全同名时提示可勾选「覆盖同名翻译器」', seen.some((t) => /已有同名翻译器/.test(t)), seen.slice(-3));

  // D) 勾选覆盖 → 用老工作区的配置盖掉同名项
  setStore(OLD, { workers: [wA, wB], jobs: [], uncompletedJobs: [] });
  setOverwrite(true);
  await run();
  const betaD = getStore(BETA);
  const aD = betaD.workers.find((w) => w.id === 'A');
  check('勾选覆盖后：老工作区的 endpoint/model/key 盖上去',
    aD.endpoint === 'http://127.0.0.1:8788/v1' && aD.model === 'm-a' && aD.key === 'k-a', aD);
  check('覆盖后没有重复项', betaD.workers.filter((w) => w.id === 'A').length === 1);

  // E) 'web' 类型（老工作区遗留的 chat.openai.com 那套）不搬
  setStore(OLD, { workers: [{ id: 'webw', type: 'web', model: 'text-davinci-002-render-sha', endpoint: 'https://chat.openai.com/backend-api' }, wA], jobs: [], uncompletedJobs: [] });
  clearKey(BETA);
  setOverwrite(false);
  await run();
  const betaE = getStore(BETA);
  check("type:'web' 的翻译器不复制", betaE && !betaE.workers.some((w) => w.id === 'webw') && betaE.workers.some((w) => w.id === 'A'), betaE && betaE.workers);
  check('复制后新存储结构完整（workers/jobs/uncompletedJobs）',
    betaE && Array.isArray(betaE.workers) && Array.isArray(betaE.jobs) && Array.isArray(betaE.uncompletedJobs));
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  mo.disconnect();
  window.removeEventListener('storage', onStorage);
  if (oldBackup === null) clearKey(OLD); else localStorage.setItem(OLD, oldBackup);
  if (betaBackup === null) clearKey(BETA); else localStorage.setItem(BETA, betaBackup);
  out.notes.push(`cleanup: ${OLD}=${localStorage.getItem(OLD) === null ? 'removed' : 'restored'} / ${BETA}=${localStorage.getItem(BETA) === null ? 'removed' : 'restored'}`);
}
return JSON.stringify(out, null, 1);
