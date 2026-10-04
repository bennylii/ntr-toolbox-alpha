// daemon/quality-test.mjs —— 质检纯函数单测（无需 mock；engine 仅用于术语落地检查）
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPair, checkAligned, foreignResidue, similarityWarning, punctuationMismatch, jaccard } from './quality.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { loadEngine } = await import(pathToFileURL(path.join(here, 'engine.mjs')).href);
const engine = await loadEngine();

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
};

console.log('== 质检：源语言残留（FOREIGN_CHAR_RESIDUE） ==');
t('全假名行 → 命中', () => assert.equal(foreignResidue('オルトは大声で叫んだ。'), true));
t('中文行 → 不命中', () => assert.equal(foreignResidue('阿尔蒂拔出了剑。'), false));
t('中文为主夹杂少量假名 → 不命中', () => assert.equal(foreignResidue('阿尔蒂说了声「はい」，然后拔出了剑。'), false));
t('英文行 → 不命中', () => assert.equal(foreignResidue('Alice drew her sword.'), false));

console.log('== 质检：相似度（SIMILARITY） ==');
t('完全相同（≥8 字）→ 命中', () => assert.equal(similarityWarning('オルトは大声で叫んだ。', 'オルトは大声で叫んだ。'), true));
t('一方包含另一方 → 命中', () => assert.equal(similarityWarning('アリスは魔導書を読んだ。', 'アリスは魔導書を読んだ、そして笑った。'), true));
t('正常译文 → 不命中', () => assert.equal(similarityWarning('アリスは魔導書を読んだ。', '爱丽丝读了魔导书。'), false));
t('Jaccard 边界：0.818 命中 / 0.667 不命中', () => {
  assert.ok(jaccard('ABCDEFGHIJ', 'ABCDEFGHIX') > 0.8);
  assert.ok(jaccard('ABCDEFGHIJ', 'ABCDEFGHXY') <= 0.8);
});

console.log('== 质检：标点（PUNCTUATION_MISMATCH） ==');
t('句末标点缺失 → 命中', () => assert.equal(punctuationMismatch('彼女は静かに言った。', '她静静地低语'), true));
t('两侧句末标点齐 → 不命中', () => assert.equal(punctuationMismatch('魔王が現れた。', '魔王出现了。'), false));
t('引号不平衡 → 命中', () => assert.equal(punctuationMismatch('「おはよう」', '「早上好'), true));
t('对话行收尾引号一致 → 不命中', () => assert.equal(punctuationMismatch('「おはよう」', '「早上好」'), false));

console.log('== 质检：术语落地 / 缺译 / 重试 ==');
t('术语未落地 → GLOSSARY（带命中术语）', () => {
  const r = checkPair({ jp: 'ローズは微笑んだ。', zh: '罗丝微微一笑。' }, { glossary: { 'ローズ': '罗丝琳 #女性' }, engine });
  assert.deepEqual(r.codes, ['GLOSSARY'], JSON.stringify(r));
  assert.deepEqual(r.missedTerms, ['ローズ']);
});
t('术语落地 → 无码', () => {
  const r = checkPair({ jp: 'アルテは剣を抜いた。', zh: '阿尔蒂拔出了剑。' }, { glossary: { 'アルテ': '阿尔蒂 #女性' }, engine });
  assert.deepEqual(r.codes, [], JSON.stringify(r));
});
t('缺译（空译文）→ LINE_COUNT_MISMATCH', () => {
  const r = checkPair({ jp: '勇者が立ち上がった。', zh: '' }, {});
  assert.ok(r.codes.includes('LINE_COUNT_MISMATCH'), JSON.stringify(r));
});
t('重试 ≥2 → RETRY_THRESHOLD', () => {
  const r = checkPair({ jp: 'アリスは笑った。', zh: '爱丽丝笑了。' }, { retries: 2 });
  assert.deepEqual(r.codes, ['RETRY_THRESHOLD'], JSON.stringify(r));
});

console.log('== 质检：批量报告（对齐 mock-check 夹具） ==');
const FIXTURE = (() => {
  const jp = [
    '# 第一章',
    'アリスは魔導書を読んだ。', '爱丽丝读了魔导书。',
    'ローズは微笑んだ。', '罗丝微微一笑。',
    'アルテは剣を抜いた。', '阿尔蒂拔出了剑。',
    'オルトは大声で叫んだ。', 'オルトは大声で叫んだ。',
    '彼女は静かに言った。', '她静静地低语',
    '# 第二章',
    '魔王が現れた。', '魔王出现了。',
    '# 第三章',
    '勇者が立ち上がった。', '（翻译缺失）',
  ];
  const text = jp.join('\n');
  const parsed = engine.parseParallelText(text);
  const report = checkAligned({
    pairs: parsed.pairs,
    glossary: { 'アルテ': '阿尔蒂 #女性', 'ローズ': '罗丝琳 #女性' },
    engine,
    translationMissing: parsed.translationMissing,
    limit: 8,
  });
  return { parsed, report };
})();
t('配对 6 个、缺译 1 个', () => {
  assert.equal(FIXTURE.parsed.pairs.length, 6, JSON.stringify(FIXTURE.parsed));
  assert.equal(FIXTURE.parsed.translationMissing, 1);
});
t('七码计数与预期一致（各 1，其余为 0）', () => {
  assert.deepEqual(FIXTURE.report.codes, {
    GLOSSARY: 1,
    FOREIGN_CHAR_RESIDUE: 1,
    SIMILARITY: 1,
    PUNCTUATION_MISMATCH: 1,
    LINE_COUNT_MISMATCH: 1,
  }, JSON.stringify(FIXTURE.report.codes));
});
t('样例带码/章节/截断文本，且受 limit 约束', () => {
  assert.ok(FIXTURE.report.samples.length >= 5 && FIXTURE.report.samples.length <= 8, JSON.stringify(FIXTURE.report.samples.length));
  const g = FIXTURE.report.samples.find((s) => s.code === 'GLOSSARY');
  assert.ok(g && g.detail === 'ローズ' && /微微一笑/.test(g.zh), JSON.stringify(g));
});
t('codes 过滤只保留指定码', () => {
  const only = checkAligned({
    pairs: FIXTURE.parsed.pairs,
    glossary: { 'ローズ': '罗丝琳 #女性' },
    engine,
    translationMissing: FIXTURE.parsed.translationMissing,
    codes: ['SIMILARITY'],
  });
  assert.deepEqual(only.codes, { SIMILARITY: 1 }, JSON.stringify(only.codes));
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
