// 只读：量队列工具栏在 1080 宽下是否换行（offsetTop 去重 > 1 = 换行）
// 跑法：cdp open <url> + Emulation.setDeviceMetricsOverride 1080 + inject 后 evalf 本文件
const out = { notes: [], buttons: [], errors: [] };
const measure = () => {
  const bar = document.querySelector('#ntr-queue-overlay .ntr-g-toolbar');
  const btns = Array.from(bar.querySelectorAll('button'));
  const rows = btns.map((b) => ({ t: b.textContent, top: b.offsetTop, w: Math.round(b.getBoundingClientRect().width * 10) / 10 }));
  const tops = new Set(rows.map((b) => b.top));
  return { rows, lines: tops.size, wrap: tops.size > 1, toolbarH: bar.offsetHeight, totalW: Math.round(rows.reduce((a, b) => a + b.w, 0) * 10) / 10 };
};
try {
  const D = window._NTRGlossaryDev;
  const Q = D.GlossaryQueue;
  const old = document.getElementById('ntr-queue-overlay');
  if (old) old.remove();
  await Q.openPanel();
  await new Promise((r) => setTimeout(r, 300));
  const bar = document.querySelector('#ntr-queue-overlay .ntr-g-toolbar');
  out.default = measure();
  out.buttons = out.default.rows;
  out.lines = out.default.lines;
  out.wrap = out.default.wrap;
  out.toolbarH = out.default.toolbarH;
  out.cardW = Math.round(document.querySelector('#ntr-queue-overlay .ntr-g-card').getBoundingClientRect().width);
  out.barInner = Math.round(bar.clientWidth - parseFloat(getComputedStyle(bar).paddingLeft) - parseFloat(getComputedStyle(bar).paddingRight));
  out.totalW = out.default.totalW;
  // 模拟「运行翻译器」选中一个较长 worker（set 后同步量，避免被面板 render 还原）
  const tBtn = Array.from(bar.querySelectorAll('button')).find((b) => b.textContent.startsWith('运行翻译器'));
  tBtn.textContent = '运行翻译器：deepseek-v4-flash ▾';
  out.withWorker = measure();
  // 模拟特别长的 id
  tBtn.textContent = '运行翻译器：very-long-translator-name-here-12345 ▾';
  out.withVeryLong = measure();
  tBtn.textContent = '运行翻译器 ▾';
  out.viewport = { w: window.innerWidth, h: window.innerHeight };
} catch (e) { out.errors.push(String((e && e.stack) || e)); }
return JSON.stringify(out, null, 1);
