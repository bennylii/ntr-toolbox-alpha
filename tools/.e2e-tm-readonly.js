// 真实交付路径验证（篡改猴注入的副本，沙箱内不可访问 _NTRToolBox，只能从页面上下文驱动 DOM）
// 只做只读流程：点模块 → 拖入 KWG output.json → 检查 diff 弹层 → 关闭。绝不点「合并写入」。
const out = { steps: [] };
const waitFor = (pred, ms) => new Promise((resolve) => {
  if (pred()) return resolve(true);
  const obs = new MutationObserver(() => { if (pred()) { obs.disconnect(); resolve(true); } });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { obs.disconnect(); resolve(!!pred()); }, ms);
});
const noteObs = new MutationObserver(() => {
  document.querySelectorAll('.ntr-notification-message').forEach((n) => {
    const t = n.textContent.trim();
    if (!out.notifications) out.notifications = [];
    if (!out.notifications.includes(t)) out.notifications.push(t);
  });
});
noteObs.observe(document.body, { childList: true, subtree: true });

const overlay = () => document.getElementById('ntr-glossary-overlay');
document.querySelectorAll('#ntr-glossary-overlay').forEach((e) => e.remove());

const header = [...document.querySelectorAll('#ntr-panel .ntr-module-header')].find((h) => h.textContent.includes('导入术语表'));
out.foundHeader = !!header;
header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));

out.overlayOpened = await waitFor(() => !!overlay() && !!overlay().querySelector('.ntr-g-stats'), 15000);
const o = overlay();
out.beforeDrop = o ? { title: o.querySelector('.ntr-g-title').textContent, stats: o.querySelector('.ntr-g-stats').textContent, hint: o.querySelector('.ntr-g-warn').textContent, hasPicker: !!o.querySelector('#ntr-g-pick-file') } : null;

// 拖入 KWG 默认 output.json（对象数组，带 type/count）
const payload = JSON.stringify([
  { src: 'テスト昴', dst: '昴译', type: '名詞', count: 7, context: ['前文X'] },
  { src: 'テスト昴壱', dst: '昴一译', type: '人名', count: 2 },
]);
const card = o.querySelector('.ntr-g-card');
const dt = new DataTransfer();
dt.items.add(new File([payload], 'output.json', { type: 'application/json' }));
card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
out.afterDropLoaded = await waitFor(() => {
  const x = overlay();
  return !!(x && /提取 2 条/.test(x.querySelector('.ntr-g-stats').textContent));
}, 8000);
const a = overlay();
out.afterDrop = a ? {
  title: a.querySelector('.ntr-g-title').textContent,
  stats: a.querySelector('.ntr-g-stats').textContent,
  rowData: [...a.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => { const i = td.querySelector('input[type=text]'); return (i ? i.value : td.textContent).trim(); })),
  hint: a.querySelector('.ntr-g-warn').textContent,
  checked: [...a.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length,
  buttons: [...a.querySelectorAll('.ntr-g-foot button')].map((b) => b.textContent.trim()),
} : null;

// 只读收尾：关闭弹层（不点写入）
const closeBtn = [...(overlay() ? overlay().querySelectorAll('.ntr-g-foot button') : [])].find((b) => b.textContent.trim() === '关闭');
out.closed = false;
if (closeBtn) { closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); await new Promise((r) => setTimeout(r, 300)); out.closed = !overlay(); }
out.overlayGone = !overlay();
noteObs.disconnect();
return JSON.stringify(out, null, 1);
