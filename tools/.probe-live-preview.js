// 打开队列面板 → 点「预览」看一眼提取结果（只看不写）
const out = {};
try {
  const getHeader = (t) => Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes(t));
  getHeader('术语队列').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 900));
  let ov = document.getElementById('ntr-queue-overlay');
  out.stats = ov && ov.querySelector('.ntr-g-stats') && ov.querySelector('.ntr-g-stats').textContent;
  const rows = ov ? Array.from(ov.querySelectorAll('tr')) : [];
  out.rowCount = rows.length;
  const previewBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '预览');
  out.previewBtn = !!previewBtn;
  if (previewBtn) previewBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1200));
  const rev = document.getElementById('ntr-glossary-overlay');
  out.review = rev ? { title: (rev.querySelector('.ntr-g-title') || {}).textContent, stats: (rev.querySelector('.ntr-g-stats') || {}).textContent } : 'no overlay';
  return JSON.stringify(out, null, 1);
} catch (e) { out.err = String((e && e.stack) || e); return JSON.stringify(out, null, 1); }
