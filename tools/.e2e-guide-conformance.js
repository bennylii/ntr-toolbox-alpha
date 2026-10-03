// 指南合规：值格式解析/备注写入保留/存在性检查（对 mock 站点 API）
// 跑法：node tools/cdp.mjs open http://127.0.0.1:8788/novel/mock/mock-noted && node tools/cdp.mjs inject && node tools/cdp.mjs evalf tools/.e2e-guide-conformance.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const D = window._NTRGlossaryDev;
const E = D.GlossaryEngine;

try {
  // ---- 引擎函数在页可用 ----
  check('引擎导出值格式/合规函数', ['splitGlossaryValue', 'isSimpleNote', 'formatGlossaryValue', 'looksLikeSourceTampering', 'auditImportEntries'].every((k) => typeof E[k] === 'function'));
  check('值解析：译名 #备注', (() => { const p = E.splitGlossaryValue('阿尔蒂 #女性'); return p.dst === '阿尔蒂' && p.note === '女性'; })());
  check('备注写入：类型映射 + 作文拒写', E.formatGlossaryValue('阿尔蒂', '女性人名') === '阿尔蒂 #女性' && E.formatGlossaryValue('阿尔蒂', '女性，本作女主角') === '阿尔蒂');
  check('改原文检测：rem0 命中、正常词不误伤', E.looksLikeSourceTampering('rem0') === true && E.looksLikeSourceTampering('アルテ') === false);

  // ---- 模块注册 ----
  const imp = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === '导入术语表(KWG)');
  check('「导入术语表(KWG)」新增「检查正文」设置（默认开）', !!imp && ((imp.settings || []).find((s) => s.name === '检查正文') || {}).value === true);

  // ---- 目标解析（mock-noted 页面） ----
  const resolved = await D.resolveGlossaryTarget();
  check('resolveGlossaryTarget 在页面解析出 mock-noted', !!resolved && resolved.kind === 'web' && resolved.novelId === 'mock-noted', resolved);
  const target = { kind: 'web', providerId: 'mock', novelId: 'mock-noted', title: 'mock 测试书' };
  const glossary = await D.GlossaryTargets.loadGlossary(target);
  check('站点术语表带 #备注 读出', glossary['アルテ'] === '阿尔蒂 #女性', glossary);

  // ---- 带备注术语表的验收回扫（回归：修复前会误判 missed） ----
  const entries = Object.keys(glossary).map((src) => ({ src, dst: glossary[src] }));
  const scan = E.scanAcceptance({ entries, jpLines: ['アルテは笑った', 'オルトが来た'], zhLines: ['阿尔蒂笑了', '欧尔特来了'] });
  check('带备注术语表回扫：全部 landed、落地率 100%', scan.stats.landed === 2 && scan.stats.missed === 0 && scan.stats.rate === 1, scan.stats);
  check('回扫展示的 dst 已剥离备注', scan.rows.every((r) => !String(r.dst).includes('#')), scan.rows.map((r) => r.dst));

  // ---- 合并弹层比对：base 相同判 same 而非 conflict ----
  const diff = D.GlossaryUI.computeDiff([{ src: 'アルテ', dst: '阿尔蒂' }], glossary);
  check('computeDiff：译名相同（备注差异）判 same', diff.rows[0].status === 'same', diff.rows[0]);

  // ---- 写入备注 + 保留原备注（对 mock 实际 PUT） ----
  await D.writeGlossaryMerged(target, [
    { src: 'アルテ', dst: '阿尔蒂', type: '女性人名' },   // 已有 #女性，等价重写
    { src: 'オルト', dst: '欧尔特', type: '' },           // 未提供备注 → 保留站点原备注
    { src: 'キャロル', dst: '卡罗尔', type: '女性人名' }, // 新增：类型映射写入备注
  ]);
  let stats = await fetch('/__stats').then((r) => r.json());
  let put = stats.lastGlossaryPut;
  check('写入：新译名带类型备注（卡罗尔 #女性）', !!put && put.body['キャロル'] === '卡罗尔 #女性', put && put.body);
  check('写入：既有备注被保留（欧尔特 #男性）', !!put && put.body['オルト'] === '欧尔特 #男性', put && put.body);
  check('写入：路径正确（mock-noted）', !!put && /mock-noted\/glossary$/.test(put.path), put && put.path);

  // 译名改动时备注不继承（避免旧备注配上新译名）
  await D.writeGlossaryMerged(target, [{ src: 'アルテ', dst: '阿露蒂' }]);
  stats = await fetch('/__stats').then((r) => r.json());
  put = stats.lastGlossaryPut;
  check('写入：译名变更时不携带旧备注', !!put && put.body['アルテ'] === '阿露蒂', put && put.body);

  // ---- 存在性检查（导入路径核心） ----
  const { text } = await D.loadGlossarySourceText(target);
  const lines = E.splitLines(text);
  const audited = E.auditImportEntries({
    entries: [
      { src: 'アルテ', dst: '阿尔蒂' },
      { src: 'ゴースト', dst: '幽灵' },
      { src: 'rem0', dst: '真白萌有翻译' },
    ],
    lines,
  });
  check('存在性检查：书中未见 2 条（ゴースト/rem0）、疑似改原文 1 条、命中的不标', audited.absent === 2 && audited.tampered === 1 && (audited.entries[0].suspect || []).length === 0, { absent: audited.absent, tampered: audited.tampered, suspects: audited.entries.map((e) => e.suspect) });
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  const overlay = document.getElementById('ntr-glossary-overlay');
  if (overlay) overlay.remove();
  const status = document.getElementById('ntr-glossary-status');
  if (status) status.remove();
  out.notes.push('cleanup: 浮层已清理');
}
return JSON.stringify(out, null, 1);
