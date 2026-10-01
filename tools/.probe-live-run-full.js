// 线上整本跑：把 并发 调高、行数上限归零 → 左键入队 → 队列面板「开始/续跑」
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

  const header = getHeader('AI提取术语表');
  const container = header.closest('.ntr-module-container');
  if (!container.querySelector('.ntr-settings-container')) {
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await new Promise((r) => setTimeout(r, 500));
  }
  const setNum = (name, v) => {
    const el = rowOf(container, new RegExp('^' + name));
    if (!el) return 'not found';
    el.value = String(v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  };
  out['并发'] = setNum('并发', 4);
  out['行数上限'] = setNum('行数上限', 0);
  out['输出上限'] = setNum('输出上限', 0);
  out['临时端点开关'] = (rowOf(container, /^使用临时端点/) || {}).checked;
  out['翻译器'] = (rowOf(container, /^翻译器/) || {}).value;
  out['任务方式'] = (rowOf(container, /^任务方式/) || {}).value;
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  await new Promise((r) => setTimeout(r, 300));

  header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1200));
  out.enqueueNotes = (window.__notes || []).slice(-2);

  getHeader('术语队列').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 900));
  let ov = document.getElementById('ntr-queue-overlay');
  out.panelBefore = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  const startBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '开始/续跑');
  if (startBtn) startBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 2500));
  ov = document.getElementById('ntr-queue-overlay');
  out.panelAfterStart = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  out.glance = (getHeader('术语队列').querySelector('.ntr-module-glance') || {}).textContent;
  const closeBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  if (closeBtn) closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  out.panelClosed = !document.getElementById('ntr-queue-overlay');
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
