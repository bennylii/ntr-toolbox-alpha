// 端到端：本地卷 提取 -> 预览（或写入）流程；收集通知/异常/结果
const out = { notifications: [], dialogsHandled: 0, errors: [] };
window.addEventListener('unhandledrejection', (e) => out.errors.push('unhandledrejection: ' + (e.reason && (e.reason.message || e.reason))));
window.addEventListener('error', (e) => out.errors.push('error: ' + e.message));

const clickText = (want) => {
  const els = [...document.querySelectorAll('button, .ntr-g-btn, .ntr-g-tab, .ntr-module-header, span, div')];
  const el = els.find((e) => e.textContent.trim() === want);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 清除旧界面
document.querySelectorAll('#ntr-glossary-overlay, #ntr-glossary-status').forEach((e) => e.remove());

window._NTRToolBox.runModule('AI提取术语表');

// 若出现选择器，点“选择”
let clickedPicker = false;
for (let i = 0; i < 20 && !clickedPicker; i++) {
  await sleep(100);
  const picker = document.getElementById('ntr-glossary-overlay');
  if (picker && picker.innerText.includes('选择本地卷')) {
    clickedPicker = clickText('选择');
  }
}
out.clickedPicker = clickedPicker;

// 轮询直到 overlay（预览）出现或超时
let overlaySeen = null;
for (let i = 0; i < 120; i++) {
  await sleep(250);
  [...document.querySelectorAll('.ntr-notification-message')].forEach((n) => {
    const text = n.textContent.trim();
    if (!out.notifications.includes(text)) out.notifications.push(text);
  });
  const o = document.getElementById('ntr-glossary-overlay');
  const st = document.getElementById('ntr-glossary-status');
  if (o && o.querySelector('.ntr-g-stats')) {
    overlaySeen = {
      title: o.querySelector('.ntr-g-title').textContent,
      stats: o.querySelector('.ntr-g-stats').textContent,
      rows: o.querySelectorAll('tbody tr').length,
      warn: o.querySelector('.ntr-g-warn').textContent.trim(),
    };
    break;
  }
  if (!st && !o && i > 8) break; // 状态窗和 overlay 都没了，说明提前结束
}
out.overlay = overlaySeen;
return JSON.stringify(out, null, 2);
