// daemon/lg-align-test.mjs —— LG 对齐导入纯函数单测（无需 mock；getChapter 用桩）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSourceExport, manifestOf, splitResultLines, verifyImport, convertSiteFormat, convertSiteFormatLoose, splitBlocks, looksLikeSiteFormat, alignLgResult, applyImportReport, verifySubmitted, manifestFingerprint, chapterContentSha, createLgImportRunner, createLgReadbackRunner, fetchSiteExportLines, isMissingTranslationMarker, LG_IMPORT_STATE_KEY, MANIFEST_VERSION } from './lg-align.mjs';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  const run = async () => {
    try { await fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + ((e && e.message) || e)); }
  };
  return run();
};

// 章节夹具：6/4/2 段，含空行；段落含"章标题"式首段
const CHAPTERS = [
  { chapterId: 't1', volumeId: '', title: '章 一', paragraphs: ['　ここは老舗旅館。', '', '　佳乃は朝から忙しい。', '「おはよう」', '', '　今日も客が来る。'] },
  { chapterId: 't2', volumeId: '', title: '章 二', paragraphs: ['　ローズが来た。', '「どうしたの」', '', '　返事はない。'] },
  { chapterId: 't3', volumeId: '', title: '章 三', paragraphs: ['　魔王が現れた。', '', '　終わり。'] },
];
const BUILT = buildSourceExport(CHAPTERS);
const GLOSSARY_ID = 'g-current';
const chapterStore = new Map(CHAPTERS.map((c) => [c.chapterId, c.paragraphs]));
const makeGetChapter = (mutate = null) => async (chapterId) => {
  let paragraphs = chapterStore.get(chapterId);
  if (mutate) paragraphs = mutate(chapterId, paragraphs);
  return { paragraphJp: paragraphs, glossaryId: GLOSSARY_ID };
};
const identityGet = makeGetChapter();
const translate = (lines) => lines.map((l) => (l.trim() === '' ? l : `【译】${l}`));

