// daemon/glossary-io-test.mjs —— LG 术语表互通纯函数单测（无需 mock；engine 用于门槛/值格式）
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseLgGlossary, planImport, toLgGlossary } from './glossary-io.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { loadEngine } = await import(pathToFileURL(path.join(here, 'engine.mjs')).href);
const engine = await loadEngine();

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
};

console.log('== LG 互通：解析 ==');
t('数组解析：字段归一 + 同 src 后者覆盖（重复有记录）', () => {
  const { entries, duplicates } = parseLgGlossary(JSON.stringify([
    { src: 'アルテ', dst: '阿尔蒂', info: '女性' },
    { src: 'ローズ', dst: '罗丝琳', regex: false, case_sensitive: true },
    { src: 'アルテ', dst: '阿尔提' },
    { src: '', dst: 'X' },
  ]));
  assert.equal(entries.length, 2, JSON.stringify(entries));
  assert.deepEqual(duplicates, ['アルテ']);
  assert.equal(entries[0].dst, '阿尔提');
  assert.equal(entries[1].caseSensitive, true);
});
t('映射解析：{src: dst} → info 空、regex false', () => {
  const { entries } = parseLgGlossary('{"アルテ":"阿尔蒂"}');
  assert.deepEqual(entries, [{ src: 'アルテ', dst: '阿尔蒂', info: '', regex: false, caseSensitive: false }]);
});
t('非法输入抛错', () => {
  assert.throws(() => parseLgGlossary('42'));
  assert.throws(() => parseLgGlossary('not json'));
});

console.log('== LG 互通：导入计划 ==');
t('regex 分流、门槛拦截（改原文）、值带 #备注', () => {
  const plan = planImport({
    entries: [
      { src: 'アルテ', dst: '阿尔蒂', info: '女性', regex: false, caseSensitive: false },
      { src: 'rem0', dst: 'XX', info: '', regex: false, caseSensitive: false },
      { src: 'レ.*ス', dst: '替换', info: '', regex: true, caseSensitive: false },
      { src: 'ローズ', dst: '罗丝琳', info: '', regex: false, caseSensitive: true },
    ],
    currentGlossary: {},
    engine,
  });
  assert.deepEqual(plan.additions.map((x) => [x.src, x.value]), [['アルテ', '阿尔蒂 #女性'], ['ローズ', '罗丝琳']], JSON.stringify(plan.additions));
  assert.equal(plan.skipped.length, 1);
  assert.ok(plan.skipped[0].reasons.length > 0, JSON.stringify(plan.skipped[0]));
  assert.equal(plan.regexRules.length, 1);
  assert.deepEqual(plan.noteIgnored, ['ローズ']);
});
t('与现表 diff：新增/更新/相同', () => {
  const plan = planImport({
    entries: [
      { src: 'アルテ', dst: '阿尔蒂', info: '女性' },   // 与现表不同（无备注）→ 更新
      { src: 'ローズ', dst: '罗丝琳', info: '' },        // 与现表相同
      { src: '新角色', dst: '新角色译', info: '' },      // 新增
    ],
    currentGlossary: { 'アルテ': '阿尔蒂', 'ローズ': '罗丝琳' },
    engine,
  });
  assert.equal(plan.additions.length, 1, JSON.stringify(plan));
  assert.equal(plan.updates.length, 1, JSON.stringify(plan));
  assert.equal(plan.updates[0].before, '阿尔蒂');
  assert.deepEqual(plan.same, ['ローズ']);
});

console.log('== LG 互通：导出与往返 ==');
t('导出：info 取自 #备注、无备注为空串', () => {
  const list = toLgGlossary({ 'アルテ': '阿尔蒂 #女性', '東京': '东京' }, engine);
  assert.deepEqual(list.find((x) => x.src === 'アルテ'), { src: 'アルテ', dst: '阿尔蒂', info: '女性', regex: false, case_sensitive: false });
  assert.equal(list.find((x) => x.src === '東京').info, '');
});
t('导出 → 解析 → 导入：往返 diff 为空', () => {
  const current = { 'アルテ': '阿尔蒂 #女性', '東京': '东京', '高瀬家': '高濑家 #家族' };
  const list = toLgGlossary(current, engine);
  const { entries } = parseLgGlossary(JSON.stringify(list));
  const plan = planImport({ entries, currentGlossary: current, engine });
  assert.equal(plan.additions.length + plan.updates.length, 0, JSON.stringify(plan));
  assert.equal(plan.same.length, 3, JSON.stringify(plan.same));
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
