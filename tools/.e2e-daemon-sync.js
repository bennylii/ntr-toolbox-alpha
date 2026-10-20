// 「Daemon 连接」：模块注册 + /ping 探测 + 站点会话凭据（web-kit:session:v1 → auth-v2 → auth 回落链）/翻译器推送 + 状态行/角标（对测试 stub，端口 7343）
// 跑法（两步）：
//   1) 起 stub：node tools/.run-daemon-stub.mjs
//   2) cdp open http://127.0.0.1:8790/novel/mock-src + inject 后 evalf 本文件
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toastTexts = [];
const mo = new MutationObserver((muts) => {
  muts.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.classList && n.classList.contains('ntr-notification-message')) toastTexts.push(n.textContent);
  }));
});
mo.observe(document.body, { childList: true, subtree: true });

const setSetting = (mod, name, value) => { const s = mod.settings.find((x) => x.name === name); if (s) s.value = value; return s; };

try {
  const box = window._NTRToolBox;
  const mod = (box.configuration.modules || []).find((m) => m.name === 'Daemon 连接');
  check('模块「Daemon 连接」已注册（地址 + 自动同步 + 连接状态行）', !!mod && ['Daemon 地址', '自动同步', '连接状态'].every((n) => (mod.settings || []).some((s) => s.name === n)), mod && (mod.settings || []).map((s) => s.name));

  const origAuth = localStorage.getItem('auth-v2');
  const origAddr = mod ? (mod.settings.find((s) => s.name === 'Daemon 地址') || {}).value : '';
  const origGpt = localStorage.getItem('workspace-gpt');
  const origPipe = localStorage.getItem('workspace-gpt-pipeline');
  localStorage.setItem('auth-v2', JSON.stringify({ token: 'e2e-token-123' }));
  setSetting(mod, 'Daemon 地址', 'http://127.0.0.1:7343');

  // 0) 推送只带新工作区（workspace-gpt-pipeline）：旧仓 workers 已退役
  localStorage.setItem('workspace-gpt-pipeline', JSON.stringify({ workers: [{ id: 'pipe-only', endpoint: 'http://127.0.0.1:8788/v1', model: 'm' }], jobs: [], uncompletedJobs: [] }));
  localStorage.setItem('workspace-gpt', JSON.stringify({ workers: [{ id: 'legacy-only', endpoint: 'http://127.0.0.1:8788/v1', model: 'm' }], jobs: [], uncompletedJobs: [] }));
  await mod.run(mod);
  await sleep(500);
  const seedPush = await fetch('http://127.0.0.1:7343/last').then((r) => r.json()).catch(() => null);
  const pushedIds = (seedPush && seedPush.workers || []).map((w) => w && w.id);
  check('推送只含 pipeline 翻译器，旧仓 workers 不上行',
    pushedIds.includes('pipe-only') && !pushedIds.includes('legacy-only'), pushedIds);

  // 1) 成功路径：ping → 推送 → 状态行更新
  await mod.run(mod);
  await sleep(700);
  check('成功通知出现（带 stub 版本）', toastTexts.some((t) => /已同步到 Daemon/.test(t) && /v0\.0\.0-stub/.test(t)), toastTexts);
  const last = await fetch('http://127.0.0.1:7343/last').then((r) => r.json()).catch(() => null);
  check('stub 收到 auth-v2 token', !!last && last.token === 'e2e-token-123', last && last.token);
  check('stub 收到工作区翻译器数组', !!last && Array.isArray(last.workers), last && last.workers);
  check('stub 收到站点 origin', !!last && typeof last.origin === 'string' && last.origin.startsWith('http'), last && last.origin);
  const statusText = (mod.settings.find((s) => s.name === '连接状态') || {}).value || '';
  check('连接状态行更新为 在线+已同步', /在线 v0\.0\.0-stub · 已同步/.test(statusText), statusText);

  // 2) 离线路径：地址指向无服务端口 → 错误通知 + 状态行离线
  toastTexts.length = 0;
  setSetting(mod, 'Daemon 地址', 'http://127.0.0.1:7999');
  await mod.run(mod);
  await sleep(500);
  check('离线通知出现', toastTexts.some((t) => /daemon 不可达/.test(t)), toastTexts);
  check('状态行置为 离线', ((mod.settings.find((s) => s.name === '连接状态') || {}).value || '') === '离线', (mod.settings.find((s) => s.name === '连接状态') || {}).value);

  // 3) 面板重建：状态行 span（data-role=daemon-status）与行尾角标存在
  const statusSpan = document.querySelector('[data-role="daemon-status"]');
  check('设置面板里有连接状态 span（data-role）', !!statusSpan, !!statusSpan && statusSpan.textContent);
  const glance = box.daemonGlanceEl || document.querySelector('.ntr-daemon-glance');
  check('行尾 daemon 角标存在（glance 已挂）', !!glance || typeof box.refreshDaemonGlance === 'function', !!box.daemonGlanceEl);

  // 4) 自动同步：指纹未变零推送 → token 变化自动重推（auto 标记）→ 再次 tick 不重复
  setSetting(mod, 'Daemon 地址', 'http://127.0.0.1:7343');
  setSetting(mod, '自动同步', true);
  await fetch('http://127.0.0.1:7343/reset', { method: 'POST' });
  toastTexts.length = 0;
  box.refreshDaemonGlance(true);
  await sleep(1500);
  const c0 = await fetch('http://127.0.0.1:7343/last').then((r) => r.json());
  check('指纹未变 → 自动 tick 零推送（去重）', c0.__count === 0, c0.__count);
  localStorage.setItem('auth-v2', JSON.stringify({ token: 'e2e-token-auto-1' }));
  box.refreshDaemonGlance(true);
  let pushed = null;
  for (let i = 0; i < 20 && !pushed; i += 1) {
    await sleep(300);
    const c = await fetch('http://127.0.0.1:7343/last').then((r) => r.json());
    if (c.__count >= 1) pushed = c;
  }
  check('token 变化 → 自动重推（auto 标记 + 新 token）', !!pushed && pushed.token === 'e2e-token-auto-1' && pushed.auto === true, pushed);
  check('自动更新提示出现', toastTexts.some((t) => /凭据已自动更新/.test(t)), toastTexts);
  toastTexts.length = 0;
  box.refreshDaemonGlance(true);
  await sleep(1500);
  const c2 = await fetch('http://127.0.0.1:7343/last').then((r) => r.json());
  check('再次 tick 不重复推送（指纹已更新）', c2.__count === 1, c2.__count);

  // 5) 控制台「从站点同步」请求：/ping.pendingAuth → 指纹不变也强制推一次（推完 stub 清位）
  await fetch('http://127.0.0.1:7343/reset', { method: 'POST' });
  toastTexts.length = 0;
  box.refreshDaemonGlance(true);
  await sleep(1200);
  const d0 = await fetch('http://127.0.0.1:7343/last').then((r) => r.json());
  check('前置：指纹未变 → 无标志时仍零推送', d0.__count === 0, d0.__count);
  await fetch('http://127.0.0.1:7343/request-auth', { method: 'POST' });
  box.refreshDaemonGlance(true);
  let forced = null;
  for (let i = 0; i < 20 && !forced; i += 1) {
    await sleep(300);
    const c = await fetch('http://127.0.0.1:7343/last').then((r) => r.json());
    if (c.__count >= 1) forced = c;
  }
  check('控制台请求 → 指纹不变也强制推一次（auto 标记）', !!forced && forced.auto === true && forced.token === 'e2e-token-auto-1', forced && forced.token);
  check('强制推送提示出现（已按控制台请求同步）', toastTexts.some((t) => /已按控制台请求同步/.test(t)), toastTexts);
  toastTexts.length = 0;
  box.refreshDaemonGlance(true);
  await sleep(1500);
  const d2 = await fetch('http://127.0.0.1:7343/last').then((r) => r.json());
  check('标志已被推送清掉 → 再次 tick 不重复', d2.__count === 1, d2.__count);

  // 6) 会话键回落链（站点 2026-10 起用 web-kit:session:v1，见 docs/upstream-sync.md ①）：
  //    新键单独存在 → 读到它；新旧并存 → 新键优先；只剩历史 auth → 仍能读
  localStorage.removeItem('ntr-daemon-auth-fp');
  const origWk = localStorage.getItem('web-kit:session:v1');
  const origLegacy = localStorage.getItem('auth');
  const syncOnce = async () => {
    await fetch('http://127.0.0.1:7343/reset', { method: 'POST' });
    await mod.run(mod);
    for (let i = 0; i < 20; i += 1) {
      await sleep(200);
      const c = await fetch('http://127.0.0.1:7343/last').then((r) => r.json());
      if (c.__count >= 1) return c;
    }
    return null;
  };
  localStorage.removeItem('auth-v2');
  localStorage.setItem('web-kit:session:v1', JSON.stringify({ token: 'e2e-token-wk-1', adminMode: false }));
  check('新键 web-kit:session:v1 单独存在 → initToken 读到', box.initToken() === 'e2e-token-wk-1', box.initToken());
  const s1 = await syncOnce();
  check('推送用的是新键里的 token', !!s1 && s1.token === 'e2e-token-wk-1', s1 && s1.token);

  localStorage.setItem('auth-v2', JSON.stringify({ token: 'e2e-token-legacy-2' }));
  check('新旧并存 → 新键优先', box.initToken() === 'e2e-token-wk-1', box.initToken());
  localStorage.removeItem('web-kit:session:v1');
  check('新键消失 → 回落 auth-v2', box.initToken() === 'e2e-token-legacy-2', box.initToken());
  localStorage.removeItem('auth-v2');
  localStorage.setItem('auth', JSON.stringify({ profile: { token: 'e2e-token-ancient-3' } }));
  check('只剩历史 auth → 读 profile.token', box.initToken() === 'e2e-token-ancient-3', box.initToken());
  localStorage.setItem('auth-v2', JSON.stringify({ token: 'e2e-token-auto-1' }));
  localStorage.removeItem('auth');
  if (origWk === null) localStorage.removeItem('web-kit:session:v1'); else localStorage.setItem('web-kit:session:v1', origWk);
  if (origLegacy === null) localStorage.removeItem('auth'); else localStorage.setItem('auth', origLegacy);

  // 还原种子数据
  localStorage.removeItem('ntr-daemon-auth-fp');
  if (origAuth === null) localStorage.removeItem('auth-v2'); else localStorage.setItem('auth-v2', origAuth);
  if (origGpt === null) localStorage.removeItem('workspace-gpt'); else localStorage.setItem('workspace-gpt', origGpt);
  if (origPipe === null) localStorage.removeItem('workspace-gpt-pipeline'); else localStorage.setItem('workspace-gpt-pipeline', origPipe);
  if (mod) setSetting(mod, 'Daemon 地址', origAddr);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  mo.disconnect();
  out.notes.push('cleanup: 会话键（web-kit:session:v1 / auth-v2 / auth）、工作区键与 Daemon 地址已还原');
}
return JSON.stringify(out, null, 1);
