// 「Daemon 连接」：模块注册 + /ping 探测 + auth-v2 凭据/翻译器推送 + 状态行/角标（对测试 stub，端口 7343）
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
  check('模块「Daemon 连接」已注册（Daemon 地址 + 连接状态行）', !!mod && (mod.settings || []).some((s) => s.name === 'Daemon 地址') && (mod.settings || []).some((s) => s.name === '连接状态'), mod && (mod.settings || []).map((s) => s.name));

  const origAuth = localStorage.getItem('auth-v2');
  const origAddr = mod ? (mod.settings.find((s) => s.name === 'Daemon 地址') || {}).value : '';
  localStorage.setItem('auth-v2', JSON.stringify({ token: 'e2e-token-123' }));
  setSetting(mod, 'Daemon 地址', 'http://127.0.0.1:7343');

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

  // 还原种子数据
  if (origAuth === null) localStorage.removeItem('auth-v2'); else localStorage.setItem('auth-v2', origAuth);
  if (mod) setSetting(mod, 'Daemon 地址', origAddr);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  mo.disconnect();
  out.notes.push('cleanup: auth-v2 与 Daemon 地址已还原');
}
return JSON.stringify(out, null, 1);
