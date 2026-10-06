// daemon/quality-test.mjs —— 质检纯函数单测（算法 v2，对齐 LinguaGacha；engine 仅用于术语落地检查）
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPair, checkAligned, foreignResidue, foreignResidueFragments, similarityWarning, punctuationMismatch, preserveMisses, jaccard } from './quality.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { loadEngine } = await import(pathToFileURL(path.join(here, 'engine.mjs')).href);
const engine = await loadEngine();

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
};

console.log('== 质检：源语言残留（FOREIGN_CHAR_RESIDUE，v2 字素+书写系统分类） ==');
t('全假名行 → 命中', () => assert.equal(foreignResidue('オルトは大声で叫んだ。'), true));
t('中文行 → 不命中', () => assert.equal(foreignResidue('阿尔蒂拔出了剑。'), false));
t('中文夹假名（任何量）→ 命中（LG：非目标脚本即残留）', () => assert.equal(foreignResidue('阿尔蒂说了声「はい」，然后拔出了剑。'), true));
t('英文整行 → 命中（未翻译残留）', () => assert.equal(foreignResidue('Alice drew her sword.'), true));
t('短大写缩写豁免：OK / ABC → 不命中', () => {
  assert.equal(foreignResidue('他说 OK。'), false);
  assert.equal(foreignResidue('代号 ABC 行动。'), false);
});
t('超长/带小写拉丁串 → 命中（OpenAI / Hello）', () => {
  assert.deepEqual(foreignResidueFragments('用了 OpenAI 的接口。'), ['OpenAI']);
  assert.deepEqual(foreignResidueFragments('她说 Hello。'), ['Hello']);
});
t('单字素拉丁豁免，但混其它脚本不豁免：A 不报 / Aあ 报', () => {
  assert.equal(foreignResidue('编号 A。'), false);
  assert.deepEqual(foreignResidueFragments('编号 Aあ。'), ['Aあ']);
});
t('西里尔文残留 → 命中（中文行里的非目标脚本）', () => assert.equal(foreignResidue('他说 Привет。'), true));
t('相邻残留合并为片段证据', () => assert.deepEqual(foreignResidueFragments('他说 はい、そう です。'), ['はい', 'そう', 'です']));

console.log('== 质检：相似度（SIMILARITY，v2 原始文本 + JA→ZH 残留护栏） ==');
t('完全相同 → 命中（有残留证据）', () => assert.equal(similarityWarning('オルトは大声で叫んだ。', 'オルトは大声で叫んだ。'), true));
t('原始文本包含（一方是另一方前缀）→ 命中', () => assert.equal(similarityWarning('アリスは魔導書を読んだ。', 'アリスは魔導書を読んだ。そして笑った。'), true));
t('正常译文 → 不命中', () => assert.equal(similarityWarning('アリスは魔導書を読んだ。', '爱丽丝读了魔导书。'), false));
t('JA→ZH 护栏：汉字-heavy 相似但无残留 → 不命中', () => {
  // 相似度命中（包含关系）但译文无残留证据 → 视为合法直译，不报（LG 同款策略）
  assert.equal(similarityWarning('魔王城門前', '魔王城門前立'), false);
});
t('护栏可关（requireResidueEvidence:false）→ 报', () => {
  assert.equal(similarityWarning('魔王城門前', '魔王城門前立', { requireResidueEvidence: false }), true);
});
t('Jaccard 边界：0.818 命中 / 0.667 不命中', () => {
  assert.ok(jaccard('ABCDEFGHIJ', 'ABCDEFGHIX') > 0.8);
  assert.ok(jaccard('ABCDEFGHIJ', 'ABCDEFGHXY') <= 0.8);
});

console.log('== 质检：标点（PUNCTUATION_MISMATCH，v2 组序列） ==');
t('句末标点差异但结构一致 → 不命中（LG：只比结构）', () => assert.equal(punctuationMismatch('彼女は静かに言った。', '她静静地低语'), false));
t('引号不平衡 → 命中', () => assert.equal(punctuationMismatch('「おはよう」', '「早上好'), true));
t('对话行收尾引号一致 → 不命中', () => assert.equal(punctuationMismatch('「おはよう」', '「早上好」'), false));
t('引号变体（「」→“”）→ 不命中（LG 已知取舍）', () => assert.equal(punctuationMismatch('「おはよう」', '“早上好”'), false));
t('括号类型变化（数量同、类别不同）→ 命中', () => assert.equal(punctuationMismatch('（甲）', '【甲】'), true));
t('结构数量不同 → 命中', () => assert.equal(punctuationMismatch('「甲」と「乙」', '「甲乙」'), true));

