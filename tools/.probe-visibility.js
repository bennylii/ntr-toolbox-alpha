// 检查面板里哪些模块可见（隐藏 = .ntr-module-container display:none）
const visible = () => [...document.querySelectorAll('#ntr-panel .ntr-module-container')]
  .filter((c) => c.style.display !== 'none')
  .map((c) => c.querySelector('.ntr-module-header').textContent.trim().replace(/[▶⇋]/g, ''));
const out = { url: location.pathname, visible: visible() };
out.glossaryVisible = out.visible.filter((n) => /术语表|术语队列/.test(n));
// SPA 路由变化：改 pathname 后等轮询（250ms 节流）重新计算可见性
if (window.__probeSpaTarget) {
  history.pushState({}, '', window.__probeSpaTarget);
  await new Promise((r) => setTimeout(r, 900));
  out.afterPush = { url: location.pathname, glossaryVisible: visible().filter((n) => /术语表|术语队列/.test(n)) };
}
return JSON.stringify(out, null, 1);
