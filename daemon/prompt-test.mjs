// daemon/prompt-test.mjs —— 提示词模板纯函数单测（无需 mock）
import assert from 'node:assert/strict';
import { renderSystemPrompt, resolveTemplate, DEFAULT_TEMPLATE, FORMAT_RULES } from './prompt.mjs';
import { TRANSLATE_SYSTEM_PROMPT, buildTranslateMessages } from './translate.mjs';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
};

console.log('== 提示词模板：默认与校验 ==');
t('默认模板渲染 == 站点镜像系统提示（逐字）', () => {
  const r = renderSystemPrompt(DEFAULT_TEMPLATE);
  assert.equal(r.text, TRANSLATE_SYSTEM_PROMPT);
  assert.equal(r.usedDefault, false);
  assert.deepEqual(r.warnings, []);
});
t('协议段由代码注入（行数/不加说明）', () => {
  assert.ok(/行数/.test(FORMAT_RULES) && /(不要|不得)/.test(FORMAT_RULES), FORMAT_RULES);
});
t('base 缺 {format_rules} → 回退默认并告警', () => {
  const r = renderSystemPrompt({ base: '随便说说就好。' });
  assert.equal(r.text, TRANSLATE_SYSTEM_PROMPT);
  assert.ok(r.usedDefault && r.warnings.length > 0, JSON.stringify(r));
});
t('过短的 base → 回退默认', () => {
  const r = renderSystemPrompt({ base: '短' });
  assert.equal(r.text, TRANSLATE_SYSTEM_PROMPT);
});
t('{source_language}/{target_language} 替换', () => {
  const r = renderSystemPrompt(
    { prefix: '把{source_language}翻译成{target_language}。', base: '{source_language}风格保持一致。{format_rules}' },
    { sourceLanguage: '日文', targetLanguage: '繁体中文' },
  );
  assert.ok(r.text.startsWith('把日文翻译成繁体中文。'), r.text);
  assert.ok(r.text.includes('日文风格保持一致。'), r.text);
});
t('只给 base 也可用（prefix 空时不留空行）', () => {
  const r = renderSystemPrompt({ prefix: '', base: '{format_rules}' });
  assert.equal(r.text, FORMAT_RULES);
  assert.equal(r.usedDefault, false);
});

console.log('== 提示词模板：槽位解析 ==');
t('按书覆盖全局；空白槽视为未设置', () => {
  const rows = [
    { bookKey: '', slot: 'base', text: '全局基座。{format_rules}' },
    { bookKey: 'web:a/1', slot: 'base', text: '书的基座。{format_rules}' },
    { bookKey: '', slot: 'thinking', text: '   ' },
  ];
  assert.equal(resolveTemplate(rows, 'web:a/1').base, '书的基座。{format_rules}');
  assert.equal(resolveTemplate(rows, 'web:a/2').base, '全局基座。{format_rules}');
  assert.equal(resolveTemplate(rows, 'web:a/2').thinking, DEFAULT_TEMPLATE.thinking);
  assert.equal(resolveTemplate(rows, 'web:a/2').suffix, DEFAULT_TEMPLATE.suffix);
});

console.log('== 提示词模板：用户消息与协议不变量 ==');
t('thinking 注入在用户消息最前，编号/单行段协议不变', () => {
  const plain = buildTranslateMessages(['こんにちは'], {});
  const withThink = buildTranslateMessages(['こんにちは'], {}, { thinking: '先在心里分析，不要输出分析过程。' });
  assert.ok(withThink[1].content.startsWith('【思考指引】'), withThink[1].content.slice(0, 40));
  assert.ok(withThink[1].content.includes('#1:こんにちは'), withThink[1].content);
  assert.ok(withThink[1].content.trimEnd().endsWith('原文到此为止'), withThink[1].content);
  assert.equal(plain[1].content.includes('思考指引'), false);
});
t('术语表注入段顺序不受模板影响', () => {
  const messages = buildTranslateMessages(['アリスが来た'], { 'アリス': '爱丽丝 #女性' });
  const content = messages[1].content;
  assert.ok(content.startsWith('翻译的时候参考下面的术语表：'), content);
  assert.ok(content.includes('アリス => 爱丽丝 #女性'), content);
});
t('systemPrompt 可覆盖，默认不变', () => {
  assert.equal(buildTranslateMessages(['a'], {})[0].content, TRANSLATE_SYSTEM_PROMPT);
  assert.equal(buildTranslateMessages(['a'], {}, { systemPrompt: '自定义系统提示' })[0].content, '自定义系统提示');
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
