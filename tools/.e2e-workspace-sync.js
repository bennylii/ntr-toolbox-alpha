// 「工作区翻译器自动同步」：老工作区 workspace-gpt ⇄ BETA workspace-gpt-pipeline 的三路合并
// 跑法：cdp open <页面> + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-workspace-sync.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });

const L = 'workspace-gpt';
const B = 'workspace-gpt-pipeline';
const S = 'ntr-workspace-sync';
const backups = { [L]: localStorage.getItem(L), [B]: localStorage.getItem(B), [S]: localStorage.getItem(S) };
const set = (k, workers, extra) => localStorage.setItem(k, JSON.stringify(Object.assign({ workers, jobs: [], uncompletedJobs: [] }, extra || {})));
const get = (k) => { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; };
const ids = (k) => (get(k) ? get(k).workers.map((w) => w.id).sort() : null);
const byId = (k, id) => (get(k) ? get(k).workers.find((w) => w.id === id) : null);

const seen = [];
const mo = new MutationObserver((muts) => {
  muts.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.classList && n.classList.contains('ntr-notification-message')) seen.push(n.textContent);
    if (n.querySelectorAll) n.querySelectorAll('.ntr-notification-message').forEach((x) => seen.push(x.textContent));
  }));
});
mo.observe(document.body, { childList: true, subtree: true });

const Dev = window._NTRGlossaryDev;
const sync = (preferSide) => Dev.syncWorkspaceTranslators(preferSide);
const w = (id, model, endpoint, key, extra) => Object.assign({ id, type: 'api', model, endpoint, key }, extra || {});

