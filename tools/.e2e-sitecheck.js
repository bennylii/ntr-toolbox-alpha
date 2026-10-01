// 站点自检（启动检查「站点挂点」是否变动）：面板挂载/会话键/工作区翻译器/volumes IDB +
// 列表页条目容器·分页结构 + 工作区任务条目；变动时告警 + 面板信息栏 ⚠ 角标 + 路由切换重跑。
// 跑法：node tools/.run-suite.mjs tools/.e2e-sitecheck.js "http://127.0.0.1:8788/novel"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const S = D.SiteCheck;

// 抓通知（只活 1 秒，边出现边抓）
const notes = [];
const obs = new MutationObserver((muts) => {
  muts.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType === 1 && n.className && String(n.className).includes('ntr-notification')) notes.push(n.textContent || '');
  }));
});
obs.observe(document.body, { childList: true, subtree: true });
const clearNotes = () => { const c = document.querySelector('.ntr-notification-container'); if (c) c.textContent = ''; notes.length = 0; };

const statusOf = (sum, id) => ((sum && sum.results.find((r) => r.id === id)) || {}).status;
const detailOf = (sum, id) => ((sum && sum.results.find((r) => r.id === id)) || {}).detail;
const setLS = (k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); };

const origPath = location.pathname + location.search;
const orig = {};
for (const k of ['auth-v2', 'auth', 'workspace-gpt', 'workspace-gpt-pipeline']) orig[k] = localStorage.getItem(k);

// 测试自己控制检查时机：先取消启动自动跑的排期
S.schedule(86400000);
S.cancel();

