// 回滚术语表：多版本快照 / 版本列表 / diff 预览 / 回滚前自动快照
// 跑法：cdp open http://127.0.0.1:8788/novel/mock/mock-src（或真实小说页）+ cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-rollback.js
// ⚠️ 目标页必须是**两段路径**（/novel/<provider>/<id>，例如 /novel/mock/mock-src）：/novel/mock-1 只有一段，
//    resolveGlossaryTarget() 会落到"本地卷"分支弹「选择本地卷」，需要目标的用例会卡死在那里
// 安全性：写入全部走 fetch 拦截（干跑），PUT 不会真的发出；当前术语表也是注入的假 DTO —— 线上零污染。
// 等待一律用 MutationObserver：后台标签页的链式 setTimeout 会被节流到 ~1s/次，轮询式等待必超时。
const result = { pass: [], fail: [], info: {}, errors: [] };
const check = (label, cond, extra) => {
  if (cond) result.pass.push(label);
  else result.fail.push(extra === undefined ? label : `${label} → ${JSON.stringify(extra)}`);
};

window.confirm = () => true;

const Dev = window._NTRGlossaryDev;
const { GlossaryTargets, GlossaryDB } = Dev;

const waitFor = (predicate, timeoutMs) => new Promise((resolve) => {
  if (predicate()) return resolve(true);
  const obs = new MutationObserver(() => { if (predicate()) { obs.disconnect(); resolve(true); } });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { obs.disconnect(); resolve(false); }, timeoutMs);
});

const waitNotification = (needle, timeoutMs) => new Promise((resolve) => {
  const hit = () => [...document.querySelectorAll('.ntr-notification-message')].some((n) => n.textContent.includes(needle));
  if (hit()) return resolve(true);
  const obs = new MutationObserver(() => { if (hit()) { obs.disconnect(); resolve(true); } });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { obs.disconnect(); resolve(hit()); }, timeoutMs);
});

const notes = () => [...document.querySelectorAll('.ntr-notification-message')].map((n) => n.textContent.trim());
const clickEl = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
// 术语表内容比对（不看 key 顺序）
const sameMap = (a, b) => JSON.stringify(Object.keys(a || {}).sort().map((k) => [k, a[k]]))
  === JSON.stringify(Object.keys(b || {}).sort().map((k) => [k, b[k]]));