console.log('== LG 对齐：导出结构 ==');
await t('行号映射：start/count 覆盖 13 行、含空行', () => {
  assert.equal(BUILT.linesTotal, 13);
  assert.deepEqual(BUILT.chapters.map((c) => [c.start, c.count]), [[0, 6], [6, 4], [10, 3]], JSON.stringify(BUILT.chapters));
  assert.equal(BUILT.text.split('\n').length, 13);
  assert.equal(BUILT.text.split('\n')[1], '', '空行也是一行');
});
await t('manifest 结构与书绑定', () => {
  const manifest = manifestOf({ key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' }, BUILT);
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.equal(manifest.book.key, 'web:mock/x');
  assert.ok(manifest.chapters[0].jpSha1.length === 40);
});

console.log('== LG 对齐：结果行解析 ==');
await t('CRLF / BOM / 末尾换行容忍', () => {
  const text = BUILT.text + '\n';
  assert.equal(splitResultLines(text).length, 13);
  assert.equal(splitResultLines(text.replace(/\n/g, '\r\n')).length, 13);
  assert.equal(splitResultLines('\ufeff' + text).length, 13);
  assert.deepEqual(splitResultLines(''), []);
  assert.deepEqual(splitResultLines('\n'), []);
  assert.deepEqual(splitResultLines('a\n\nb'), ['a', '', 'b']);
});

console.log('== LG 对齐：校验与映射 ==');
await t('全对齐：逐章 ✓、glossaryId 带出、无疑似未翻（译文≠原文）', async () => {
  const report = await verifyImport({ resultLines: translate(splitResultLines(BUILT.text)), manifest: { linesTotal: BUILT.linesTotal, chapters: BUILT.chapters }, getChapter: makeGetChapter() });
  assert.equal(report.ok, true, JSON.stringify(report.chapters.filter((c) => !c.ok)));
  assert.equal(report.okCount, 3);
  assert.deepEqual(report.chapters.map((c) => c.glossaryId), [GLOSSARY_ID, GLOSSARY_ID, GLOSSARY_ID]);
  assert.equal(report.untranslated, 0);
  assert.equal(report.chapters[0].paragraphsZh.length, 6);
  assert.ok(report.chapters[0].paragraphsZh[0].startsWith('【译】'));
  assert.equal(report.chapters[0].paragraphsZh[1], '');
});
await t('疑似未翻统计：结果行==原文行 计数', async () => {
  const report = await verifyImport({ resultLines: splitResultLines(BUILT.text), manifest: { linesTotal: BUILT.linesTotal, chapters: BUILT.chapters }, getChapter: makeGetChapter() });
  assert.equal(report.ok, true);
  assert.equal(report.untranslated, 9, '非空 9 行全部原样 = 疑似未翻 9');
});
await t('总行数不符 → 全局拒绝、无映射', async () => {
  const lines = splitResultLines(BUILT.text);
  lines.splice(3, 1);   // 少一行
  const report = await verifyImport({ resultLines: lines, manifest: { linesTotal: BUILT.linesTotal, chapters: BUILT.chapters }, getChapter: makeGetChapter() });
  assert.equal(report.ok, false);
  assert.ok(/行数不符/.test(report.globalError), report.globalError);
  assert.equal(report.chapters.length, 0);
});
await t('单章行数不符（清单与站点不一致）→ 该章 ✗', async () => {
  const report = await verifyImport({
    resultLines: splitResultLines(BUILT.text),
    manifest: { linesTotal: BUILT.linesTotal, chapters: BUILT.chapters.map((c) => (c.chapterId === 't2' ? { ...c, count: 3, jpSha1: 'x'.repeat(40) } : c)) },
    getChapter: makeGetChapter(),
  });
  const t2 = report.chapters.find((c) => c.chapterId === 't2');
  assert.equal(t2.ok, false, JSON.stringify(t2));
  assert.ok(/行数不符/.test(t2.reason), t2.reason);
  assert.equal(report.ok, false);
});
await t('空/非空模式不一致 → 行错位检测', async () => {
  const lines = splitResultLines(BUILT.text);
  // 把 t1 的空行（第 2 行，index 1）填上文字 → 模式不符
  lines[1] = '【误】多出来的一行';
  const report = await verifyImport({ resultLines: lines, manifest: { linesTotal: BUILT.linesTotal, chapters: BUILT.chapters }, getChapter: makeGetChapter() });
  const t1 = report.chapters.find((c) => c.chapterId === 't1');
  assert.equal(t1.ok, false, JSON.stringify(t1));
  assert.ok(/空\/非空模式不一致/.test(t1.reason), t1.reason);
});
await t('源站漂移：站点原文与导出 sha1 不符 → 该章 ✗', async () => {
  const report = await verifyImport({
    resultLines: splitResultLines(BUILT.text),
    manifest: { linesTotal: BUILT.linesTotal, chapters: BUILT.chapters },
    getChapter: makeGetChapter((id, p) => (id === 't3' ? p.map((l) => l + '！') : p)),
  });
  const t3 = report.chapters.find((c) => c.chapterId === 't3');
  assert.equal(t3.ok, false, JSON.stringify(t3));
  assert.ok(/不一致（源站更新|漂移）/.test(t3.reason), t3.reason);
});
await t('章节获取失败 → 该章 ✗ 且不上传', async () => {
  const report = await verifyImport({
    resultLines: splitResultLines(BUILT.text),
    manifest: { linesTotal: BUILT.linesTotal, chapters: BUILT.chapters },
    getChapter: async (id) => { if (id === 't2') throw new Error('HTTP 404'); return { paragraphJp: chapterStore.get(id), glossaryId: GLOSSARY_ID }; },
  });
  const t2 = report.chapters.find((c) => c.chapterId === 't2');
  assert.equal(t2.ok, false);
  assert.ok(/获取失败/.test(t2.reason), t2.reason);
  assert.equal(t2.paragraphsZh, null);
});

// ---- 站点导出格式（mode=jp）自动对齐 ----
// 站点格式夹具：头部 + ############ + 简介，之后每章 `# 标题` + 空行 + 段落，章块之间 3 行结构空行；
// 开头额外放一个没有章节条目的「卷标题」占两行（真实站点导出里就是这样）
// leadBlanks：上游 c11cdbfe 起每个 toc 项标题前先写两个空行（auto-novel 提交 11fbbb9f）；
//            旧导出没有这个前缀，两种都必须能对齐（站点没换版本时用户手里的旧文件照样能用）
const SITE_HEAD = ['书名', '', '作者[mock]', '', '标签 / 测试 /', '总计: 3 / GPT: 3', '', '############', '简介一句。', '', '', ''];
const siteFormat = (paragraphsOf, groups = [], opts = {}) => {
  const lead = opts.leadBlanks === undefined ? 2 : opts.leadBlanks;
  const missing = opts.missing || [];
  const lines = [...SITE_HEAD];
  const titleOf = (text) => { for (let i = 0; i < lead; i += 1) lines.push(''); lines.push(text, ''); };
  for (const ch of CHAPTERS) {
    if (groups.includes(ch.chapterId)) titleOf(`# 卷 ${ch.chapterId}`);
    titleOf(`# ${ch.title}`);
    if (missing.includes(ch.chapterId)) lines.push('GPT翻译缺失。', '');
    else for (const p of paragraphsOf(ch)) lines.push(p);
    lines.push('', '', '');
  }
  return lines;
};
const MANIFEST = { linesTotal: BUILT.linesTotal, chapters: BUILT.chapters };

console.log('== 站点导出格式（mode=jp）自动对齐 ==');
await t('looksLikeSiteFormat：认 ############ 与 # 标题行；契约格式不误判', () => {
  assert.equal(looksLikeSiteFormat(SITE_HEAD), true);
  assert.equal(looksLikeSiteFormat(splitResultLines(BUILT.text)), false);
  assert.equal(looksLikeSiteFormat(['纯文本', '一行一段']), false);
});
await t('转换：头部/卷标题/结构空行都不误伤，输出行数=清单', () => {
  const jp = siteFormat((ch) => ch.paragraphs, ['t2']);       // t2 前放一个无章节条目的「卷标题」
  const zh = siteFormat((ch) => translate(ch.paragraphs), ['t2']);
  const conv = convertSiteFormat({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, true, conv.reason);
  assert.equal(conv.lines.length, BUILT.linesTotal);
  assert.equal(conv.untranslated, 0);
  assert.deepEqual(conv.chapters.map((c) => [c.chapterId, c.count]), [['t1', 6], ['t2', 4], ['t3', 3]]);
  // 折出的契约行 = 契约格式的译文行（逐行等价）
  assert.deepEqual(conv.lines, translate(splitResultLines(BUILT.text)));
  // 章块起点单调递增；卷/分组标题占位时本章靠「块内 sha1 扫描」找回，标题记的是本章自己的标题行
  const starts = conv.chapters.map((c) => c.fileStart);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), JSON.stringify(starts));
  const t2 = conv.chapters.find((c) => c.chapterId === 't2');
  assert.equal(jp[t2.titlePos], '# 章 二', JSON.stringify(t2));
  assert.equal(t2.fileStart, t2.titlePos + 2, JSON.stringify(t2));
});
await t('转换：译文块空/非空模式与原文不符 → 明确拒绝（不输出错位数据）', () => {
  const jp = siteFormat((ch) => ch.paragraphs);
  const zh = siteFormat((ch) => ch.paragraphs.map((p, i, arr) => (p === '' ? '（多出来的）' : `【译】${p}`)));
  const conv = convertSiteFormat({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, false, JSON.stringify(conv));
  assert.ok(/空\/非空模式/.test(conv.reason), conv.reason);
  assert.equal(conv.lines, undefined);
});
await t('转换：站点原文块 sha1 对不上（站点已更新）→ 拒绝并指出章节', () => {
  const jp = siteFormat((ch) => (ch.chapterId === 't2' ? ch.paragraphs.map((p) => p + '！') : ch.paragraphs));
  const zh = siteFormat((ch) => translate(ch.paragraphs));
  const conv = convertSiteFormat({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, false, JSON.stringify(conv));
  assert.ok(/对不上/.test(conv.reason) && /t2/.test(conv.reason), conv.reason);
});
await t('alignLgResult：行数符 → 原样返回、零请求；站点格式 → 自动抓原文对齐', async () => {
  let calls = 0;
  const client = { getText: async () => { calls += 1; return siteFormat((ch) => ch.paragraphs).join('\n'); } };
  const book = { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' };
  const contract = translate(splitResultLines(BUILT.text));
  const same = await alignLgResult({ client, book, manifest: MANIFEST, resultLines: contract });
  assert.equal(same.converted, false);
  assert.equal(calls, 0, '行数已符不应请求站点');
  const siteLines = siteFormat((ch) => translate(ch.paragraphs));
  const conv = await alignLgResult({ client, book, manifest: MANIFEST, resultLines: siteLines });
  assert.equal(conv.converted, true, JSON.stringify(conv));
  assert.equal(calls, 1);
  assert.deepEqual(conv.lines, contract);
  assert.ok(/站点导出格式/.test(conv.note), conv.note);
});
await t('alignLgResult：不像站点格式 → 不转换（交给 verifyImport 报行数不符）', async () => {
  let calls = 0;
  const client = { getText: async () => { calls += 1; return ''; } };
  const book = { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' };
  const bad = ['随便几行', '行数不对'];
  const r = await alignLgResult({ client, book, manifest: MANIFEST, resultLines: bad });
  assert.equal(r.converted, false);
  assert.equal(calls, 0);
  assert.deepEqual(r.lines, bad);
});
await t('alignLgResult：清单属于别的项目 → fatal（不与当前书混用）', async () => {
  const client = { getText: async () => '' };
  const r = await alignLgResult({
    client, book: { key: 'web:mock/x' }, resultLines: [],
    manifest: { linesTotal: 1, chapters: [], book: { key: 'web:mock/y' } },
  });
  assert.ok(/不一致/.test(r.fatal || ''), JSON.stringify(r));
});

// ---- 折叠空行版站点导出译文（连续空行被并成 1 个）自动对齐 ----
// 真实来路：站点「下载原文」经某些工具翻译后，连续空行被折叠 → 行数与站点原文不同构，
// 严格模式（绝对行号切片）必然错位；宽松模式按块序号 + 非空行映射对齐。
const collapseBlanks = (lines) => {
  const out = [];
  for (const l of lines) {
    if (String(l).trim() === '' && out.length > 0 && String(out[out.length - 1]).trim() === '') continue;
    out.push(l);
  }
  return out;
};

console.log('== 站点导出格式（折叠空行版）自动对齐 ==');
await t('splitBlocks：按 # 标题切块、块序号与卷标题各占一块', () => {
  const blocks = splitBlocks(['头', '# 卷一', '', '# 章 一', '', 'a', '', 'b', '', '', '', '# 章 二', '', 'c']);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.title), ['卷一', '章 一', '章 二']);
  assert.deepEqual(blocks[1].lines, ['', 'a', '', 'b', '', '', '']);
  assert.equal(blocks[1].titlePos, 3);
});
await t('convertSiteFormatLoose：折叠空行译文 → 折回契约行（空段落回填、未翻计数）', () => {
  const jp = siteFormat((ch) => ch.paragraphs, ['t2']);
  const zh = collapseBlanks(siteFormat((ch) => translate(ch.paragraphs), ['t2']));
  assert.ok(zh.length < jp.length, '夹具确实更短');
  const strict = convertSiteFormat({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(strict.ok, false, '严格模式应拒绝折叠空行版');
  const conv = convertSiteFormatLoose({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, true, JSON.stringify(conv));
  assert.equal(conv.blankCollapsed, true);
  assert.deepEqual(conv.lines, translate(splitResultLines(BUILT.text)));
  assert.equal(conv.chapters.length, 3);
  assert.equal(conv.chapters[0].count, 6);
  assert.equal(conv.untranslated, 0);
});
await t('convertSiteFormatLoose：块数不一致 → 拒绝', () => {
  const jp = siteFormat((ch) => ch.paragraphs, ['t2']);
  const zh = collapseBlanks(siteFormat((ch) => translate(ch.paragraphs)));
  const conv = convertSiteFormatLoose({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, false, JSON.stringify(conv));
  assert.ok(/块数不一致/.test(conv.reason), conv.reason);
});
await t('convertSiteFormatLoose：某章非空行数不符 → 拒绝并指出章节', () => {
  const jp = siteFormat((ch) => ch.paragraphs, ['t2']);
  const zh = collapseBlanks(siteFormat((ch) => (ch.chapterId === 't2' ? translate(ch.paragraphs).slice(1) : translate(ch.paragraphs)), ['t2']));
  const conv = convertSiteFormatLoose({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, false, JSON.stringify(conv));
  assert.ok(/t2/.test(conv.reason) && /非空行数/.test(conv.reason), conv.reason);
});
await t('convertSiteFormatLoose：原文块对不上（站点已更新）→ 拒绝', () => {
  const jp = siteFormat((ch) => (ch.chapterId === 't3' ? ch.paragraphs.map((p) => p + '！') : ch.paragraphs), ['t2']);
  const zh = collapseBlanks(siteFormat((ch) => translate(ch.paragraphs), ['t2']));
  const conv = convertSiteFormatLoose({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, false, JSON.stringify(conv));
  assert.ok(/t3/.test(conv.reason), conv.reason);
});
await t('格式代差：上游新增「标题前两空行」前后都能对齐（严格模式块内扫描，不依赖固定偏移）', () => {
  const jpOld = siteFormat((ch) => ch.paragraphs, ['t2'], { leadBlanks: 0 });
  const zhOld = siteFormat((ch) => translate(ch.paragraphs), ['t2'], { leadBlanks: 0 });
  const old = convertSiteFormat({ zhLines: zhOld, jpLines: jpOld, manifest: MANIFEST });
  assert.equal(old.ok, true, JSON.stringify(old));
  assert.deepEqual(old.lines, translate(splitResultLines(BUILT.text)));
  const jpNew = siteFormat((ch) => ch.paragraphs, ['t2'], { leadBlanks: 2 });
  const zhNew = siteFormat((ch) => translate(ch.paragraphs), ['t2'], { leadBlanks: 2 });
  const neu = convertSiteFormat({ zhLines: zhNew, jpLines: jpNew, manifest: MANIFEST });
  assert.equal(neu.ok, true, JSON.stringify(neu));
  assert.deepEqual(neu.lines, translate(splitResultLines(BUILT.text)));
});
await t('缺译标记（web「GPT翻译缺失。」）：整章铺空行，其余章照常对齐（严格模式）', () => {
  const jp = siteFormat((ch) => ch.paragraphs, ['t2']);
  const zh = siteFormat((ch) => translate(ch.paragraphs), ['t2'], { missing: ['t2'] });
  const conv = convertSiteFormat({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, true, JSON.stringify(conv));
  const t2 = conv.chapters.find((c) => c.chapterId === 't2');
  assert.equal(t2.missing, true, JSON.stringify(t2));
  assert.equal(t2.untranslated, 3, 't2 的 3 个非空段都算未译');
  const rebuilt = conv.lines.slice(BUILT.chapters[1].start, BUILT.chapters[1].start + BUILT.chapters[1].count);
  assert.deepEqual(rebuilt, ['', '', '', ''], JSON.stringify(rebuilt));
  assert.deepEqual(conv.lines.slice(0, 6), translate(CHAPTERS[0].paragraphs));
});
await t('缺译标记：折叠空行版（宽松模式）同样识别', () => {
  const jp = siteFormat((ch) => ch.paragraphs, ['t2']);
  const zh = collapseBlanks(siteFormat((ch) => translate(ch.paragraphs), ['t2'], { missing: ['t3'] }));
  const conv = convertSiteFormatLoose({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, true, JSON.stringify(conv));
  const t3 = conv.chapters.find((c) => c.chapterId === 't3');
  assert.equal(t3.missing, true, JSON.stringify(t3));
  assert.equal(conv.untranslated, 2);
  assert.deepEqual(conv.lines.slice(10), ['', '', '']);
});
await t('缺译标记：只有标记行才算空章（正文里出现「翻译缺失」字样不误判）', () => {
  const jp = siteFormat((ch) => ch.paragraphs);
  const zh = siteFormat((ch) => (ch.chapterId === 't1' ? ['これでGPT翻译缺失。の話は終わり。', ...translate(ch.paragraphs).slice(1)] : translate(ch.paragraphs)));
  const conv = convertSiteFormat({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, true, JSON.stringify(conv));
  assert.equal(conv.chapters.find((c) => c.chapterId === 't1').missing, false);
  assert.equal(conv.untranslated, 0);
});
await t('缺译标记：正文首行恰好等于标记串但后面有真译文 → 不误判（后瞻：标记后必须紧跟标记或标题）', () => {
  const jp = siteFormat((ch) => ch.paragraphs, ['t2']);
  const t2Lines = ['GPT翻译缺失。', ...translate(CHAPTERS[1].paragraphs).slice(1)];
  const zh = siteFormat((ch) => (ch.chapterId === 't2' ? t2Lines : translate(ch.paragraphs)), ['t2']);
  const conv = convertSiteFormat({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  assert.equal(conv.ok, true, JSON.stringify(conv));
  const t2 = conv.chapters.find((c) => c.chapterId === 't2');
  assert.equal(t2.missing, false, '不能当成缺译章（否则整章被清空并跳过上传）');
  assert.equal(t2.untranslated, 0);
  assert.deepEqual(conv.lines.slice(BUILT.chapters[1].start, BUILT.chapters[1].start + BUILT.chapters[1].count), t2Lines);
  assert.deepEqual(conv.lines.slice(BUILT.chapters[2].start), translate(CHAPTERS[2].paragraphs), '后续章不受错误 zhDrift 影响');
});
await t('文库：整本原文导出不存在 → 明确报错、不发请求', async () => {
  let calls = 0;
  const client = { getText: async () => { calls += 1; return ''; } };
  const book = { key: 'wenku:x', kind: 'wenku', novelId: 'x' };
  await assert.rejects(() => fetchSiteExportLines(client, book), /文库小说没有整本原文导出接口/);
  assert.equal(calls, 0, '不该发出必然 400 的请求');
  const web = { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' };
  assert.deepEqual(await fetchSiteExportLines(client, web), []);
  assert.equal(calls, 1);
});
await t('alignLgResult：文库命中站点格式 → 直接失败、不空转退避重试（0 请求、不等待）', async () => {
  let calls = 0;
  const client = { getText: async () => { calls += 1; return ''; } };
  const book = { key: 'wenku:x', kind: 'wenku', novelId: 'x' };
  const manifest = manifestOf(book, BUILT);
  const t0 = Date.now();
  const r = await alignLgResult({ client, book, manifest, resultLines: [...SITE_HEAD, '# 章 一', '', 'x'], rounds: 3, roundDelayMs: 2000 });
  assert.equal(r.converted, false);
  assert.ok(/文库小说没有整本原文导出接口/.test(r.alignError || ''), r.alignError);
  assert.equal(calls, 0, '不该发请求');
  assert.ok(Date.now() - t0 < 300, `不该按轮次退避等待（用了 ${Date.now() - t0}ms）`);
});
await t('verifyImport：文库行数不符 → 附上「请用导出原文的契约格式」提示', async () => {
  const manifest = manifestOf({ key: 'wenku:x', kind: 'wenku', novelId: 'x' }, BUILT);
  const r = await verifyImport({ resultLines: ['a'], manifest, getChapter: identityGet });
  assert.equal(r.ok, false);
  assert.ok(/行数不符/.test(r.globalError) && /该分段翻译缺失/.test(r.globalError), r.globalError);
});
await t('verifyImport：整章无译文（标记铺空）→ 只跳过该章，理由说清', async () => {
  const jp = siteFormat((ch) => ch.paragraphs, ['t2']);
  const zh = siteFormat((ch) => translate(ch.paragraphs), ['t2'], { missing: ['t2'] });
  const conv = convertSiteFormat({ zhLines: zh, jpLines: jp, manifest: MANIFEST });
  const r = await verifyImport({ resultLines: conv.lines, manifest: MANIFEST, getChapter: identityGet });
  assert.equal(r.ok, false);
  const t2 = r.chapters.find((c) => c.chapterId === 't2');
  assert.ok(/没有译文/.test(t2.reason), t2.reason);
  assert.equal(r.okCount, 2, JSON.stringify(r.chapters.map((c) => [c.chapterId, c.ok, c.reason])));
});

await t('alignLgResult：严格失败 → 自动回落折叠空行版（convertMode=loose）', async () => {
  const client = { getText: async () => siteFormat((ch) => ch.paragraphs, ['t2']).join('\n') };
  const book = { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' };
  const zh = collapseBlanks(siteFormat((ch) => translate(ch.paragraphs), ['t2']));
  const r = await alignLgResult({ client, book, manifest: MANIFEST, resultLines: zh });
  assert.equal(r.converted, true, JSON.stringify(r));
  assert.equal(r.convertMode, 'loose');
  assert.ok(/折叠空行版/.test(r.note), r.note);
  assert.equal(r.sitefmt.blankCollapsed, true);
  assert.deepEqual(r.lines, translate(splitResultLines(BUILT.text)));
});
await t('alignLgResult：严格模式命中时 convertMode=strict（宽松路径不介入）', async () => {
  const client = { getText: async () => siteFormat((ch) => ch.paragraphs, ['t2']).join('\n') };
  const book = { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' };
  const r = await alignLgResult({ client, book, manifest: MANIFEST, resultLines: siteFormat((ch) => translate(ch.paragraphs), ['t2']) });
  assert.equal(r.converted, true, JSON.stringify(r));
  assert.equal(r.convertMode, 'strict');
});

// ---- 401 收口 / 断点续跑钩子 / 提交后回读校验 ----
console.log('== 401 收口与断点 ==');
await t('verifyImport：401 → 立即中止、needAuth、已校验章带回', async () => {
  const report = await verifyImport({
    resultLines: translate(splitResultLines(BUILT.text)),
    manifest: MANIFEST,
    getChapter: async (id) => {
      if (id === 't2') { const e = new Error('401 未授权：token 失效，请重新同步凭据'); e.code = 'unauthorized'; throw e; }
      return { paragraphJp: chapterStore.get(id), glossaryId: GLOSSARY_ID };
    },
    authRetryAttempts: 0,
  });
  assert.equal(report.needAuth, true, JSON.stringify(report).slice(0, 240));
  assert.ok(/401/.test(report.globalError), report.globalError);
  assert.equal(report.chapters.length, 1, '中止前只校验了第 1 章（不再逐章发无效请求）');
  assert.equal(report.okCount, 1);
});
await t('verifyImport：权限类 401（forbidden）→ 不当成凭据失效（不中止、不重试、报原由）', async () => {
  let t2Calls = 0;
  const report = await verifyImport({
    resultLines: translate(splitResultLines(BUILT.text)),
    manifest: MANIFEST,
    getChapter: async (id) => {
      if (id === 't2') { t2Calls += 1; const e = new Error('401 无权限：账号被限制或权限不足——术语表写入需 member 且注册满 30 天'); e.code = 'forbidden'; throw e; }
      return { paragraphJp: chapterStore.get(id), glossaryId: GLOSSARY_ID };
    },
    authRetryAttempts: 2, authRetryDelayMs: 0,
  });
  assert.equal(report.needAuth, undefined, '权限问题不该触发 need-auth（重推凭据也没用）');
  assert.equal(t2Calls, 1, '不该退避重试权限错误');
  assert.equal(report.okCount, 2, '只跳过该章，其余照常');
  const t2 = report.chapters.find((c) => c.chapterId === 't2');
  assert.ok(/无权限/.test(t2.reason), t2.reason);
});
await t('verifyImport：401 抖动 → 退避重试后继续（不误判为凭据失效）', async () => {
  let first = true;
  const report = await verifyImport({
    resultLines: translate(splitResultLines(BUILT.text)),
    manifest: MANIFEST,
    getChapter: async (id) => {
      if (id === 't2' && first) { first = false; const e = new Error('401 未授权'); e.code = 'unauthorized'; throw e; }
      return { paragraphJp: chapterStore.get(id), glossaryId: GLOSSARY_ID };
    },
    authRetryAttempts: 2, authRetryDelayMs: 0,
  });
  assert.equal(report.ok, true, JSON.stringify(report.chapters.filter((c) => !c.ok)));
  assert.equal(report.okCount, 3);
  assert.equal(report.needAuth, undefined);
});
await t('applyImportReport：401 → 停止本批（stopped=need-auth），后续章不再发请求', async () => {
  const uploadedIds = [];
  const client = {
    uploadChapter: async (book, id) => {
      if (id === 't2') { const e = new Error('401 未授权'); e.code = 'unauthorized'; throw e; }
      uploadedIds.push(id);
    },
  };
  const chapters = ['t1', 't2', 't3'].map((id) => ({ chapterId: id, ok: true, glossaryId: 'g', paragraphsZh: [`z-${id}`], count: 1, volumeId: '' }));
  const r = await applyImportReport(client, { kind: 'web' }, { chapters }, { authRetryAttempts: 0 });
  assert.equal(r.stopped, 'need-auth', JSON.stringify(r));
  assert.equal(r.uploaded, 1);
  assert.deepEqual(uploadedIds, ['t1'], '401 后不再尝试后续章');
  assert.equal(r.results.filter((x) => x.status === 'failed').length, 1);
});
await t('applyImportReport：onUploaded 逐章回调（断点落库钩子）', async () => {
  const seen = [];
  const client = { uploadChapter: async () => { } };
  const chapters = ['t1', 't2'].map((id) => ({ chapterId: id, ok: true, glossaryId: 'g', paragraphsZh: [`z-${id}`], count: 1 }));
  const r = await applyImportReport(client, {}, { chapters }, { onUploaded: (c) => seen.push(c.chapterId) });
  assert.deepEqual(seen, ['t1', 't2']);
  assert.equal(r.uploaded, 2);
  assert.equal(r.stopped, '');
});
await t('manifestFingerprint / chapterContentSha：内容或清单变则 sha 变', () => {
  const fp1 = manifestFingerprint(MANIFEST);
  const fp2 = manifestFingerprint({ chapters: MANIFEST.chapters.map((c, i) => (i === 0 ? { ...c, count: c.count + 1 } : c)) });
  assert.equal(fp1.length, 40);
  assert.notEqual(fp1, fp2);
  assert.equal(chapterContentSha(['a', '', 'b']), chapterContentSha(['a', '', 'b']));
  assert.notEqual(chapterContentSha(['a', '', 'b']), chapterContentSha(['a', 'b', '']));
  assert.equal(chapterContentSha(['a', null]), chapterContentSha(['a', '']));
});

console.log('== 提交后回读校验（本地 txt vs 站点译文） ==');
const readbackClient = (siteZh) => ({
  getBookZhText: async () => siteZh.join('\n'),
  getTranslateTasks: async () => [{ volumeId: '', toc: CHAPTERS.map((c) => ({ chapterId: c.chapterId, titleJp: c.title })) }],
});
await t('verifySubmitted：站点格式本地文件 vs 站点译文 → 全一致', async () => {
  const siteZh = siteFormat((ch) => translate(ch.paragraphs));
  const r = await verifySubmitted({ client: readbackClient(siteZh), book: { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' }, resultLines: siteZh });
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
  assert.equal(r.okCount, 3);
  assert.equal(r.total, 3);
  assert.equal(r.mode, 'site-format');
  // 夹具的「译文」是【译】+原文（仍含假名）→ 假名残留计数应等于站点侧非空行数（指标本身工作）
  assert.equal(r.kanaLines, 9);
});
await t('verifySubmitted：本地某章被改 → 只报该章不一致（带首差行）', async () => {
  const siteZh = siteFormat((ch) => translate(ch.paragraphs));
  const local = siteFormat((ch) => (ch.chapterId === 't2' ? translate(ch.paragraphs).map((l, i) => (i === 0 ? `【改】${l}` : l)) : translate(ch.paragraphs)));
  const r = await verifySubmitted({ client: readbackClient(siteZh), book: { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' }, resultLines: local });
  assert.equal(r.ok, false);
  assert.equal(r.okCount, 2);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].chapterId, 't2');
  assert.ok(r.mismatches[0].first && /【改】/.test(r.mismatches[0].first.local), JSON.stringify(r.mismatches[0]));
});
await t('verifySubmitted：契约格式（带清单）→ 逐章切片比对；缺行报不一致', async () => {
  const siteZh = siteFormat((ch) => translate(ch.paragraphs));
  const contract = translate(splitResultLines(BUILT.text));
  const r = await verifySubmitted({ client: readbackClient(siteZh), book: { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' }, resultLines: contract, manifest: MANIFEST });
  assert.equal(r.mode, 'contract');
  assert.equal(r.okCount, 3, JSON.stringify(r.mismatches));
  const short = contract.slice();
  short[0] = '【掉了一行】';
  const r2 = await verifySubmitted({ client: readbackClient(siteZh), book: { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' }, resultLines: short, manifest: MANIFEST });
  assert.equal(r2.okCount, 2);
  assert.equal(r2.mismatches[0].chapterId, 't1');
});
await t('verifySubmitted：站点章节块数与章节数不符 → globalError（不猜）', async () => {
  const siteZh = siteFormat((ch) => translate(ch.paragraphs)).slice(0, 20);
  const r = await verifySubmitted({ client: readbackClient(siteZh), book: { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' }, resultLines: siteZh });
  assert.equal(r.ok, false);
  assert.ok(/章节块数|不符/.test(r.globalError), r.globalError);
});
await t('verifySubmitted：本地文件既非契约也非站点格式 → globalError', async () => {
  const siteZh = siteFormat((ch) => translate(ch.paragraphs));
  const r = await verifySubmitted({ client: readbackClient(siteZh), book: { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' }, resultLines: ['随便几行', '不对'] });
  assert.equal(r.ok, false);
  assert.ok(/无法逐章比对/.test(r.globalError), r.globalError);
});
await t('verifySubmitted：两侧都是缺译标记但标记不同（百度 vs GPT）→ 如实报不一致（不折叠成空蒙混）', async () => {
  const book = { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' };
  const siteZh = siteFormat((ch) => translate(ch.paragraphs), [], { missing: ['t2'] });
  // 本地同结构，但 t2 写的是另一家的标记
  const local = siteFormat((ch) => translate(ch.paragraphs));
  local.splice(local.indexOf('# 章 二') + 2, 4, '百度翻译缺失。', '', '', '');
  const r = await verifySubmitted({ client: readbackClient(siteZh), book, resultLines: local });
  assert.equal(r.ok, false, JSON.stringify(r.mismatches));
  assert.equal(r.okCount, 2);
  assert.equal(r.mismatches[0].chapterId, 't2');
  // 同标记（两侧都是「GPT翻译缺失。」）仍算一致
  const r2 = await verifySubmitted({ client: readbackClient(siteZh), book, resultLines: siteZh });
  assert.equal(r2.ok, true, JSON.stringify(r2.mismatches));
  assert.equal(r2.okCount, 3);
});

console.log('== runner：断点续跑 / 401 need-auth ==');
const runnerTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-align-runner-'));
const LG_BOOK = { key: 'web:mock/x', kind: 'web', providerId: 'mock', novelId: 'x' };
const lgManifest = manifestOf(LG_BOOK, BUILT);
const lgTxt = path.join(runnerTmp, 'lg-result.txt');
fs.writeFileSync(lgTxt, translate(splitResultLines(BUILT.text)).join('\n'), 'utf8');
const lgManifestFile = path.join(runnerTmp, 'lg-result.txt.manifest.json');
fs.writeFileSync(lgManifestFile, JSON.stringify(lgManifest), 'utf8');
const fakeStore = () => {
  const chunks = new Map(); const runs = []; const cfg = {}; const books = {};
  return {
    chunks, runs, cfg, books,
    getChunk: (k, id) => chunks.get(`${k}/${id}`),
    putChunk: (k, id, v) => { chunks.set(`${k}/${id}`, JSON.parse(JSON.stringify(v))); },
    startRun: (bookKey, job) => { runs.push({ bookKey, job, state: 'running' }); return runs.length; },
    finishRun: (id, state, stats) => { runs[id - 1].state = state; runs[id - 1].stats = stats; },
    getBook: (k) => ({ ...LG_BOOK, state: books[k] || '' }),
    setBookState: (k, s) => { books[k] = s; },
    setConfig: (k, v) => { cfg[k] = v; },
  };
};
const lgClient = ({ failChapter = '', failUpload = '', onUpload = null } = {}) => ({
  getText: async () => '',
  getChapterTask: async (book, id) => {
    if (failChapter && id === failChapter) { const e = new Error('401 未授权：token 失效'); e.code = 'unauthorized'; throw e; }
    return { paragraphJp: chapterStore.get(id), glossaryId: GLOSSARY_ID };
  },
  uploadChapter: async (book, id) => {
    if (failUpload && id === failUpload) { const e = new Error('401 未授权：token 失效'); e.code = 'unauthorized'; throw e; }
    if (onUpload) onUpload(id);
  },
});
await t('createLgImportRunner：首次全传 → 二次重跑全跳过（断点落 chunks）', async () => {
  const store = fakeStore();
  const runner = createLgImportRunner({ store, makeClient: () => lgClient(), log: { log: () => { }, error: () => { } } });
  const r1 = await runner.runBook('web:mock/x', { options: { txtPath: lgTxt, manifestPath: lgManifestFile } });
  assert.equal(r1.stats.uploaded, 3, JSON.stringify(r1.stats));
  assert.equal(r1.stats.skipped, 0);
  assert.equal(store.runs[0].state, 'done');
  const state = store.getChunk('web:mock/x', LG_IMPORT_STATE_KEY);
  assert.equal(Object.keys(state.done).length, 3, JSON.stringify(state));
  const r2 = await runner.runBook('web:mock/x', { options: { txtPath: lgTxt, manifestPath: lgManifestFile } });
  assert.equal(r2.stats.uploaded, 0, JSON.stringify(r2.stats));
  assert.equal(r2.stats.skipped, 3);
});
await t('createLgImportRunner：上传阶段 401 → need-auth（状态/自动请求重推/进度/run 记录）', async () => {
  const store = fakeStore();
  const uploaded = [];
  const runner = createLgImportRunner({ store, makeClient: () => lgClient({ failUpload: 't2', onUpload: (id) => uploaded.push(id) }), log: { log: () => { }, error: () => { } } });
  const progress = [];
  await assert.rejects(
    () => runner.runBook('web:mock/x', { options: { txtPath: lgTxt, manifestPath: lgManifestFile, authRetryAttempts: 0 }, progress: (p) => progress.push(p) }),
    /401/,
  );
  assert.deepEqual(uploaded, ['t1'], '401 后不再发后续上传');
  assert.equal(store.books['web:mock/x'], 'need-auth', 'book.state 应转 need-auth');
  assert.ok(store.cfg.authRequest && store.cfg.authRequest.at, '应自动置 authRequest（站点侧重推凭据）');
  assert.equal(store.runs[0].state, 'failed');
  assert.equal(store.runs[0].stats.needAuth, true, JSON.stringify(store.runs[0].stats));
  assert.ok(progress.some((p) => p.phase === 'need-auth'), JSON.stringify(progress.slice(-2)));
  // 断点保留：续跑只补剩下的章
  const store2 = fakeStore();
  for (const [k, v] of store.chunks) store2.chunks.set(k, v);   // 复用同一份断点状态
  Object.assign(store2.books, store.books);                      // 与生产一致：need-auth 状态还在书行上
  const r2 = await createLgImportRunner({ store: store2, makeClient: () => lgClient(), log: { log: () => { }, error: () => { } } })
    .runBook('web:mock/x', { options: { txtPath: lgTxt, manifestPath: lgManifestFile } });
  assert.equal(r2.stats.uploaded, 2, JSON.stringify(r2.stats));
  assert.equal(r2.stats.skipped, 1);
  assert.equal(store2.books['web:mock/x'], 'done', '续跑成功后清掉 need-auth');
});
await t('createLgImportRunner：校验阶段 401 → need-auth（不再逐章发无效请求）', async () => {
  const store = fakeStore();
  let calls = 0;
  const client = lgClient({ failChapter: 't2' });
  const counting = { ...client, getChapterTask: async (...a) => { calls += 1; return client.getChapterTask(...a); } };
  await assert.rejects(
    () => createLgImportRunner({ store, makeClient: () => counting, log: { log: () => { }, error: () => { } } })
      .runBook('web:mock/x', { options: { txtPath: lgTxt, manifestPath: lgManifestFile, authRetryAttempts: 0 } }),
    /401/,
  );
  assert.equal(calls, 2, '校验到 t2 即中止（t1、t2 各一次），不再请求 t3');
  assert.equal(store.books['web:mock/x'], 'need-auth');
});
await t('createLgReadbackRunner：全一致 → runs done；401 → need-auth + 自动请求重推', async () => {
  const store = fakeStore();
  const siteZh = siteFormat((ch) => translate(ch.paragraphs));
  const okRunner = createLgReadbackRunner({
    store, log: { log: () => { }, error: () => { } },
    makeClient: () => ({ getBookZhText: async () => siteZh.join('\n'), getTranslateTasks: async () => [{ volumeId: '', toc: CHAPTERS.map((c) => ({ chapterId: c.chapterId, titleJp: c.title })) }] }),
  });
  const r = await okRunner.runBook('web:mock/x', { options: { txtPath: lgTxt, manifestPath: lgManifestFile } });
  assert.equal(r.stats.ok, 3, JSON.stringify(r.stats));
  assert.equal(store.runs[0].state, 'done');
  const store2 = fakeStore();
  const badRunner = createLgReadbackRunner({
    store: store2, log: { log: () => { }, error: () => { } },
    makeClient: () => ({
      getTranslateTasks: async () => [{ volumeId: '', toc: CHAPTERS.map((c) => ({ chapterId: c.chapterId, titleJp: c.title })) }],
      getBookZhText: async () => { const e = new Error('401 未授权：token 失效'); e.code = 'unauthorized'; throw e; },
    }),
  });
  await assert.rejects(() => badRunner.runBook('web:mock/x', { options: { txtPath: lgTxt } }), /401/);
  assert.equal(store2.books['web:mock/x'], 'need-auth');
  assert.ok(store2.cfg.authRequest && store2.cfg.authRequest.at);
  assert.equal(store2.runs[0].state, 'failed');
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
