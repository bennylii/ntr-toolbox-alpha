// 冒烟：「筛选 ▾」面板 + 次数过滤（只看行为，不做断言式回归）
const UI = window._NTRGlossaryDev.GlossaryUI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entries = [
  { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 3 },
  { src: 'ボブ', dst: '鲍勃', type: '男性人名', count: 10 },
  { src: 'ギルド', dst: '公会', type: '组织', count: 2 },
  { src: '王都', dst: '王都', type: '地名', count: 5 },
  { src: '既存甲', dst: '新译甲', type: '女性人名', count: 8 },
  { src: '既存乙', dst: '新译乙', type: '男性人名', count: 1 },
  { src: '無次', dst: '无次', type: '其他', count: undefined },
];
const existing = { '王都': '王都', '既存甲': '旧译甲', '既存乙': '旧译乙', '只读丙': '仅现有' };
localStorage.removeItem('ntr-glossary-count-min');
if (window._NTRGlossaryDev.GlossaryUI._testReset) window._NTRGlossaryDev.GlossaryUI._testReset();
UI.open({ title: '筛选冒烟', target: { kind: 'web', providerId: 'mock', novelId: 'x' }, entries, existing, mode: 'merge', onWrite: async () => { } });
let ov = null;
for (let i = 0; i < 60 && !ov; i++) {
  const el = document.getElementById('ntr-glossary-overlay');
  if (el && el.querySelector('thead th')) ov = el; else await sleep(100);
}
const srcs = () => Array.from(ov.querySelectorAll('tbody tr')).map((tr) => { const td = tr.querySelectorAll('td'); return td[mode_td()] ? td[mode_td()].textContent : ''; });
const mode_td = () => 1;   // merge 模式：勾选列在第 0 列，原文在第 1 列
const out = {};
out.rows0 = srcs();
const btn = ov.querySelector('#ntr-g-filter-btn');
out.btnLabel0 = btn.textContent;
btn.click();
await sleep(100);
const pop = ov.querySelector('#ntr-g-filter-popover');
out.popoverVisible = pop.style.display !== 'none';
const input = ov.querySelector('#ntr-g-count-min');
input.value = '2';
input.dispatchEvent(new Event('change', { bubbles: true }));
await sleep(150);
out.rowsAfter2 = srcs();
out.hint = pop.querySelector('.ntr-g-pop-hint').textContent;
out.showFilteredLabel = pop.querySelector('label span').textContent;
out.warn = ov.querySelector('.ntr-g-warn').textContent;
out.btnLabel2 = btn.textContent;
const cbShow = ov.querySelector('#ntr-g-show-filtered');
cbShow.checked = true;
cbShow.dispatchEvent(new Event('change', { bubbles: true }));
await sleep(150);
out.rowsShowFiltered = srcs();
out.filteredDisabled = Array.from(ov.querySelectorAll('tbody tr.ntr-g-row-filtered input[type=checkbox]')).map((c) => c.disabled);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(100);
out.afterEsc = pop.style.display;
localStorage.removeItem('ntr-glossary-count-min');
return JSON.stringify(out, null, 1);
