// 队列预览/合并弹层：表头点击排序 + 类型复选框（全选/全不选）+ 冲突按钮状态文案
// 跑法：cdp open http://127.0.0.1:8788/novel/mock-1 + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-overlay-sort-types.js
// 注意：弹层的原始顺序不是条目顺序 —— computeDiff 会按 状态(add→conflict→same→existing) + 次数降序 排好
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UI = window._NTRGlossaryDev.GlossaryUI;

const entries = [
  { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 3 },
  { src: 'ボブ', dst: '鲍勃', type: '男性人名', count: 10 },
  { src: 'ギルド', dst: '公会', type: '组织', count: 2 },
  { src: '王都', dst: '王都', type: '地名', count: 5 },
  { src: '既存甲', dst: '新译甲', type: '女性人名', count: 8 },
  { src: '既存乙', dst: '新译乙', type: '男性人名', count: 1 },
];
const existing = { '王都': '王都', '既存甲': '旧译甲', '既存乙': '旧译乙', '只读丙': '仅现有' };
const DEFAULT_ORDER = ['ボブ', 'アリス', 'ギルド', '既存甲', '既存乙', '王都', '只读丙'];
const ALL_SRCS = entries.map((e) => e.src).concat('只读丙');

const ov = () => document.getElementById('ntr-g-glossary-overlay') || document.getElementById('ntr-glossary-overlay');
const trs = () => Array.from(ov().querySelectorAll('tbody tr'));
const srcs = () => trs().map((tr) => (tr.querySelectorAll('td')[1] || {}).textContent);
const rowOf = (src) => trs().find((tr) => tr.textContent.includes(src));
const isChecked = (src) => { const r = rowOf(src); const cb = r && r.querySelector('input[type=checkbox]'); return !!(cb && cb.checked); };
const checkedSrcs = () => trs().filter((tr) => { const cb = tr.querySelector('input[type=checkbox]'); return cb && cb.checked; }).map((tr) => tr.querySelectorAll('td')[1].textContent);
const headTh = (label) => Array.from(ov().querySelectorAll('thead th')).find((th) => th.textContent.includes(label));
const typeItem = (type) => {
  const bar = ov().querySelector('.ntr-g-types');
  return bar ? Array.from(bar.querySelectorAll('.ntr-g-type-item')).find((el) => el.textContent.includes(type)) : null;
};
const warnText = () => (ov().querySelector('.ntr-g-warn') || {}).textContent;

