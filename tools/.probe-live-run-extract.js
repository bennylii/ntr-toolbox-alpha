// 线上真跑（测试浏览器）：取消勾选「使用临时端点」→ 行数上限=200（试跑范围）→ 左键入队 → 队列面板点「开始/续跑」
const out = {};
const getHeader = (t) => Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes(t));
const rowOf = (container, re) => Array.from(container.querySelectorAll('input,select')).find((el) => {
  const label = el.closest('div') && el.closest('div').querySelector('label');
  return label && re.test(label.textContent);
});
try {
  window.__notes = [];
  const mo = new MutationObserver((muts) => {
    muts.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      if (n.classList && n.classList.contains('ntr-notification-message')) window.__notes.push(n.textContent);
      if (n.querySelectorAll) n.querySelectorAll('.ntr-notification-message').forEach((x) => window.__notes.push(x.textContent));
    }));
  });
  mo.observe(document.body, { childList: true, subtree: true });
  window.__notesMo = mo;

  const header = getHeader('AI提取术语表');
  const container = header.closest('.ntr-module-container');
  if (!container.querySelector('.ntr-settings-container')) {
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await new Promise((r) => setTimeout(r, 500));
  }
  const cb = rowOf(container, /^使用临时端点/);
  if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); out.uncheckedTemp = true; }
  else out.uncheckedTemp = `already off (checked=${cb && cb.checked})`;
  const maxLines = rowOf(container, /^行数上限/);
  if (maxLines) { maxLines.value = '200'; maxLines.dispatchEvent(new Event('change', { bubbles: true })); out.maxLines = maxLines.value; }
  const translator = rowOf(container, /^翻译器/);
  out.translator = translator && translator.value;
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));  // 关设置
  await new Promise((r) => setTimeout(r, 300));

  header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));                    // 入队
  await new Promise((r) => setTimeout(r, 1200));
  out.afterEnqueueNotes = window.__notes.slice();

  getHeader('术语队列').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));      // 开队列面板
  await new Promise((r) => setTimeout(r, 900));
  let ov = document.getElementById('ntr-queue-overlay');
  out.panelBefore = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  const startBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '开始/续跑');
  out.startBtn = !!startBtn;
  if (startBtn) startBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 2500));
  ov = document.getElementById('ntr-queue-overlay');
  out.panelAfterStart = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  const closeBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  if (closeBtn) closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.panelClosed = !document.getElementById('ntr-queue-overlay');
  out.notes = window.__notes.slice();
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