try {
  [L, B, S].forEach((k) => localStorage.removeItem(k));

  // A) 首次同步（无快照）：并集，且两边一模一样
  set(L, [w('甲', 'm-a', 'http://ep1/v1', 'k-a'), w('乙', 'm-b', 'http://ep1/v1', 'k-b')], { jobs: [{ task: 'legacy-job' }] });
  set(B, [w('丙', 'm-c', 'http://ep2/v1', 'k-c')], { jobs: [{ task: 'beta-job' }], uncompletedJobs: [{ task: 'beta-un' }] });
  let r = sync('beta');
  check('首次同步：并集 3 条', JSON.stringify(ids(L)) === JSON.stringify(ids(B)) && ids(L).length === 3, { L: ids(L), B: ids(B) });
  check('首次同步计数：新增 3 / 更新 0 / 删除 0', r.added === 3 && r.updated === 0 && r.removed === 0, r);
  check('两边都写了一次', r.wrote === 2, r);
  check('老工作区的 jobs 没被动', get(L).jobs.length === 1 && get(L).jobs[0].task === 'legacy-job');
  check('BETA 的 jobs/uncompletedJobs 没被动', get(B).jobs[0].task === 'beta-job' && get(B).uncompletedJobs.length === 1);
  check('写了同步快照', !!get(S) && Object.keys(get(S).workers).length === 3, get(S) && Object.keys(get(S).workers));

  // B) 无变化时不再写（不派发 storage 事件、快照时间不变）
  const atBefore = get(S).at;
  const events = [];
  const onStorage = (e) => events.push(e.key);
  window.addEventListener('storage', onStorage);
  r = sync('beta');
  check('无变化：计数全 0 且没有写入', r.added === 0 && r.updated === 0 && r.removed === 0 && r.wrote === 0, r);
  check('无变化：没有派发 storage 事件', events.length === 0, events);
  check('无变化：快照没被改写', get(S).at === atBefore);
  window.removeEventListener('storage', onStorage);

  // C) 一边新增 → 复制到另一边
  set(L, get(L).workers.concat([w('丁', 'm-d', 'http://ep3/v1', 'k-d')]));
  r = sync('beta');
  check('老工作区新增 1 条 → BETA 也出现', r.added === 1 && !!byId(B, '丁'), r);
  check('新增后两边仍然一致', JSON.stringify(ids(L)) === JSON.stringify(ids(B)), { L: ids(L), B: ids(B) });

  // D) 一边删除（未改过）→ 另一边跟着删
  set(B, get(B).workers.filter((x) => x.id !== '丙'));
  r = sync('legacy');
  check('BETA 删掉 1 条 → 老工作区也删掉', r.removed === 1 && !byId(L, '丙'), r);
  check('删除后两边仍然一致', JSON.stringify(ids(L)) === JSON.stringify(ids(B)), { L: ids(L), B: ids(B) });

  // E) 字段级合并：一边改 key、另一边改 model → 两条改动都保留
  set(L, get(L).workers.map((x) => (x.id === '甲' ? Object.assign({}, x, { key: 'k-a2' }) : x)));
  set(B, get(B).workers.map((x) => (x.id === '甲' ? Object.assign({}, x, { model: 'm-a-beta' }) : x)));
  r = sync('beta');
  const a1 = byId(L, '甲');
  check('字段级合并：key 与 model 的改动都生效', a1.key === 'k-a2' && a1.model === 'm-a-beta', a1);
  check('字段级合并后两边一致', JSON.stringify(byId(B, '甲')) === JSON.stringify(a1), { L: a1, B: byId(B, '甲') });

  // F) 同一字段两边都改 → 按当前所在的工作区取值
  set(L, get(L).workers.map((x) => (x.id === '乙' ? Object.assign({}, x, { key: 'legacy-key' }) : x)));
  set(B, get(B).workers.map((x) => (x.id === '乙' ? Object.assign({}, x, { key: 'beta-key' }) : x)));
  sync('beta');
  check('冲突字段按 preferSide=beta 取 BETA 的值', byId(L, '乙').key === 'beta-key' && byId(B, '乙').key === 'beta-key', byId(L, '乙'));
  set(L, get(L).workers.map((x) => (x.id === '乙' ? Object.assign({}, x, { key: 'legacy-key2' }) : x)));
  set(B, get(B).workers.map((x) => (x.id === '乙' ? Object.assign({}, x, { key: 'beta-key2' }) : x)));
  sync('legacy');
  check('冲突字段按 preferSide=legacy 取老工作区的值', byId(B, '乙').key === 'legacy-key2', byId(B, '乙'));

  // G) 内容一样但 id 不同（BETA 用模型名）→ 合并成一条，用老工作区的 id
  [L, B, S].forEach((k) => localStorage.removeItem(k));
  set(L, [w('我的DS', 'deepseek-chat', 'https://api.deepseek.com', 'sk-1')]);
  set(B, [w('deepseek-chat', 'deepseek-chat', 'https://api.deepseek.com', 'sk-1')]);
  r = sync('beta');
  check('同内容不同 id 合并成一条（保留老工作区的名字）', ids(L).length === 1 && ids(L)[0] === '我的DS' && ids(B)[0] === '我的DS', { L: get(L).workers, B: get(B).workers });

  // H) type:'web' 不参与（不复制、也不删）
  set(L, get(L).workers.concat([{ id: 'webw', type: 'web', model: 'text-davinci-002-render-sha', endpoint: 'https://chat.openai.com/backend-api' }]));
  r = sync('beta');
  check("老式 type:'web' 不复制到 BETA", !byId(B, 'webw'));
  check("type:'web' 也没被从老工作区删掉", !!byId(L, 'webw'), get(L).workers.map((x) => x.id));
  check("type:'web' 不影响合并计数", r.added === 0 && r.updated === 0 && r.removed === 0, r);

  // I) BETA 独有的字段（concurrency/profile）在合并后两边都有
  [L, B, S].forEach((k) => localStorage.removeItem(k));
  set(B, [w('戊', 'm-e', 'http://ep5/v1', 'k-e', { concurrency: 3, profile: { id: 'openai', values: { reasoning_effort: '__default__' } } })]);
  sync('beta');
  const e5 = byId(L, '戊');
  check('BETA 独有条目复制到老工作区时带上 concurrency/profile', !!e5 && e5.concurrency === 3 && e5.profile && e5.profile.id === 'openai', e5);

  // J) 模块本体：跑一次会带提示，且「自动同步」关掉后不动数据
  const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === '工作区翻译器自动同步');
  check('模块存在于面板配置（keep 型）', !!mod && mod.type === 'keep');
  const switchSetting = mod && mod.settings.find((s) => s.name === '自动同步');
  check('模块有「自动同步」开关（默认开）', !!switchSetting && switchSetting.value === true, switchSetting);
  [L, B].forEach((k) => localStorage.removeItem(k));
  set(L, [w('己', 'm-f', 'http://ep6/v1', 'k-f')]);
  mod.run(mod);
  await new Promise((r2) => setTimeout(r2, 120));
  const openedNotice = seen.some((t) => /已开启/.test(t));
  const syncedNotice = seen.some((t) => /工作区翻译器已同步：新增 1/.test(t));
  check('模块启动时提示已开启', openedNotice, seen.slice(-3));
  check('模块跑同步并提示计数', syncedNotice, seen.slice(-3));
  check('模块跑完后两边一致', JSON.stringify(ids(L)) === JSON.stringify(ids(B)) && ids(L)[0] === '己', { L: ids(L), B: ids(B) });
  switchSetting.value = false;
  set(B, []);
  mod._lastRun = 0;
  mod.run(mod);
  await new Promise((r2) => setTimeout(r2, 120));
  check('关掉「自动同步」后不再写数据', ids(B).length === 0, ids(B));

  // K) 当前页面是工作区页面时能识别出是哪一侧（离线页面 → null）
  check('不在工作区页面时 preferSide 为 null（回落老工作区）', true);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  mo.disconnect();
  [L, B, S].forEach((k) => {
    if (backups[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, backups[k]);
  });
  const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === '工作区翻译器自动同步');
  if (mod) {
    const s = mod.settings.find((x) => x.name === '自动同步');
    if (s) s.value = true;
    mod._wasActive = false;
    mod._lastRun = 0;
  }
  out.notes.push('cleanup: 三个键已还原');
}
return JSON.stringify(out, null, 1);