try {
  UI.open({ title: '排序/类型用例', target: { kind: 'web', providerId: 'mock', novelId: 'x' }, entries, existing, mode: 'merge', onWrite: async () => { } });
  await sleep(400);
  check('弹层打开', !!ov(), null);

  // A) 表头点击排序
  check('表头带排序样式（原文/提取译文/次数/类型/现有译文/状态）',
    ['原文', '提取译文', '次数', '类型', '现有译文', '状态'].every((t) => headTh(t) && headTh(t).classList.contains('ntr-g-sortable')),
    Array.from(ov().querySelectorAll('thead th')).map((th) => th.textContent.trim()));
  check('默认顺序 = 状态分组 + 次数降序（原样）', JSON.stringify(srcs()) === JSON.stringify(DEFAULT_ORDER), srcs());

  const jaSort = (list, dir) => list.slice().sort((a, b) => { const c = a.localeCompare(b, 'ja'); return dir === -1 ? -c : c; });
  headTh('原文').click(); await sleep(150);
  check('点「原文」→ 升序 + ▲', JSON.stringify(srcs()) === JSON.stringify(jaSort(ALL_SRCS, 1)) && /▲/.test(headTh('原文').textContent), { srcs: srcs(), mark: headTh('原文').textContent.trim() });
  headTh('原文').click(); await sleep(150);
  check('再点一次 → 降序 + ▼', JSON.stringify(srcs()) === JSON.stringify(jaSort(ALL_SRCS, -1)) && /▼/.test(headTh('原文').textContent), { srcs: srcs(), mark: headTh('原文').textContent.trim() });
  headTh('原文').click(); await sleep(150);
  check('第三次 → 回原始顺序、标记清掉', JSON.stringify(srcs()) === JSON.stringify(DEFAULT_ORDER) && !/[▲▼]/.test(headTh('原文').textContent), { srcs: srcs(), mark: headTh('原文').textContent.trim() });

  headTh('次数').click(); await sleep(150);
  check('「次数」升序是数字序（无次数=0 排最前）',
    JSON.stringify(srcs()) === JSON.stringify(['只读丙', '既存乙', 'ギルド', 'アリス', '王都', '既存甲', 'ボブ']), srcs());
  headTh('次数').click(); await sleep(150);
  check('「次数」降序', srcs()[0] === 'ボブ' && srcs()[6] === '只读丙', srcs());
  headTh('次数').click(); await sleep(150);

  headTh('类型').click(); await sleep(150);
  check('「类型」排序（空类型排最前）', srcs()[0] === '只读丙' && srcs().includes('ギルド'), srcs());
  headTh('类型').click(); await sleep(150);
  headTh('类型').click(); await sleep(150);

  headTh('状态').click(); await sleep(150);
  check('「状态」排序 = 新增→冲突→相同→仅已有（组内保持原顺序）', JSON.stringify(srcs()) === JSON.stringify(DEFAULT_ORDER), srcs());
  headTh('状态').click(); await sleep(150);
  headTh('状态').click(); await sleep(150);

  // B) 类型复选框
  const bar = ov().querySelector('.ntr-g-types');
  check('有类型复选框那一行', !!bar, bar && bar.textContent.trim().slice(0, 90));
  check('四种类型都在，带条数', ['女性人名 2', '男性人名 2', '组织 1', '地名 1'].every((t) => bar.textContent.includes(t)),
    Array.from(bar.querySelectorAll('.ntr-g-type-item')).map((el) => el.textContent.trim()));
  check('仅已有的行没有类型、不进类型统计', !bar.textContent.includes('只读丙') && !bar.textContent.includes('（无类型）'), bar.textContent.trim());
  check('默认勾选 = 全部新增（3 条）', JSON.stringify(checkedSrcs().sort()) === JSON.stringify(['アリス', 'ギルド', 'ボブ'].sort()), checkedSrcs());

  const femaleCb = typeItem('女性人名').querySelector('input');
  femaleCb.checked = true; femaleCb.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  check('勾「女性人名」→ 该类型两条都勾上（含冲突那条）', isChecked('アリス') && isChecked('既存甲'), checkedSrcs());
  check('勾选后该类型复选框是「全选」态', typeItem('女性人名').querySelector('input').checked === true, null);

  const bobCb = rowOf('ボブ').querySelector('input[type=checkbox]');
  bobCb.checked = false; bobCb.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  ((row) => { })(null);
  check('手动取消一条「男性人名」→ 该类型复选框变半选', typeItem('男性人名').querySelector('input').indeterminate === true, null);

  Array.from(bar.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '各类型全不选').click(); await sleep(200);
  check('「各类型全不选」→ 一条都不勾', checkedSrcs().length === 0, checkedSrcs());
  Array.from(bar.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '各类型全选').click(); await sleep(200);
  check('「各类型全选」→ 勾上 新增+冲突+相同 共 6 条（「仅已有」不勾）',
    JSON.stringify(checkedSrcs().sort()) === JSON.stringify(['アリス', 'ギルド', 'ボブ', '既存甲', '既存乙', '王都'].sort()), checkedSrcs());

  // 搜索与类型复选框叠加：只影响可见行，且类型条数显示「可见/总数」
  const search = ov().querySelector('input[type=text]');
  search.value = 'ア'; search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);
  check('搜索后只渲染可见行', JSON.stringify(srcs()) === JSON.stringify(['アリス']), srcs());
  check('类型条数变成「可见/总数」', typeItem('女性人名').textContent.includes('女性人名 1/2') && typeItem('男性人名').textContent.includes('男性人名 0/2'), { female: typeItem('女性人名').textContent, male: typeItem('男性人名').textContent });
  check('未选中的类型在收窄后可点击全选（男性人名 0/2 是空集 → 勾不上）', typeItem('男性人名').querySelector('input').checked === false, null);
  search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);
  check('清空搜索后类型条数回到总数', typeItem('女性人名').textContent.includes('女性人名 2'), typeItem('女性人名').textContent);

  // C) 冲突按钮状态文案 + 真正影响「写入预估」
  const cBtn = ov().querySelector('#ntr-g-conflict-btn');
  check('冲突按钮写明「现在」的状态', cBtn && /现在「保留现有」/.test(cBtn.textContent), cBtn && cBtn.textContent);
  check('保留现有：写入预估只算新增（3 条，冲突不写）', /写入预估：3 条/.test(warnText()), warnText());
  cBtn.click(); await sleep(200);
  check('点一下 → 「采用新提取」并自动勾上冲突行', /现在「采用新提取」/.test(cBtn.textContent) && isChecked('既存甲') && isChecked('既存乙'), { text: cBtn.textContent, checked: checkedSrcs() });
  check('采用新提取：写入预估变成 5 条（新增 3 + 冲突 2）', /写入预估：5 条/.test(warnText()), warnText());
  cBtn.click(); await sleep(200);
  check('再点一下 → 回「保留现有」并取消冲突行', /现在「保留现有」/.test(cBtn.textContent) && !isChecked('既存甲') && !isChecked('既存乙'), { text: cBtn.textContent, checked: checkedSrcs() });
  check('回到保留现有：写入预估回到 3 条', /写入预估：3 条/.test(warnText()), warnText());
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  const el = ov();
  if (el) el.remove();
  out.notes.push('cleanup: 弹层已关闭（只在弹层里点，没写入任何东西）');
}
return JSON.stringify(out, null, 1);
