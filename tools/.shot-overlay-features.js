// 给弹层三个新功能拍个图：表头排序标记 + 类型复选框（含 visible/total）+ 冲突按钮当前状态
const UI = window._NTRGlossaryDev.GlossaryUI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entries = [
  { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 3 },
  { src: 'ボブ', dst: '鲍勃', type: '男性人名', count: 10 },
  { src: 'ギルド', dst: '公会', type: '组织', count: 2 },
  { src: '王都', dst: '王都', type: '地名', count: 5 },
  { src: '既存甲', dst: '新译甲', type: '女性人名', count: 8 },
  { src: '既存乙', dst: '新译乙', type: '男性人名', count: 1 },
];
const existing = { '王都': '王都', '既存甲': '旧译甲', '既存乙': '旧译乙', '只读丙': '仅现有' };
UI.open({ title: '排序/类型用例', target: { kind: 'web', providerId: 'mock', novelId: 'x' }, entries, existing, mode: 'merge', onWrite: async () => { } });
let ov = null;
for (let i = 0; i < 60 && !ov; i++) {
  const el = document.getElementById('ntr-g-glossary-overlay') || document.getElementById('ntr-glossary-overlay');
  if (el && el.querySelector('thead th')) ov = el; else await sleep(100);
}
if (!ov) return JSON.stringify({ err: 'overlay not opened' });
const th = (t) => Array.from(ov.querySelectorAll('thead th')).find((x) => x.textContent.includes(t));
th('次数').click(); await sleep(150);   // 按次数降序：▲/▼ 标记 + 顺序变化
const fem = Array.from(ov.querySelectorAll('.ntr-g-type-item')).find((x) => x.textContent.includes('女性人名'));
fem.querySelector('input').click(); await sleep(150);  // 取消「女性人名」→ 视图形变窄，计数显示 可见/总数
return JSON.stringify({
  headerRow: Array.from(ov.querySelectorAll('thead th')).map((x) => x.textContent.trim()),
  typesBar: Array.from(ov.querySelectorAll('.ntr-g-type-item')).map((x) => x.textContent.trim()),
  stats: (ov.querySelector('.ntr-g-stats') || {}).textContent,
  warn: (ov.querySelector('.ntr-g-warn') || {}).textContent,
  conflictBtn: (ov.querySelector('#ntr-g-conflict-btn') || {}).textContent,
}, null, 1);
