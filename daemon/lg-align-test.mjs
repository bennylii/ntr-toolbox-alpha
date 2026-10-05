// daemon/lg-align-test.mjs —— LG 对齐导入纯函数单测（无需 mock；getChapter 用桩）
import assert from 'node:assert/strict';
import { buildSourceExport, manifestOf, splitResultLines, verifyImport, MANIFEST_VERSION } from './lg-align.mjs';

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

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