console.log('== 质检：保留段（TEXT_PRESERVE，v2 实装） ==');
const PRESERVE_RULES = [{ kind: 'text_preserve', pattern: '<br>', regex: false, case_sensitive: true, priority: 100 }];
t('无规则 → 不检查（null）', () => assert.equal(preserveMisses('甲<br>乙', '甲乙', []), null));
t('保留段完整 → 通过（null）', () => assert.equal(preserveMisses('甲<br>乙', '丙<br>丁', PRESERVE_RULES), null));
t('保留段丢失 → 命中并带证据', () => {
  const r = preserveMisses('甲<br>乙', '甲乙', PRESERVE_RULES);
  assert.ok(r && r.sourceFragments.length === 1 && r.sourceFragments[0] === '<br>', JSON.stringify(r));
  assert.equal(r.translationFragments.length, 0);
});
t('保留段数量变化 → 命中', () => assert.ok(preserveMisses('甲<br>乙', '丙<br>丁<br>戊', PRESERVE_RULES)));
t('正则规则同款语义（priority 顺序、重叠规避）', () => {
  const rules = [{ kind: 'text_preserve', pattern: '\\{\\{[^}]+\\}\\}', regex: true, priority: 10 }];
  assert.equal(preserveMisses('前{{A}}后', '前{{A}}后', rules), null);
  assert.ok(preserveMisses('前{{A}}后', '前后', rules));
});
t('checkOnly 非空白过滤：空白片段差异不报（LG 语义）', () => {
  const rules = [{ kind: 'text_preserve', pattern: '\\s', regex: true, unicode: true, priority: 10 }];
  assert.equal(preserveMisses('甲 乙', '甲乙', rules), null);
});
t('非空白证据：<br> 丢失时证据只含非空白片段', () => {
  const rules = [
    { kind: 'text_preserve', pattern: '<br>', regex: true, priority: 10 },
    { kind: 'text_preserve', pattern: '\\s', regex: true, unicode: true, priority: 11 },
  ];
  const r = preserveMisses('甲<br> 乙', '甲 乙', rules);
  assert.ok(r && r.sourceFragments.length === 1 && r.sourceFragments[0] === '<br>', JSON.stringify(r));
  assert.equal(r.translationFragments.length, 0, JSON.stringify(r));
});
t('checkPair 集成：保留段丢失 → TEXT_PRESERVE 码', () => {
  const r = checkPair({ jp: '甲<br>乙', zh: '甲乙' }, { rules: PRESERVE_RULES });
  assert.ok(r.codes.includes('TEXT_PRESERVE'), JSON.stringify(r));
});

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
  const hits = [];
  const report = checkAligned({
    pairs: parsed.pairs,
    glossary: { 'アルテ': '阿尔蒂 #女性', 'ローズ': '罗丝琳 #女性' },
    engine,
    translationMissing: parsed.translationMissing,
    limit: 8,
    onHit: (pairIndex, hit, pair) => hits.push({ pairIndex, code: hit.code, chapterId: pair && pair.chapterId, detail: hit.detail }),
  });
  return { parsed, report, hits };
})();
t('配对 6 个、缺译 1 个', () => {
  assert.equal(FIXTURE.parsed.pairs.length, 6, JSON.stringify(FIXTURE.parsed));
  assert.equal(FIXTURE.parsed.translationMissing, 1);
});
t('v2 计数：残留/相似/术语/缺译 各 1（标点结构一致 → 0）', () => {
  assert.deepEqual(FIXTURE.report.codes, {
    FOREIGN_CHAR_RESIDUE: 1,
    SIMILARITY: 1,
    GLOSSARY: 1,
    LINE_COUNT_MISMATCH: 1,
  }, JSON.stringify(FIXTURE.report.codes));
});
t('onHit 全量回调（落库用）带 pairIndex/detail', () => {
  assert.ok(FIXTURE.hits.length >= 4, JSON.stringify(FIXTURE.hits));
  const g = FIXTURE.hits.find((h) => h.code === 'GLOSSARY');
  assert.ok(g && g.detail === 'ローズ' && g.pairIndex >= 0, JSON.stringify(g));
});
t('样例带码/章节/截断文本，且受 limit 约束', () => {
  assert.ok(FIXTURE.report.samples.length >= 4 && FIXTURE.report.samples.length <= 8, JSON.stringify(FIXTURE.report.samples.length));
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
