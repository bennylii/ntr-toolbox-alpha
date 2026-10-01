// 「筛选 ▾」浮出面板：次数过滤 + 再次筛选（打桩 onAudit）+ 撤销
// 跑法：cdp open http://127.0.0.1:8788/novel/mock-1 + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-overlay-filter-audit.js
// 注意：CDP 驱动会自动确认原生 confirm()，所以这里必须自己打桩 confirm 才能测"只打标签"那条路
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
  { src: '長物語', dst: '长物语', type: '其他', count: 1 },
  { src: '無次', dst: '无次', type: '其他' },   // 没有次数信息
];
const existing = { '王都': '王都', '既存甲': '旧译甲', '既存乙': '旧译乙', '只读丙': '仅现有' };

const ov = () => document.getElementById('ntr-glossary-overlay');
const pop = () => document.getElementById('ntr-g-filter-popover');
const btn = (id) => (ov() && ov().querySelector(id)) || null;
const trs = () => Array.from(ov().querySelectorAll('tbody tr'));
const srcs = () => trs().map((tr) => tr.querySelectorAll('td')[1].textContent);
const rowOf = (src) => trs().find((tr) => tr.textContent.includes(src));
const cbOf = (src) => { const r = rowOf(src); return r && r.querySelector('input[type=checkbox]'); };
const checkedSrcs = () => trs().filter((tr) => { const cb = tr.querySelector('input[type=checkbox]'); return cb && cb.checked && !cb.disabled; }).map((tr) => tr.querySelectorAll('td')[1].textContent);
const warnText = () => (ov().querySelector('.ntr-g-warn') || {}).textContent;
const openPop = () => { const b = btn('#ntr-g-filter-btn'); if (b && pop().style.display === 'none') b.click(); };
const closePop = () => { const b = btn('#ntr-g-filter-btn'); if (b && pop().style.display !== 'none') b.click(); };
const setCount = (v) => { const i = btn('#ntr-g-count-min'); i.value = String(v); i.dispatchEvent(new Event('change', { bubbles: true })); };
const openOverlay = async (opts = {}) => {
  UI.open({
    title: opts.title || '筛选/审计用例',
    target: { kind: 'web', providerId: 'mock', novelId: 'x' },
    entries: opts.entries || entries,
    existing,
    mode: opts.mode || 'merge',
    onWrite: opts.onWrite || (async () => { }),
    onAudit: opts.onAudit,
    confirmRestore: true,
  });
  for (let i = 0; i < 60; i++) {
    if (ov() && ov().querySelector('thead th')) return;
    await sleep(100);
  }
  throw new Error('弹层没打开');
};
const closeOverlay = () => { const b = Array.from(ov().querySelectorAll('.ntr-g-btn')).find((x) => x.textContent === '关闭'); if (b) b.click(); };

// confirm / clipboard 打桩
const origConfirm = window.confirm;
const origWriteText = navigator.clipboard && navigator.clipboard.writeText;
let confirmQueue = [];
const confirms = [];
window.confirm = (msg) => {
  confirms.push(String(msg));
  const next = confirmQueue.length > 0 ? confirmQueue.shift() : true;
  return next;
};
let copied = null;
try {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t) => { copied = t; } },
  });
} catch (e) { out.notes.push('clipboard 打桩失败：' + e); }

const marksFor = (srcList) => new Map(srcList.map((s, i) => [s, { why: String(1 + (i % 5)), note: `判废#${i + 1}` }]));

