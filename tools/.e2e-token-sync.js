// 控制台「从站点同步」按钮 e2e：点按钮 → 进入等待态 + daemon 置同步请求 → 模拟站点推送 /auth → 按钮恢复 + 状态行/toast 显示已同步
// 依赖：临时 daemon 在 7359（--db daemon/.tmp-token-sync.db）；不需要 mock 站点
// 跑法：
//   node daemon/index.mjs serve --port 7359 --db daemon/.tmp-token-sync.db   （后台）
//   CDP_PORT=9334 node tools/cdp.mjs open http://127.0.0.1:7359/ui && node tools/cdp.mjs evalf tools/.e2e-token-sync.js
// 说明：真实场景里推送由站点页面（油猴）在 ≤5s 的 daemon 探测里完成；这里用 fetch 直接 POST /auth 模拟。
//       35s 超时路径不在本车道跑（太长），由 daemon-test 的「过期语义」用例覆盖。
const out = { checks: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const btn = () => document.getElementById('token-sync');
const hint = () => document.getElementById('token-sync-hint');

try {
  check('「从站点同步」按钮存在且初始可用', !!btn() && btn().textContent.includes('从站点同步') && !btn().disabled, btn() && btn().textContent);
  check('提示行初始为用法说明（提到油猴）', /油猴/.test(hint().textContent), hint().textContent);
  const before = await fetch('/settings').then((r) => r.json());
  const beforeAt = ((before.settings || {}).lastSync || {}).at || 0;

  btn().click();
  await sleep(700);
  check('点击后进入等待态（禁用 + 「等待站点推送…」）', btn().disabled && /等待站点推送/.test(btn().textContent), btn().textContent);
  const mid = await fetch('/settings').then((r) => r.json());
  check('daemon 已置同步请求（/settings.authRequest）', !!((mid.settings || {}).authRequest || {}).at, JSON.stringify((mid.settings || {}).authRequest));
  const ping = await fetch('/ping').then((r) => r.json());
  check('/ping.pendingAuth = true（油猴据此绕过指纹去重）', ping.pendingAuth === true, JSON.stringify(ping));

  // 模拟站点页面推送（真实场景：油猴 ≤5s 探测到 pendingAuth 后推一次）
  await fetch('/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'e2e-token-sync', workers: [{ id: 'w0', model: 'm', endpoint: 'http://127.0.0.1:9/v1', key: 'k' }], origin: 'https://n.novelia.cc', auto: true }),
  });
  let restored = false;
  for (let i = 0; i < 25 && !restored; i += 1) {
    await sleep(400);
    if (!btn().disabled) restored = true;
  }
  check('推送到达 → 按钮恢复可用', restored, btn().textContent);
  check('成功 toast 含同步来源（已同步（UA · N 个翻译器））', /已同步（/.test(document.getElementById('toast').textContent), document.getElementById('toast').textContent);
  check('提示行回到用法说明', /油猴/.test(hint().textContent), hint().textContent);
  const after = await fetch('/settings').then((r) => r.json());
  check('lastSync 已推进（按钮判据成立）', (((after.settings || {}).lastSync || {}).at || 0) > beforeAt, JSON.stringify((after.settings || {}).lastSync));
  check('同步请求已清位', !(after.settings || {}).authRequest, JSON.stringify((after.settings || {}).authRequest));
  check('状态行显示 token：已同步', /token：已同步/.test(document.getElementById('cred').textContent), document.getElementById('cred').textContent);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
