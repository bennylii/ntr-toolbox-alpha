// 阶段 2 三特性 e2e：种子补漏 / 词根整理 / 译文反推 —— 模块注册 + 引擎纯函数在页面环境的行为
// 纯本地：不调 LLM、不请求站点 API
// 跑法：node tools/cdp.mjs open <mock 页> && node tools/cdp.mjs inject && node tools/cdp.mjs evalf tools/.e2e-glossary-tools.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const D = window._NTRGlossaryDev;
const E = D.GlossaryEngine;

const moduleOf = (name) => (window._NTRToolBox.configuration.modules || []).find((m) => m.name === name);
const settingNames = (name) => ((moduleOf(name) || {}).settings || []).map((s) => s.name);

try {
  // ---- 模块与设置注册 ----
  check('模块「词根整理」已注册（最少成员数/建议上限）', !!moduleOf('词根整理') && settingNames('词根整理').includes('最少成员数') && settingNames('词根整理').includes('建议上限'));
  check('模块「译文反推」已注册（译文来源/最少共现次数/建议上限）', !!moduleOf('译文反推') && ['译文来源', '最少共现次数', '建议上限'].every((n) => settingNames('译文反推').includes(n)));
  check('「AI提取术语表」新增设置「种子补漏」', settingNames('AI提取术语表').includes('种子补漏'));
  check('「同步 Daemon」模块已注册（Daemon 地址设置）', (() => {
    const mod = (window._NTRToolBox.configuration.modules || []).find((m) => m.name === '同步 Daemon');
    return !!mod && (mod.settings || []).some((s) => s.name === 'Daemon 地址');
  })());
  check('队列设置快照包含 seedPolish', (() => { try { return D.GlossaryQueue.extractSettings().seedPolish === true; } catch (e) { return false; } })());
  check('dev 句柄导出三特性关键函数', ['deriveSeeds', 'buildSeedChunks', 'deriveCommonLiteralRoots', 'verifyRootCoverage', 'loadGlossaryAlignedPairs'].every((k) => typeof D[k] === 'function'));
  check('引擎导出译文反推函数', typeof E.parseParallelText === 'function' && typeof E.inferTranslationsFromPairs === 'function');

  // ---- 种子补漏（页面环境跑一遍纯函数） ----
  const seeds = E.deriveSeeds({
    entries: [{ src: 'アリスさん', dst: '爱丽丝' }],
    lines: ['アリスさんが来た', 'ローズリーンとアリス'],
  });
  check('deriveSeeds：敬称裸名 + 片假名信号各产出种子', seeds.some((s) => s.pattern === 'アリス' && s.kind === 'honorific') && seeds.some((s) => s.pattern === 'ローズリーン' && s.kind === 'signal'), seeds.map((s) => s.pattern));
  const seedChunks = E.buildSeedChunks(seeds, ['アリスさんが来た', 'ローズリーンとアリス'], 1000);
  check('buildSeedChunks：合成一块且 focus 带全部种子', seedChunks.length === 1 && seedChunks[0].focus.length >= 2, seedChunks.map((c) => c.focus.map((s) => s.pattern)));
  const focusedPrompt = E.buildPrompt({ chunkText: 'x', focus: seeds });
  check('buildPrompt(focus)：定向补漏段带种子清单', /定向补漏/.test(focusedPrompt) && focusedPrompt.includes('アリス') && focusedPrompt.includes('ローズリーン'));

  // ---- 词根整理 ----
  const roots = E.deriveCommonLiteralRoots([
    { src: 'ローズリーン', dst: '罗丝琳' },
    { src: 'ローズベルト', dst: '罗丝伯特' },
    { src: 'ローズマリー', dst: '罗丝玛丽' },
  ], { minMembers: 2 });
  check('deriveCommonLiteralRoots：派生「ローズ」+ 译文词根「罗丝」', roots.length === 1 && roots[0].root === 'ローズ' && roots[0].rootDst === '罗丝' && roots[0].memberCount === 3, roots.map((r) => r.root));
  const cover = E.verifyRootCoverage({
    root: 'ローズ',
    members: roots[0] ? roots[0].members : [],
    lines: ['ローズリーンが来た', 'ローズの館'],
  });
  check('verifyRootCoverage：词根独有命中单独列出', cover.extraCount === 1 && cover.extraSamples[0].includes('ローズの館'), cover);

  // ---- 译文反推 ----
  const parsed = E.parseParallelText('# 一章\n# 一章中\nアリスは笑った\n爱丽丝笑了\nローズリーンが来た\n罗丝琳来了');
  check('parseParallelText：双标题章下正确配对', parsed.pairs.length === 2 && parsed.pairs[1].jp === 'ローズリーンが来た' && parsed.pairs[1].zh === '罗丝琳来了', parsed.pairs);
  const mk = (jp, zh) => ({ jp, zh, chapter: 'c' });
  const inferred = E.inferTranslationsFromPairs({
    pairs: [
      mk('ローズリーンが来た', '罗丝琳来了'),
      mk('ローズリーンは笑った', '罗丝琳笑了'),
      mk('ローズリーンとアリス', '罗丝琳和爱丽丝'),
      mk('ローズの館', '罗丝的宅邸'),
    ],
    glossary: {},
    minPairs: 3,
    maxFrequency: 1,
  });
  check('inferTranslationsFromPairs：反推出「ローズリーン => 罗丝琳」', inferred.suggestions.length === 1 && inferred.suggestions[0].dst === '罗丝琳', inferred.suggestions);

  // ---- 词根建议进合并弹层的冒烟（复用现有 UI 通道） ----
  if (roots.length > 0) {
    D.GlossaryUI.open({
      title: 'e2e 词根整理冒烟（不写入）',
      target: { kind: 'web', providerId: 'mock', novelId: 'x', title: 'e2e' },
      entries: [{ src: roots[0].root, dst: roots[0].rootDst, type: `词根（${roots[0].memberCount} 成员，新增命中 ${cover.extraCount}）`, count: cover.rootCount, context: cover.extraSamples }],
      existing: {},
      mode: 'merge',
      onWrite: async () => { },
    });
    await new Promise((r) => setTimeout(r, 150));
    const ov = document.getElementById('ntr-glossary-overlay');
    check('词根建议可进合并弹层并渲染行', !!ov && ov.querySelectorAll('tbody tr').length >= 1, ov ? ov.querySelectorAll('tbody tr').length : 0);
    const contextShown = ov && Array.from(ov.querySelectorAll('td')).some((td) => String(td.title || '').includes('ローズの館'));
    check('新增命中样例作为上下文提示可见', !!contextShown);
    const closeBtn = ov && Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
    if (closeBtn) closeBtn.click();
    await new Promise((r) => setTimeout(r, 80));
    check('弹层关闭后清理', !document.getElementById('ntr-glossary-overlay'));
  }
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  const leftover = document.getElementById('ntr-glossary-overlay');
  if (leftover) leftover.remove();
  out.notes.push('cleanup: 弹层已清理');
}
return JSON.stringify(out, null, 1);
