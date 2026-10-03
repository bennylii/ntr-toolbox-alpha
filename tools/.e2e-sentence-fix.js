// 修句：模块注册 + 引擎纯函数 + 审核面板交互 + 写回链路（对 mock 站点 API，需 mock-llm/server.mjs 已含 POST translate-v2 路由）
// 跑法：node tools/cdp.mjs open http://127.0.0.1:8788/novel/mock/mock-src && node tools/cdp.mjs inject && node tools/cdp.mjs evalf tools/.e2e-sentence-fix.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const E = D.GlossaryEngine;
const origConfirm = window.confirm;

try {
  // ---- 注册 ----
  const mod = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === '修句');
  const names = ((mod || {}).settings || []).map((s) => s.name);
  check('模块「修句」已注册（译文来源/翻译器/段落与并发类设置齐全）', !!mod && ['译文来源', '翻译器', '每批段落数', '段落上限', '并发', '逾时(秒)'].every((n) => names.includes(n)), names);
  check('dev 句柄导出 GlossaryFix / writeBackChapterFixes', !!D.GlossaryFix && typeof D.writeBackChapterFixes === 'function');
  check('引擎导出修句纯函数', ['planFixTargets', 'buildFixRows', 'buildFixPrompt', 'parseFixResponse', 'locateParagraph'].every((k) => typeof E[k] === 'function'));

  // ---- 纯函数冒烟 ----
  const planned = E.planFixTargets({ pairs: [{ jp: 'ローズリーンが来た', zh: '莉莉来了' }], glossary: { 'ローズリーン': '罗丝琳' } });
  check('planFixTargets 定位未落地', planned.targets.length === 1 && planned.targets[0].dst === '罗丝琳', planned.targets);
  const parsedFix = E.parseFixResponse('```jsonline\n{"id":0,"text":"罗丝琳来了"}\n```', { rowCount: 1 });
  check('parseFixResponse 解析 id/text', parsedFix.fixes.get(0) === '罗丝琳来了', parsedFix);

  // ---- 审核面板（假 onApply 驱动交互） ----
  window.confirm = () => true;
  let applyArgs = null;
  D.GlossaryFix.open({
    title: 'e2e 修句面板',
    note: 'e2e 合成数据',
    rows: [
      { id: 0, chapterKey: 'ch1', chapterId: 'ch1', chapterTitle: '一章', jp: 'J0', zh: 'Z0', after: 'A0', status: 'changed', missed: [{ src: 'X', dst: 'x' }] },
      { id: 1, chapterKey: 'ch2', chapterId: 'ch2', chapterTitle: '二章', jp: 'J1', zh: 'Z1', after: '', status: 'unchanged', missed: [{ src: 'Y', dst: 'y' }] },
      { id: 2, chapterKey: 'ch3', chapterId: 'ch3', chapterTitle: '三章', jp: 'J2', zh: 'Z2', after: 'A2', status: 'changed', missed: [{ src: 'Z', dst: 'z' }] },
    ],
    onApply: async (ids, onProgress) => {
      applyArgs = ids.slice();
      if (onProgress) onProgress('fake 写回中');
      return { appliedIds: ids.filter((id) => id === 0), failed: ids.includes(2) ? [{ id: 2, reason: 'fake fail' }] : [] };
    },
  });
  await sleep(120);
  const ov = document.getElementById('ntr-glossary-fix-overlay');
  const trows = () => Array.from(ov.querySelectorAll('tbody tr'));
  const btn = (label) => Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent.startsWith(label));
  check('面板渲染 3 行、默认勾选可写回 2 条', trows().length === 3 && ov.textContent.includes('已勾选 2'), trows().length);
  check('「无需修改」行复选框禁用', trows()[1].querySelector('input').disabled === true);
  btn('全不选').click();
  await sleep(50);
  check('全不选后写回按钮禁用', btn('写回选中').disabled === true);
  btn('全选可写回').click();
  await sleep(50);
  check('全选后按钮显示 2 条', btn('写回选中').textContent.includes('2'));
  btn('写回选中').click();
  await sleep(300);
  check('onApply 只收到勾选的可写回 id', Array.isArray(applyArgs) && applyArgs.length === 2 && applyArgs.includes(0) && applyArgs.includes(2), applyArgs);
  check('写回结果回填状态：成功置「已写回」、失败置「失败」', trows()[0].className === 'status-applied' && trows()[2].className === 'status-failed', [trows()[0].className, trows()[2].className]);
  const closeBtn = Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  closeBtn.click();
  await sleep(80);
  check('面板关闭后清理', !document.getElementById('ntr-glossary-fix-overlay'));

  // ---- 写回链路（mock 站点 API） ----
  const target = { kind: 'web', providerId: 'mock', novelId: 'mock-src', title: 'mock 测试书' };
  const wbRows = [
    { id: 0, chapterId: 'ch1', chapterTitle: '一章', jp: '第1行：アリスが魔導書を読む。ローズも来た。', after: '第1行：爱丽丝在阅读魔导书。罗丝也来了。【修】' },
    { id: 1, chapterId: 'ch1', chapterTitle: '一章', jp: '根本不存在的行', after: 'x' },
  ];
  const wb = await D.writeBackChapterFixes(target, 'gpt', wbRows, () => { });
  check('写回：命中段落 applied、未命中段落 failed（附原因）', wb.appliedIds.includes(0) && !wb.appliedIds.includes(1) && wb.failed.some((f) => f.id === 1 && /找不到对应原文/.test(f.reason)), wb);
  const stats = await fetch('/__stats').then((r) => r.json());
  const up = stats.lastChapterUpload;
  check('上传体：段落数与章节一致、带当前 glossaryId、修正文本就位', !!up && up.count === 25 && up.glossaryId === 'mock-gloss' && String(up.preview[0]).includes('【修】'), up);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  window.confirm = origConfirm;
  const leftover = document.getElementById('ntr-glossary-fix-overlay');
  if (leftover) leftover.remove();
  out.notes.push('cleanup: 面板/confirm 已还原');
}
return JSON.stringify(out, null, 1);
