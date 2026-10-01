// 「可疑」筛选页签（指南清洗的可视化）+ 调试日志导出
// 跑法：cdp open http://127.0.0.1:8788/novel/mock/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-overlay-suspect-log.js
// 说明：只读 + 打桩，不点「合并写入」；仍然拦截 PUT /glossary 兜底
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origFetch = window.fetch;
const puts = [];
window.fetch = async (url, opts) => {
  if (opts && opts.method === 'PUT' && String(url).includes('/glossary')) { puts.push(String(url)); return new Response('', { status: 200 }); }
  return origFetch(url, opts);
};

try {
  const D = window._NTRGlossaryDev;
  const log = D.GlossaryLog;
  const overlayOf = () => document.getElementById('ntr-glossary-overlay');
  const tabByText = (root, text) => [...root.querySelectorAll('.ntr-g-tab')].find((t) => t.textContent.includes(text));
  const rowSrcs = (root) => [...root.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[1] && tr.querySelectorAll('td')[1].textContent);
  const checkedCount = (root) => [...root.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length;
  const closeOverlay = () => { const o = overlayOf(); if (o) o.remove(); };

  // ---------- A. 弹层「可疑」页签 ----------
  const entries = [
    { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 9 },
    { src: 'なるちゃん', dst: '小鸣', type: '女性人名', count: 7 },
    { src: '道化師のイラストが入っているペン', dst: '带有小丑插画的笔', type: '特殊物品', count: 1 },
    { src: '虹の橋', dst: '彩虹桥', type: '地名', count: 2 },
  ];
  D.GlossaryUI.open({ title: 'e2e 可疑标记', entries, existing: {}, mode: 'merge', onWrite: async () => ({ ok: true }) });
  await sleep(250);
  const overlay = overlayOf();
  check('弹层已打开', !!overlay);
  const suspectTab = overlay.querySelector('#ntr-g-suspect-tab');
  check('出现「可疑」页签，计数 = 2', !!suspectTab && suspectTab.style.display !== 'none' && /可疑 \(2\)/.test(suspectTab.textContent), suspectTab && suspectTab.textContent);
  check('统计行仍按原样显示提取条数', /提取 4 条/.test(overlay.querySelector('.ntr-g-stats').textContent), overlay.querySelector('.ntr-g-stats').textContent);

  const all = rowSrcs(overlay);
  check('默认显示全部 4 行', all.length === 4, all.join('|'));
  const badge = (src) => {
    const tr = [...overlay.querySelectorAll('tbody tr')].find((row) => row.querySelectorAll('td')[1] && row.querySelectorAll('td')[1].textContent === src);
    return tr ? tr.querySelector('.ntr-g-badge.suspect') : null;
  };
  check('长的复合短语带「可疑」徽章（原因：过长/像短语）', /过长/.test((badge('道化師のイラストが入っているペン') || {}).title || ''), (badge('道化師のイラストが入っているペン') || {}).title);
  check('昵称带「可疑」徽章（原因：带敬称）', /带敬称/.test((badge('なるちゃん') || {}).title || ''), (badge('なるちゃん') || {}).title);
  check('普通人名没有徽章', !badge('アリス'));
  check('短的「の」地名没有徽章', !badge('虹の橋'));

  const beforeChecked = checkedCount(overlay);
  check('默认勾选了 4 条新增', beforeChecked === 4, beforeChecked);
  suspectTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  await sleep(120);
  const filtered = rowSrcs(overlay);
  check('点「可疑」只剩 2 行', filtered.length === 2, filtered.join('|'));
  check('剩下的就是那两条可疑条目', filtered.includes('なるちゃん') && filtered.some((s) => /道化師/.test(s)), filtered.join('|'));
  // 注意：只渲染筛出来的行，所以「勾选数」必须在切回「全部」之后再看
  const allTab = tabByText(overlay, '全部');
  allTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  await sleep(120);
  check('切回「全部」恢复 4 行', rowSrcs(overlay).length === 4);
  check('筛选只影响显示，不动勾选', checkedCount(overlay) === beforeChecked, checkedCount(overlay));

  closeOverlay();
  // 没有可疑条目时不出现该页签
  D.GlossaryUI.open({ title: 'e2e 无可疑', entries: [{ src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 3 }], existing: {}, mode: 'merge', onWrite: async () => ({}) });
  await sleep(250);
  const o2 = overlayOf();
  const tab2 = o2.querySelector('#ntr-g-suspect-tab');
  check('没有可疑条目时页签隐藏', !!tab2 && tab2.style.display === 'none', tab2 && tab2.style.display);
  closeOverlay();

  // ---------- B. 调试日志 ----------
  const setDebug = (v) => {
    const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === 'AI提取术语表');
    mod.settings.find((s) => s.name === '调试日志').value = v;
  };
  check('「调试日志」设置存在', (() => { try { const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === 'AI提取术语表'); return !!mod.settings.find((s) => s.name === '调试日志'); } catch (e) { return false; } })());

  setDebug(false);
  log.clear();
  log.info('e2e-info-off');
  log.warn('e2e-warn-off');
  const offText = log.format();
  check('调试日志关：INFO 不记、WARN 记', !offText.includes('e2e-info-off') && offText.includes('e2e-warn-off'), offText.slice(0, 160));
  check('关着时 stats.enabled = false', log.stats().enabled === false);

  setDebug(true);
  log.clear();
  log.info('e2e-info-on');
  const onText = log.format();
  check('调试日志开：INFO 也记下来', onText.includes('e2e-info-on'), onText.slice(0, 160));
  check('开着的 stats.enabled = true', log.stats().enabled === true);

  D.GlossaryQueue.openPanel();
  await sleep(400);
  const panel = document.getElementById('ntr-queue-overlay');
  check('队列面板已打开', !!panel);
  const panelBtns = [...panel.querySelectorAll('button')];
  const exportBtn = panelBtns.find((b) => b.textContent.trim() === '导出日志');
  check('面板工具栏有「导出日志」', !!exportBtn, panelBtns.map((b) => b.textContent.trim()).join('|'));
  const origDownload = D.GlossaryUI.downloadText;
  let captured = null;
  D.GlossaryUI.downloadText = (name, text) => { captured = { name, text }; };
  exportBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  await sleep(250);
  D.GlossaryUI.downloadText = origDownload;
  check('导出文件名是 ntr-toolbox-log.*.txt', !!captured && /^ntr-toolbox-log\.\d+\.txt$/.test(captured.name), captured && captured.name);
  check('导出内容包含刚才的日志行', !!captured && captured.text.includes('e2e-info-on'), captured && captured.text.slice(0, 200));
  check('导出头部写明开关状态与条数', !!captured && /调试日志：开/.test(captured.text) && /条数：\d+/.test(captured.text));

  panel.remove();
  setDebug(false);
  log.clear();
  check('全程没有发生任何写入', puts.length === 0, puts);
} catch (e) {
  out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
}
window.fetch = origFetch;
return JSON.stringify(out, null, 2);
