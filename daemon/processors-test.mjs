// daemon/processors-test.mjs —— 预处理/后处理链纯函数单测（无需 mock）
import assert from 'node:assert/strict';
import { createProcessor } from './processors.mjs';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
};

console.log('== 处理链：资源占位符投影/还原 ==');
t('URL/标签/控制码投影并逐字还原（无占位符残留）', () => {
  const p = createProcessor();
  const src = '访问 https://a.example/b?q=1 或 <b>标签</b>，\\N[1]结束。';
  const { text, ctx } = p.pre(src);
  assert.ok(!/https:/.test(text) && !/<b>/.test(text) && !/\\N\[1\]/.test(text), text);
  assert.ok(/\uE0000\uE001/.test(text), text);
  const r = p.post(text.replace(/^访问/, '打开'), ctx);
  assert.equal(r.fellBack, false, JSON.stringify(r));
  assert.ok(r.text.includes('https://a.example/b?q=1') && r.text.includes('<b>标签</b>') && r.text.includes('\\N[1]'), r.text);
  assert.ok(!/[\uE000\uE001]/.test(r.text), r.text);
});
t('资源占位符丢失 → 回退原文', () => {
  const p = createProcessor();
  const { ctx } = p.pre('看 https://a.example/x 这里。');
  const r = p.post('完全丢掉了占位符的译文。', ctx);
  assert.equal(r.fellBack, true, JSON.stringify(r));
  assert.ok(r.warnings.length > 0);
});

console.log('== 处理链：保留段（text_preserve） ==');
t('命中并还原；丢失时行尾补回原文片段', () => {
  const p = createProcessor({
    rules: [{ id: 1, kind: 'text_preserve', pattern: '<ruby>[^<]*</ruby>', regex: 1, replacement: '', enabled: 1, priority: 10 }],
    options: { resourceProtect: false },
  });
  const { text, ctx } = p.pre('请看 <ruby>注音</ruby> 这段。');
  assert.ok(/\uE1000\uE101/.test(text), text);
  assert.equal(p.post(text, ctx).text, '请看 <ruby>注音</ruby> 这段。');
  const dropped = p.post('请看 这段。', ctx);
  assert.ok(dropped.text.endsWith('<ruby>注音</ruby>'), dropped.text);
  assert.ok(dropped.warnings.length > 0, JSON.stringify(dropped));
});

console.log('== 处理链：前后替换表 ==');
t('literal 大小写不敏感 / 后替换生效', () => {
  const p = createProcessor({
    rules: [
      { id: 1, kind: 'pre_replacement', pattern: 'Alice', replacement: '爱丽丝', regex: 0, case_sensitive: 0, enabled: 1, priority: 10 },
      { id: 2, kind: 'post_replacement', pattern: '【模拟译】', replacement: '【译】', regex: 0, enabled: 1, priority: 10 },
    ],
  });
  assert.equal(p.pre('alice 与 ALICE').text, '爱丽丝 与 爱丽丝');
  const ctx = p.pre('普通行').ctx;
  assert.equal(p.post('【模拟译】译文', ctx).text, '【译】译文');
});
t('无效正则被跳过并记录', () => {
  const p = createProcessor({ rules: [{ id: 1, kind: 'pre_replacement', pattern: '([', regex: 1, replacement: 'x' }] });
  assert.equal(p.skipped.length, 1, JSON.stringify(p.skipped));
  assert.equal(p.pre('abc').text, 'abc');
});
t('priority 升序执行（后一条能看到前一条结果）', () => {
  const p = createProcessor({
    rules: [
      { id: 1, kind: 'pre_replacement', pattern: 'A5', replacement: 'A10', priority: 10 },
      { id: 2, kind: 'pre_replacement', pattern: 'A', replacement: 'A5', priority: 5 },
    ],
  });
  assert.equal(p.pre('A').text, 'A10');
});

console.log('== 处理链：标点与 ruby ==');
t('jp 句末 ！ → zh 半角 ! 转全角；源无句末标点则不动', () => {
  const p = createProcessor();
  const a = p.pre('行け！');
  assert.equal(p.post('去吧!', a.ctx).text, '去吧！');
  const b = p.pre('普通的一句');
  assert.equal(p.post('普通的一句?', b.ctx).text, '普通的一句?');
});
t('punctuation=off 不转换；full 恒转换', () => {
  const off = createProcessor({ options: { punctuation: 'off' } });
  assert.equal(off.post('去吧!', off.pre('行け！').ctx).text, '去吧!');
  const full = createProcessor({ options: { punctuation: 'full' } });
  assert.equal(full.post('普通?', full.pre('普通').ctx).text, '普通？');
});
t('ruby 清洗开/关', () => {
  const src = '｜漢字《かんじ》を見た。';
  assert.equal(createProcessor().pre(src).text, src);
  assert.equal(createProcessor({ options: { rubyClean: true } }).pre(src).text, '漢字を見た。');
});

console.log('== 处理链：不变量与版本 ==');
t('空行不处理、前后原样', () => {
  const p = createProcessor();
  const { text, ctx } = p.pre('   ');
  assert.equal(text, '   ');
  assert.equal(ctx, null);
  assert.equal(p.post('', ctx).text, '');
});
t('版本随规则变化、同规则稳定（段缓存键依赖版本）', () => {
  assert.equal(createProcessor().version, createProcessor().version);
  const withRule = createProcessor({ rules: [{ id: 1, kind: 'pre_replacement', pattern: 'x', replacement: 'y' }] });
  assert.notEqual(createProcessor().version, withRule.version);
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
