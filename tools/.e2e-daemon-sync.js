// 「同步 Daemon」：模块注册 + 把 auth-v2 凭据/翻译器配置推给本地 daemon（对测试 stub，端口 7343）
// 跑法（两步）：
//   1) 起 stub：node -e "..."（见 .e2e-daemon-sync 说明；或直接跑 tools/.run-daemon-stub.mjs）
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
  const mod = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === '同步 Daemon');
  check('模块「同步 Daemon」已注册（含 Daemon 地址设置）', !!mod && (mod.settings || []).some((s) => s.name === 'Daemon 地址'), mod && (mod.settings || []).map((s) => s.name));

  const origAuth = localStorage.getItem('auth-v2');
  const origAddr = mod ? (mod.settings.find((s) => s.name === 'Daemon 地址') || {}).value : '';
  localStorage.setItem('auth-v2', JSON.stringify({ token: 'e2e-token-123' }));
  setSetting(mod, 'Daemon 地址', 'http://127.0.0.1:7343');

  await mod.run(mod);
  await sleep(700);
  check('成功通知出现', toastTexts.some((t) => /已同步到 Daemon/.test(t)), toastTexts);
  const last = await fetch('http://127.0.0.1:7343/last').then((r) => r.json()).catch(() => null);
  check('stub 收到 auth-v2 token', !!last && last.token === 'e2e-token-123', last && last.token);
  check('stub 收到工作区翻译器数组', !!last && Array.isArray(last.workers), last && last.workers);
  check('stub 收到站点 origin', !!last && typeof last.origin === 'string' && last.origin.startsWith('http'), last && last.origin);

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
