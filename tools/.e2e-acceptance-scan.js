// 验收回扫：引擎纯函数（四态/统计/不遮蔽）+ 报告面板（渲染/筛选/导出）+ 模块注册
// 纯本地计算，不调 LLM、不请求站点 API，注入后任意页面可跑
// 跑法：node tools/cdp.mjs open <任意已注入页面> && node tools/cdp.mjs inject && node tools/cdp.mjs evalf tools/.e2e-acceptance-scan.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;

try {
  check('引擎导出 scanAcceptance / compileAcceptanceMatcher / matchGlossaryPatterns', !!(D.GlossaryEngine.scanAcceptance && D.GlossaryEngine.compileAcceptanceMatcher && D.GlossaryEngine.matchGlossaryPatterns));
  check('dev 句柄导出 GlossaryReport / loadGlossaryParallelText', !!(D.GlossaryReport && D.loadGlossaryParallelText));
  check('模块「验收回扫」已注册且带设置项', (() => {
    const mod = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === '验收回扫');
    if (!mod) return false;
    const names = (mod.settings || []).map((s) => s.name);
    return names.includes('译文来源') && names.includes('最短译文长度') && names.includes('只看未落地');
  })());

  // ---- 引擎：四态 ----
  const entries = [
    { src: 'アリス', dst: '爱丽丝', type: '女性人名' },
    { src: 'ボブ', dst: '鲍勃', type: '男性人名' },
    { src: 'キャロル', dst: '卡罗尔', type: '女性人名' },
    { src: 'エコー', dst: '艾', type: '女性人名' },
  ];
  const jpLines = ['アリスは笑った', 'ボブが来た', 'アリスとボブ', 'エコーが響く'];
  const zhLines = ['爱丽丝笑了', '鲍勃来了'];
  const { rows, stats } = D.GlossaryEngine.scanAcceptance({ entries, jpLines, zhLines });
  const st = (src) => (rows.find((r) => r.src === src) || {}).status;
  check('四态：landed/missed/absent/unchecked 各自判定', st('アリス') === 'landed' && st('ボブ') === 'landed' && st('キャロル') === 'absent' && st('エコー') === 'unchecked', { a: st('アリス'), b: st('ボブ'), c: st('キャロル'), e: st('エコー') });
  check('统计：可检=2、落地率=100%、原文未见/不可检不进分母', stats.checkable === 2 && stats.rate === 1 && stats.absent === 1 && stats.unchecked === 1, stats);

  // ---- 报告面板 ----
  const reportRows = rows.map((r, i) => i === 1 ? { ...r, status: 'missed' } : r);   // 造一条未落地
  const rep = D.GlossaryReport.open({
    title: 'e2e 验收回扫报告',
    rows: reportRows,
    stats: { total: 4, landed: 1, missed: 1, absent: 1, unchecked: 1, checkable: 2, rate: 0.5 },
    note: 'e2e 合成数据',
    initialFilter: 'all',
  });
  await sleep(120);
  const ov = document.getElementById('ntr-glossary-report-overlay');
  const trows = () => Array.from(ov.querySelectorAll('tbody tr'));
  const tab = (label) => Array.from(ov.querySelectorAll('.ntr-g-tab')).find((b) => b.textContent === label);
  check('报告面板渲染：表头列齐全', ['状态', '原文', '译文', '原/译命中', '类型', '原文样例'].every((h) => Array.from(ov.querySelectorAll('thead th')).some((th) => th.textContent === h)));
  check('报告面板渲染：行数=全部 4 条', trows().length === 4, trows().length);
  check('统计条显示落地率', /落地率 50\.0%/.test(ov.querySelector('.ntr-g-stats').textContent), ov.querySelector('.ntr-g-stats').textContent);
  check('排序：未落地排最前', trows()[0].className === 'status-missed', trows().map((r) => r.className));
  tab('未落地').click();
  await sleep(60);
  check('筛选「未落地」只剩 missed 行', trows().length === 1 && trows().every((r) => r.className === 'status-missed'), trows().map((r) => r.className));
  tab('已落地').click();
  await sleep(60);
  check('筛选「已落地」只剩 landed 行', trows().length === 1 && trows()[0].className === 'status-landed', trows().length);
  tab('全部').click();
  await sleep(60);
  const search = ov.querySelector('input[type=text]');
  search.value = 'ボブ';
  search.dispatchEvent(new Event('input'));
  await sleep(60);
  check('搜索「ボブ」命中对应行', trows().length >= 1 && trows().every((r) => r.textContent.includes('ボブ')), trows().length);
  search.value = '';
  search.dispatchEvent(new Event('input'));
  await sleep(60);
  const tsv = D.GlossaryReport.toTsv(D.GlossaryReport.sortRows(reportRows));
  check('TSV 导出：表头 + 行数正确、含未落地清单所需字段', tsv.split('\n').length === 5 && tsv.startsWith('状态\t原文\t译文'), tsv.split('\n')[0]);
  check('复制未落地清单按钮存在', Array.from(ov.querySelectorAll('.ntr-g-btn')).some((b) => b.textContent === '复制未落地清单'));
  check('导出 TSV 按钮存在', Array.from(ov.querySelectorAll('.ntr-g-btn')).some((b) => b.textContent.includes('导出 TSV')));
  const closeBtn = Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  closeBtn.click();
  await sleep(60);
  check('关闭后浮层移除', !document.getElementById('ntr-glossary-report-overlay'));
  rep.close();
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  const leftover = document.getElementById('ntr-glossary-report-overlay');
  if (leftover) leftover.remove();
  const status = document.getElementById('ntr-glossary-status');
  if (status) status.remove();
  out.notes.push('cleanup: 报告浮层/进度浮窗已清理');
}
return JSON.stringify(out, null, 1);
