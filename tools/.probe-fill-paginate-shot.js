// 截图助手：展开面板（若已收起）→ 打开「填充术语表」设置面板（可见新设置 自动翻页至末页 / 翻页上限），配合
//   node tools/cdp.mjs open http://127.0.0.1:8788/novel/mock/mock-src + inject 后
//   node tools/cdp.mjs evalf tools/.probe-fill-paginate-shot.js && node tools/cdp.mjs shot <out.png>
const panel = document.querySelector('#ntr-panel');
if (!panel) return JSON.stringify({ ok: false, err: '面板不存在（先 cdp inject）' });
if (panel.classList.contains('minimized')) {
    panel.querySelector('.ntr-titlebar span').click();
    await new Promise((r) => setTimeout(r, 150));
}
// 离线页 domainAllowed=false → 轮询的 updateModuleVisibility 会把所有模块行藏掉；截图前停掉它并强制显示本行
window._NTRToolBox.updateModuleVisibility = () => {};
const header = [...document.querySelectorAll('#ntr-panel .ntr-module-header')].find((h) => h.textContent.includes('填充术语表'));
if (!header) return JSON.stringify({ ok: false, err: '未找到 填充术语表 模块头' });
header.parentElement.style.display = 'block';
header.scrollIntoView({ block: 'center' });
const sd = header.parentElement.querySelector('.ntr-settings-container');
if (sd.style.display === 'none') {
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));
    await new Promise((r) => setTimeout(r, 200));
}
const rows = [...sd.querySelectorAll('input, textarea, select')].map((e) => `${e.dataset.settingName || e.name || '?'}:${e.type || e.tagName}`);
return JSON.stringify({ ok: sd.style.display !== 'none', inputs: rows });