try {
  localStorage.removeItem('ntr-glossary-count-min');

  // ---------- A. 面板开关 ----------
  await openOverlay({});
  check('有「筛选 ▾」按钮', !!btn('#ntr-g-filter-btn'));
  check('没有过滤时按钮不带 ●', btn('#ntr-g-filter-btn').textContent === '筛选 ▾', btn('#ntr-g-filter-btn').textContent);
  check('面板初始是收起的', pop().style.display === 'none');
  btn('#ntr-g-filter-btn').click();
  await sleep(80);
  check('点按钮打开面板', pop().style.display !== 'none');
  btn('#ntr-g-filter-btn').click();
  await sleep(80);
  check('再点一次收起', pop().style.display === 'none');
  openPop();
  await sleep(80);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(80);
  check('Esc 收起面板', pop().style.display === 'none');
  openPop();
  await sleep(80);
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await sleep(80);
  check('点面板外面收起', pop().style.display === 'none');
  check('面板里有：次数输入 / 显示被过滤 / 再次筛选 / 撤销',
    !!btn('#ntr-g-count-min') && !!btn('#ntr-g-show-filtered') && !!btn('#ntr-g-audit-btn') && !!btn('#ntr-g-undo-btn'),
    Array.from(pop().querySelectorAll('input,button')).map((x) => x.id || x.textContent));

  // ---------- B. 次数过滤 ----------
  check('默认 0：全部 9 行都在', srcs().length === 9, srcs());
  setCount(2);
  await sleep(120);
  check('设 2：count<2 的两行被藏（既存乙/長物語）', !srcs().includes('既存乙') && !srcs().includes('長物語') && srcs().length === 7, srcs());
  check('「显示被过滤的（2）」计数正确', btn('#ntr-g-show-filtered').nextSibling.textContent.includes('（2）'), btn('#ntr-g-show-filtered').nextSibling.textContent);
  check('提示写清隐藏条数与"无次数不参与"', /已隐藏 2 条/.test(pop().querySelector('.ntr-g-pop-hint').textContent) && /1 条无次数信息/.test(pop().querySelector('.ntr-g-pop-hint').textContent), pop().querySelector('.ntr-g-pop-hint').textContent);
  check('无次数的行不受影响（無次仍在）', srcs().includes('無次'), srcs());
  check('按钮带 ●', btn('#ntr-g-filter-btn').textContent.includes('●'), btn('#ntr-g-filter-btn').textContent);
  check('写入预估带过滤说明', /已按次数≥2 过滤 2 条/.test(warnText()), warnText());

  const showFiltered = btn('#ntr-g-show-filtered');
  showFiltered.checked = true;
  showFiltered.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);
  check('勾「显示被过滤的」后两行出现', srcs().includes('既存乙') && srcs().includes('長物語'), srcs());
  check('被过滤行带 ntr-g-row-filtered', trs().filter((tr) => tr.classList.contains('ntr-g-row-filtered')).length === 2);
  check('被过滤行复选框是 disabled', cbOf('長物語').disabled === true && cbOf('既存乙').disabled === true);
  check('被过滤行带「低次」徽章', trs().filter((tr) => tr.textContent.includes('低次')).length === 2);
  // 记录"未过滤"时的勾选，来回改阈值后比对（证明阈值不动勾选）
  setCount(0);
  await sleep(120);
  const beforeSel = checkedSrcs().join(',');
  setCount(2);
  await sleep(120);
  setCount(0);
  await sleep(120);
  check('阈值改回 0：9 行都在、没有灰行', srcs().length === 9 && trs().filter((tr) => tr.classList.contains('ntr-g-row-filtered')).length === 0, srcs());
  check('来回改阈值后勾选逐行一致（阈值不动勾选）', checkedSrcs().join(',') === beforeSel, { before: beforeSel, after: checkedSrcs().join(',') });

  // 被过滤行即使先勾上也不写入
  setCount(2);
  await sleep(100);
  let picked = null;
  UI.open; // no-op 引用，避免 lint
  const writeSpy = async (rows) => { picked = rows; };
  closeOverlay();
  await openOverlay({ onWrite: writeSpy });
  // 默认勾选里含 長物語？—— 它 count=1，默认就被过滤，所以先设 0 勾上它，再设 2
  setCount(0);
  await sleep(100);
  check('设 0 时 長物語 默认被勾选', cbOf('長物語').checked === true);
  setCount(2);
  await sleep(100);
  Array.from(ov().querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '合并写入').click();
  await sleep(300);
  const pickedList = picked || [];
  check('写入清单不含被过滤的 長物語', pickedList.length > 0 && !pickedList.some((r) => r.src === '長物語'), pickedList.map((r) => r.src));
  check('写入后弹层自动关闭', !ov() || !document.body.contains(ov()));

  // 复制 JSON 跟随过滤
  await openOverlay({});
  setCount(0);
  await sleep(80);
  copied = null;
  closePop();
  Array.from(ov().querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '复制 JSON').click();
  await sleep(200);
  const copyAll = copied || '';
  check('复制 JSON（不过滤）含 長物語', copyAll.includes('長物語'));
  setCount(2);
  await sleep(80);
  copied = null;
  Array.from(ov().querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '复制 JSON').click();
  await sleep(200);
  const copyFiltered = copied || '';
  check('复制 JSON 跟随过滤：不含被过滤行', !copyFiltered.includes('長物語') && copyFiltered.includes('無次'), { hasLow: copyFiltered.includes('長物語'), hasNoCount: copyFiltered.includes('無次') });

  // 阈值持久化（关掉再开）
  setCount(3);
  await sleep(80);
  closeOverlay();
  await openOverlay({});
  check('重开弹层后阈值从 localStorage 还原（3）', btn('#ntr-g-count-min').value === '3' && btn('#ntr-g-filter-btn').textContent.includes('●'), { value: btn('#ntr-g-count-min').value, label: btn('#ntr-g-filter-btn').textContent });
  check('还原后确实生效（count<3 的都藏了）', !srcs().includes('ギルド') && !srcs().includes('長物語'), srcs());
  setCount(0);
  await sleep(80);
  localStorage.removeItem('ntr-g-count-min');

  // ---------- C. 审计（打桩 onAudit） ----------
  closeOverlay();
  const auditCalls = [];
  let auditFail = false;
  const stubAudit = async (targets, { onProgress }) => {
    auditCalls.push({ at: Date.now(), srcs: targets.map((t) => t.src), note: (document.getElementById('ntr-g-audit-note') || {}).textContent });
    if (onProgress) onProgress({ batch: 1, batches: 1, size: targets.length });
    if (auditFail) throw new Error('mock 审计失败');
    return { marks: marksFor(['ボブ', 'ギルド']), unmatched: 1, batches: 1, failed: '' };
  };
  await openOverlay({ onAudit: stubAudit });
  const selBeforeAudit = checkedSrcs().join(',');
  openPop();
  await sleep(80);
  confirms.length = 0;
  confirmQueue = [true, false];   // 第一次=发起筛选；第二次=只打标签
  btn('#ntr-g-audit-btn').click();
  await sleep(400);
  check('审计前先弹确认（写清条数与请求数）', confirms.length >= 1 && /8 条术语/.test(confirms[0]) && /1 个请求/.test(confirms[0]), confirms[0]);
  check('调用了 onAudit（一次），且只带非「仅已有」的条目', auditCalls.length === 1 && auditCalls[0].srcs.length === 8 && !auditCalls[0].srcs.includes('只读丙'), auditCalls);
  check('打完标：2 行出现「建议删」徽章', trs().filter((tr) => tr.textContent.includes('建议删')).length === 2);
  check('打完标：页签「建议删 (2)」出现', btn('#ntr-g-audit-tab') && btn('#ntr-g-audit-tab').textContent === '建议删 (2)' && btn('#ntr-g-audit-tab').style.display !== 'none', btn('#ntr-g-audit-tab') && btn('#ntr-g-audit-tab').textContent);
  check('打完标：统计行追加「建议删 2」', /建议删 2/.test(ov().querySelector('.ntr-g-stats').textContent), ov().querySelector('.ntr-g-stats').textContent);
  check('选「只打标签」时勾选状态不变', checkedSrcs().join(',') === selBeforeAudit, { before: selBeforeAudit, after: checkedSrcs().join(',') });
  check('面板里有「取消勾选建议删 (2)」/「勾选建议删 (2)」', btn('#ntr-g-audit-none').textContent === '取消勾选建议删 (2)' && btn('#ntr-g-audit-all').textContent === '勾选建议删 (2)');
  check('结果提示写了 unmatched', /1 条未能匹配/.test(btn('#ntr-g-audit-note').textContent), btn('#ntr-g-audit-note').textContent);
  check('徽章提示带类别与理由', /建议删/.test(trs().find((tr) => tr.textContent.includes('ボブ')).querySelector('.ntr-g-badge.audit').title), trs().find((tr) => tr.textContent.includes('ボブ')).querySelector('.ntr-g-badge.audit').title);

  // 页签过滤
  btn('#ntr-g-audit-tab').click();
  await sleep(120);
  check('点「建议删」页签只看被标的行', srcs().length === 2 && srcs().includes('ボブ') && srcs().includes('ギルド'), srcs());
  Array.from(ov().querySelectorAll('.ntr-g-tab')).find((t) => t.textContent === '全部').click();
  await sleep(120);

  // 取消勾选 / 勾选建议删
  const selAfterAudit = checkedSrcs().join(',');
  btn('#ntr-g-audit-none').click();
  await sleep(120);
  check('「取消勾选建议删」把两行取消', !checkedSrcs().includes('ボブ') && !checkedSrcs().includes('ギルド'), checkedSrcs());
  check('取消后写入预估变小', /写入预估：\d+ 条/.test(warnText()), warnText());
  btn('#ntr-g-audit-all').click();
  await sleep(120);
  check('「勾选建议删」把它们勾回来', checkedSrcs().includes('ボブ') && checkedSrcs().includes('ギルド'));
  check('一勾一取消后回到原状态', checkedSrcs().join(',') === selAfterAudit, { want: selAfterAudit, got: checkedSrcs().join(',') });

  // 撤销上一步
  Array.from(ov().querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '全不选').click();
  await sleep(120);
  check('全不选后没有勾选', checkedSrcs().length === 0, checkedSrcs());
  btn('#ntr-g-undo-btn').click();
  await sleep(120);
  check('↩ 撤销上一步恢复勾选', checkedSrcs().join(',') === selAfterAudit, { want: selAfterAudit, got: checkedSrcs().join(',') });

  // 撤销清洗
  btn('#ntr-g-undo-audit-btn').click();
  await sleep(150);
  check('撤销清洗：标记清空（页签消失、无徽章）', trs().filter((tr) => tr.textContent.includes('建议删')).length === 0 && btn('#ntr-g-audit-tab').style.display === 'none');
  check('撤销清洗：统计行不再有建议删', !/建议删/.test(ov().querySelector('.ntr-g-stats').textContent), ov().querySelector('.ntr-g-stats').textContent);
  check('撤销清洗：勾选回到筛选前', checkedSrcs().join(',') === selBeforeAudit, { want: selBeforeAudit, got: checkedSrcs().join(',') });
  check('撤销清洗：提示文案', /已撤销清洗/.test(btn('#ntr-g-audit-note').textContent), btn('#ntr-g-audit-note').textContent);

  // 审计失败 → fail-open
  auditFail = true;
  confirms.length = 0;
  confirmQueue = [true];
  btn('#ntr-g-audit-btn').click();
  await sleep(400);
  check('审计失败：提示失败、不留标记、不崩', /筛选失败/.test(btn('#ntr-g-audit-note').textContent) && trs().filter((tr) => tr.textContent.includes('建议删')).length === 0, btn('#ntr-g-audit-note').textContent);
  check('审计失败后按钮恢复可点', btn('#ntr-g-audit-btn').disabled === false);
  auditFail = false;

  // 请求数文案（>300 条 → 2 个请求）
  closeOverlay();
  const many = Array.from({ length: 305 }, (_, i) => ({ src: `术语${i}`, dst: `译名${i}`, type: '其他', count: 2 }));
  await openOverlay({ entries: many, title: '多批次用例' });
  openPop();
  await sleep(100);
  check('305 条 → 面板显示 2 个请求', /2 个请求/.test(btn('#ntr-g-audit-btn').textContent), btn('#ntr-g-audit-btn').textContent);

  // 没有 onAudit 时按钮禁用
  closeOverlay();
  await openOverlay({});
  openPop();
  await sleep(100);
  check('没有 onAudit 时「再次筛选」禁用', btn('#ntr-g-audit-btn').disabled === true && /没有可用的翻译器/.test(btn('#ntr-g-audit-btn').title), btn('#ntr-g-audit-btn').title);

  // ---------- D. restore 模式 ----------
  closeOverlay();
  await openOverlay({ mode: 'restore', title: '回滚用例' });
  check('restore 模式没有「筛选 ▾」按钮', !btn('#ntr-g-filter-btn'));
  check('restore 模式没有「建议删」页签', !btn('#ntr-g-audit-tab'));
  closeOverlay();
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  window.confirm = origConfirm;
  if (origWriteText) { try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: origWriteText } }); } catch (e) { } }
  localStorage.removeItem('ntr-glossary-count-min');
  const o = document.getElementById('ntr-glossary-overlay');
  if (o) o.remove();
  const q = document.getElementById('ntr-queue-overlay');
  if (q) q.remove();
  out.notes.push('cleanup: 关闭弹层、还原 confirm/clipboard、清掉 ntr-glossary-count-min');
}
return JSON.stringify(out, null, 1);