// ---------- fetch 拦截：PUT 干跑 + 注入假的「当前术语表」DTO ----------
const origFetch = window.fetch;
const puts = [];
let fakeGlossary = null;
let dtoNeedle = null;
window.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  if (method === 'PUT' && u.includes('/glossary')) {
    puts.push({ url: u, body: opts.body });
    return new Response('', { status: 200 });
  }
  if (fakeGlossary && dtoNeedle && method === 'GET' && u.includes(dtoNeedle) && !u.includes('/glossary')) {
    return new Response(JSON.stringify({ glossary: fakeGlossary }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return origFetch(url, opts);
};

const seededIds = [];
try {
  const target = await Dev.resolveGlossaryTarget();
  if (!target) throw new Error('当前页面解析不到术语表目标（需要 /novel/... 或 /wenku/... 页面）');
  if (target.kind !== 'web' && target.kind !== 'wenku') throw new Error(`当前目标是 ${target.kind}，本测试只覆盖 web/wenku`);
  const stray = document.getElementById('ntr-glossary-overlay');
  if (stray) stray.remove();
  const key = GlossaryTargets.targetKey(target);
  dtoNeedle = target.kind === 'web' ? `/api/novel/${target.providerId}/${target.novelId}` : `/api/wenku/${target.novelId}`;
  result.info.target = { kind: target.kind, key };

  // ---------- A. 版本列表 ----------
  // 目标下可能已经有历史版本（之前跑导入/写入用例时留下的），所以全部断言都按「基线之外」来算
  const baseline = new Set((await GlossaryTargets.listSnapshots(target)).map((v) => v.id));
  result.info.baselineVersions = baseline.size;
  const currentFake = { 'テスト現甲': '現甲译', 'テスト共乙': '共乙译' };
  const snapOld = { 'テスト共乙': '共乙译', 'テスト旧丙': '旧丙译' };
  const snapNew = { 'テスト共乙': '共乙-改译' };
  const s1 = await GlossaryTargets.takeSnapshot(target, snapOld, '手动：旧版本');
  await new Promise((r) => setTimeout(r, 5));
  const s2 = await GlossaryTargets.takeSnapshot(target, snapNew, '手动：新版本');
  seededIds.push(s1.id, s2.id);
  check('takeSnapshot 生成带时间戳的版本 id', /#\d+$/.test(s1.id) && s1.id !== s2.id, [s1.id, s2.id]);

  const listed = await GlossaryTargets.listSnapshots(target);
  const fresh = listed.filter((v) => !baseline.has(v.id));
  check('两个新版本都在列表里', fresh.length === 2 && fresh[0].note === '手动：新版本', listed.slice(0, 3).map((v) => v.note));
  check('版本按新→旧排序', listed[0].id === s2.id && listed[1].id === s1.id, listed.slice(0, 2).map((v) => v.note));
  const newest = await GlossaryTargets.getSnapshot(target);
  check('getSnapshot 兼容接口取最新版本', !!newest && newest.id === listed[0].id, newest && newest.id);

  // 旧格式（单条快照：id 就是 targetKey、无 key 字段）要能被识别成版本
  const legacyAt = Date.now() - 60000;
  await GlossaryDB.put('snapshots', { id: key, target, glossary: { 'テスト旧式': '旧式译' }, createAt: legacyAt });
  const listedLegacy = await GlossaryTargets.listSnapshots(target);
  check('兼容早期的单条快照记录', listedLegacy.some((v) => v.id === key && v.glossary['テスト旧式'] === '旧式译'), listedLegacy.map((v) => v.id));
  check('旧记录按时间排在其来源版本的位置', listedLegacy.findIndex((v) => v.id === key) > 0, listedLegacy.map((v) => v.createAt));
  await GlossaryDB.delete('snapshots', key);

  // ---------- B. 版本剪枝（保留最近 20 个） ----------
  const fakeTarget = { kind: '__prune__' };
  const now = Date.now();
  for (let i = 0; i < 23; i++) {
    await GlossaryDB.put('snapshots', {
      id: `unknown#${now - (23 - i) * 1000}`, key: 'unknown', target: fakeTarget,
      glossary: { [`s${i}`]: `d${i}` }, note: `seed${i}`, createAt: now - (23 - i) * 1000,
    });
  }
  check('剪枝前 23 条', (await GlossaryTargets.listSnapshots(fakeTarget)).length === 23);
  const trigger = await GlossaryTargets.takeSnapshot(fakeTarget, { s: 'd' }, '触发剪枝');
  const afterPrune = await GlossaryTargets.listSnapshots(fakeTarget);
  check('剪枝到 20 条（SNAPSHOT_KEEP）', afterPrune.length === 20, afterPrune.length);
  check('保留的是最近的版本', afterPrune[0].id === trigger.id && afterPrune[1].note === 'seed22', afterPrune.slice(0, 2).map((v) => v.note));
  check('最老的两条被删掉', !afterPrune.some((v) => v.note === 'seed0' || v.note === 'seed1'));
  for (const v of afterPrune) await GlossaryDB.delete('snapshots', v.id);
  check('假目标快照已清理', (await GlossaryTargets.listSnapshots(fakeTarget)).length === 0);

  // ---------- C. 模块：版本选择 → diff 预览 → 回滚 ----------
  fakeGlossary = currentFake;
  window._NTRToolBox.runModule('回滚术语表');
  const pickOk = await waitFor(() => {
    const o = document.getElementById('ntr-glossary-overlay');
    return !!(o && o.querySelector('.ntr-g-title') && o.querySelectorAll('.ntr-g-body > div button').length > 0);
  }, 15000);
  const pickOverlay = document.getElementById('ntr-glossary-overlay');
  const pickTitle = pickOverlay ? pickOverlay.querySelector('.ntr-g-title').textContent : '';
  check('版本选择弹层打开', pickOk && pickTitle.includes('回滚术语表') && pickTitle.includes(`${baseline.size + 2} 个版本`), pickTitle);
  const optRows = pickOverlay ? [...pickOverlay.querySelectorAll('.ntr-g-body > div')] : [];
  const optionTexts = optRows.map((d) => d.textContent);
  const newIdx = optionTexts.findIndex((t) => t.includes('手动：新版本'));
  const oldIdx = optionTexts.findIndex((t) => t.includes('手动：旧版本'));
  check('两个新版本排在列表最前（新→旧）', newIdx === 0 && oldIdx === 1, optionTexts.slice(0, 3));
  check('版本行显示相对当前的 新增/覆盖/删除',
    optionTexts[newIdx].includes('新增 0 / 覆盖 1 / 删除 1') && optionTexts[oldIdx].includes('新增 1 / 覆盖 0 / 删除 1'),
    [optionTexts[newIdx], optionTexts[oldIdx]]);
  check('版本行带 note 与条数', optionTexts[oldIdx].includes('手动：旧版本') && optionTexts[oldIdx].includes('2 条'), optionTexts[oldIdx]);

  clickEl(optRows[oldIdx].querySelector('button'));   // 选「旧版本」：新增 1 / 覆盖 0 / 删除 1
  const restoreOk = await waitFor(() => {
    const o = document.getElementById('ntr-glossary-overlay');
    return !!(o && o.querySelector('#ntr-g-restore') && o.querySelector('table'));
  }, 15000);
  const ov = document.getElementById('ntr-glossary-overlay');
  const q = (sel) => (ov && ov.querySelector(sel) ? ov.querySelector(sel).textContent.trim() : '');
  const heads = ov ? [...ov.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : [];
  const tabs = ov ? [...ov.querySelectorAll('.ntr-g-tab')].map((t) => t.textContent.trim()) : [];
  const rows = ov ? [...ov.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim())) : [];
  check('diff 预览打开', restoreOk && q('.ntr-g-title').includes('回滚预览'), q('.ntr-g-title'));
  check('表头为 版本译文/当前译文', heads.includes('版本译文') && heads.includes('当前译文'), heads);
  check('页签为 全部/新增/覆盖/相同/将删除', tabs.join('|') === '全部|新增|覆盖|相同|将删除', tabs);
  check('统计正确（版本 2 条｜新增 1｜覆盖 0｜相同 1｜将删除 1）',
    q('.ntr-g-stats').includes('版本 2 条') && q('.ntr-g-stats').includes('新增 1')
    && q('.ntr-g-stats').includes('覆盖 0') && q('.ntr-g-stats').includes('相同 1') && q('.ntr-g-stats').includes('将删除 1'), q('.ntr-g-stats'));
  check('回滚预估文案带数字', q('.ntr-g-warn').includes('新增 1 条、覆盖 0 条、删除 1 条'), q('.ntr-g-warn'));
  const delRow = rows.find((r) => r.includes('将删除'));
  const addRow = rows.find((r) => r.includes('新增'));
  // restore 模式没有 次数/类型 列：cells = [原文, 版本译文, 当前译文, 状态]
  check('「将删除」行：版本列 —，当前列是现值', !!delRow && delRow[1] === '—' && delRow[2] === '現甲译', delRow);
  check('「新增」行：版本列是旧值，当前列 —', !!addRow && addRow[1] === '旧丙译' && addRow[2] === '—', addRow);
  check('restore 模式不显示 次数/类型 列', !heads.includes('次数') && !heads.includes('类型'), heads);
  result.info.rows = rows;

  clickEl(document.getElementById('ntr-g-restore'));
  const toastOk = await waitNotification('已回滚到', 8000);
  await waitFor(() => !document.getElementById('ntr-glossary-overlay'), 8000);
  check('回滚成功提示', toastOk, notes());
  check('弹层已关闭', !document.getElementById('ntr-glossary-overlay'));
  const put1 = puts[0];
  check('PUT 只发了一次，URL 指向目标 glossary', puts.length === 1 && !!put1 && put1.url.endsWith('/glossary'), puts.map((p) => p.url));
  check('PUT body = 目标版本的术语表', !!put1 && sameMap(JSON.parse(put1.body), snapOld), put1 && put1.body);

  const afterRollback = await GlossaryTargets.listSnapshots(target);
  afterRollback.forEach((v) => { if (!baseline.has(v.id)) seededIds.push(v.id); });
  const auto = afterRollback.find((v) => v.note === '回滚前自动快照');
  check('回滚前自动存了快照', !!auto && afterRollback[0].id === auto.id, afterRollback.slice(0, 3).map((v) => v.note));
  check('自动快照内容是「回滚前」的当前术语表', !!auto && sameMap(auto.glossary, currentFake), auto && auto.glossary);
  check('本次新增 3 个版本（2 手动 + 1 自动）',
    afterRollback.filter((v) => !baseline.has(v.id)).length === 3, afterRollback.filter((v) => !baseline.has(v.id)).map((v) => v.note));

  // ---------- D. 兼容接口 GlossaryTargets.rollback() ----------
  const rolled = await GlossaryTargets.rollback(target);
  check('rollback() 取最新版本', !!rolled && rolled.id === afterRollback[0].id, rolled && rolled.id);
  check('rollback() 再写一次 PUT（最新版本内容）', puts.length === 2 && sameMap(JSON.parse(puts[1].body), afterRollback[0].glossary), puts[1] && puts[1].body);
  const afterCompat = await GlossaryTargets.listSnapshots(target);
  afterCompat.forEach((v) => { if (!seededIds.includes(v.id)) seededIds.push(v.id); });
  check('rollback() 也自动存了回滚前快照', afterCompat.filter((v) => v.note === '回滚前自动快照').length === 2, afterCompat.map((v) => v.note));

  // ---------- E. 没有快照时的提示 ----------
  // 之前的导入/写入干跑会在测试 profile 里留下历史版本，这里一并清掉（都是本轮的测试产物）
  for (const id of [...baseline, ...new Set(seededIds)]) await GlossaryDB.delete('snapshots', id);
  seededIds.length = 0;
  const cleared = await GlossaryTargets.listSnapshots(target);
  check('快照已清空', cleared.length === 0, cleared.map((v) => v.note));
  window._NTRToolBox.runModule('回滚术语表');
  const emptyOk = await waitNotification('没有找到该目标的快照', 8000);
  const anyOverlay = document.getElementById('ntr-glossary-overlay');
  check('无快照时只提示、不开弹层', emptyOk && !anyOverlay, { emptyOk, hasOverlay: !!anyOverlay });
} catch (e) {
  result.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
}

// ---------- 清理（无论成败） ----------
for (const id of [...new Set(seededIds)]) {
  try { await GlossaryDB.delete('snapshots', id); } catch (e) { result.errors.push('cleanup ' + id + ': ' + e.message); }
}
fakeGlossary = null;
window.fetch = origFetch;
const left = document.getElementById('ntr-glossary-overlay');
if (left) left.remove();

return JSON.stringify(result, null, 1);