try {
  check('siteCheck 已暴露（run/last/schedule/onRouteChange/cancel）',
    !!S && typeof S.run === 'function' && typeof S.last === 'function' && typeof S.cancel === 'function');

  // ---------- A. 空白 mock 列表页：无站点特征 ----------
  const a = await S.run({ silent: true, waitMs: 400 });
  check('面板挂载点 ok（注入的 #ntr-panel 挂在 body）', statusOf(a, 'panel') === 'ok', a && a.results);
  check('非站点域名：会话/工作区翻译器/volumes 三项 skip', ['auth', 'workspace-gpt', 'volumes-idb'].every((id) => statusOf(a, id) === 'skip'));
  check('空列表页：条目检查 info（不算变动）', statusOf(a, 'list-items') === 'info', detailOf(a, 'list-items'));
  check('空列表页：分页检查 info', statusOf(a, 'list-pagination') === 'info');
  check('空白页没有任何 warn', a.warns.length === 0, a.warns);
  check('last() 返回最近一次结果（path=/novel）', S.last() && S.last().path === '/novel');
  check('面板 ⚠ 角标初始隐藏', document.getElementById('ntr-sitecheck').style.display === 'none');

  // ---------- B. 结构正常：条目 + 分页齐全 ----------
  const stage = document.createElement('div');
  stage.id = 'sc-stage';
  document.body.appendChild(stage);
  const mkList = (n, withItem) => {
    stage.innerHTML = '';
    const wrap = document.createElement('div');
    if (withItem) wrap.className = 'n-list-item';
    for (let i = 0; i < n; i++) {
      const link = document.createElement('a');
      link.href = location.origin + '/novel/mock-src/' + i;
      link.textContent = 'novel ' + i;
      wrap.appendChild(link);
    }
    stage.appendChild(wrap);
    return wrap;
  };
  const mkPag = (withButtons) => {
    const pag = document.createElement('div');
    pag.className = 'n-pagination';
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('div');
      d.className = 'n-pagination-item';
      d.textContent = String(i + 1);
      pag.appendChild(d);
    }
    if (withButtons) {
      const b = document.createElement('div');
      b.className = 'n-pagination-item n-pagination-item--button';
      pag.appendChild(b);
    }
    stage.appendChild(pag);
    return pag;
  };
  mkList(3, true); mkPag(true);
  const b = await S.run({ silent: true, waitMs: 200 });
  check('有条目 + .n-list-item：条目检查 ok', statusOf(b, 'list-items') === 'ok', detailOf(b, 'list-items'));
  check('分页含 --button：分页检查 ok', statusOf(b, 'list-pagination') === 'ok', detailOf(b, 'list-pagination'));
  check('结构正常：无 warn、角标still 隐藏', b.warns.length === 0 && document.getElementById('ntr-sitecheck').style.display === 'none');

  // ---------- C. 模拟"站点改版"：条目容器/翻页按钮都变了 ----------
  stage.innerHTML = ''; mkList(2, false); mkPag(false);
  clearNotes();
  const c = await S.run({ waitMs: 200 });   // 非 silent：应弹告警
  check('条目链接在但没有 .n-list-item → warn', statusOf(c, 'list-items') === 'warn', detailOf(c, 'list-items'));
  check('分页在但没有 --button → warn', statusOf(c, 'list-pagination') === 'warn', detailOf(c, 'list-pagination'));
  check('弹出「站点自检」告警 toast（2 处挂点变动）', notes.some((n) => /站点自检：2 处挂点变动/.test(n) && /列表页条目容器/.test(n)), notes);
  check('warns 里两条明细齐全', c.warns.length === 2, c.warns);
  const ind = document.getElementById('ntr-sitecheck');
  check('面板信息栏出现「⚠ 自检 2」角标', ind.style.display !== 'none' && /自检 2/.test(ind.textContent), ind.textContent);
  check('角标 title 写明问题（.n-list-item / --button）', /\.n-list-item/.test(ind.title) && /--button/.test(ind.title), ind.title);

  stage.innerHTML = ''; mkList(3, true); mkPag(true);
  await S.run({ silent: true, waitMs: 200 });
  check('修好结构重跑：角标自动隐藏', ind.style.display === 'none');

  // ---------- D. 工作区任务条目 ----------
  history.pushState({}, '', '/workspace/sc-test');
  await sleep(600);                  // 等主循环发现路由变化（会给自检排一期任务）
  S.cancel(); S.schedule(86400000);  // 取消它，测试自己控制
  for (let i = 0; i < 20 && S.busy(); i++) await sleep(120);
  stage.innerHTML = '';
  const mkWsItems = (withDesc) => {
    for (let i = 0; i < 2; i++) {
      const it = document.createElement('div');
      it.className = 'n-list-item';
      if (withDesc) {
        const d = document.createElement('div');
        d.className = 'n-thing-main__description';
        d.textContent = '未完成';
        it.appendChild(d);
      }
      stage.appendChild(it);
    }
  };
  mkWsItems(false);
  const d1 = await S.run({ silent: true, waitMs: 200 });
  check('工作区条目缺 .n-thing-main__description → warn', statusOf(d1, 'workspace-items') === 'warn', detailOf(d1, 'workspace-items'));
  check('工作区路径：列表页检查 skip', statusOf(d1, 'list-items') === 'skip', detailOf(d1, 'list-items'));
  stage.innerHTML = ''; mkWsItems(true);
  const d2 = await S.run({ silent: true, waitMs: 200 });
  check('补上描述后 → ok', statusOf(d2, 'workspace-items') === 'ok', detailOf(d2, 'workspace-items'));

  // ---------- E. 存储类检查（site:true 强制，在 mock origin 上验证分支） ----------
  setLS('auth-v2', null); setLS('auth', null);
  setLS('workspace-gpt', null); setLS('workspace-gpt-pipeline', null);
  const e1 = await S.run({ silent: true, site: true, waitMs: 100 });
  check('没有会话键 → auth warn（提示未登录/键名变动）', statusOf(e1, 'auth') === 'warn', detailOf(e1, 'auth'));
  check('没有工作区翻译器 → info（提示用临时端点）', statusOf(e1, 'workspace-gpt') === 'info', detailOf(e1, 'workspace-gpt'));
  check('volumes IDB 检查给出 ok/info', ['ok', 'info'].includes(statusOf(e1, 'volumes-idb')), detailOf(e1, 'volumes-idb'));

  setLS('auth-v2', JSON.stringify({ token: 'sc-test-token', adminMode: false }));
  setLS('workspace-gpt', JSON.stringify({ workers: [{ id: 'sc-fake', endpoint: 'http://x', model: 'm' }], jobs: [], uncompletedJobs: [] }));
  const e2 = await S.run({ silent: true, site: true, waitMs: 100 });
  check('会话键回来 → auth ok', statusOf(e2, 'auth') === 'ok', detailOf(e2, 'auth'));
  check('工作区翻译器回来 → ok 且明细带 id', statusOf(e2, 'workspace-gpt') === 'ok' && /sc-fake/.test(detailOf(e2, 'workspace-gpt')), detailOf(e2, 'workspace-gpt'));
  check('auth 告警消失后角标再次隐藏', document.getElementById('ntr-sitecheck').style.display === 'none');

  // ---------- F. 路由切换自动重跑 ----------
  const before = S.last().at;
  history.pushState({}, '', '/sc-route-b');
  await sleep(2200);   // 主循环发现变化 → 800ms 后排一期 → 跑完
  const f = S.last();
  check('路由变化后自动重跑（last.path=/sc-route-b、时间更新）',
    f && f.path === '/sc-route-b' && f.at >= before, f && { path: f.path, at: f.at, before });
  check('新页面不适用的检查标 skip', statusOf(f, 'list-items') === 'skip', detailOf(f, 'list-items'));
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  obs.disconnect();
  const st = document.getElementById('sc-stage'); if (st) st.remove();
  try { history.replaceState({}, '', origPath); } catch (e) { }
  for (const [k, v] of Object.entries(orig)) setLS(k, v);
  S.cancel(); S.schedule(86400000);   // 别让测试期间的假页面触发后续自检
  clearNotes();
  out.notes.push('cleanup: 假 DOM/URL/localStorage/toast 已还原，自检排期已冻');
}
return JSON.stringify(out, null, 1);
