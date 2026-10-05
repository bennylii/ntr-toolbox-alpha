// daemon/agent-skills-test.mjs —— 技能目录单测（frontmatter/发现/读取/逃逸/目录注入；无需 mock）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter, createSkillCatalog } from './agent-skills.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + ((e && e.message) || e)); }
};

console.log('== 技能：frontmatter 解析 ==');
t('标准 frontmatter（含引号与布尔）', () => {
  const { meta, body } = parseFrontmatter('---\nname: demo\ndescription: "带引号 描述"\ndisable-model-invocation: true\n---\n# 标题\n正文');
  assert.equal(meta.name, 'demo');
  assert.equal(meta.description, '带引号 描述');
  assert.equal(meta['disable-model-invocation'], true);
  assert.ok(body.startsWith('# 标题'));
});
t('无 frontmatter → 空 meta、body 原文', () => {
  const { meta, body } = parseFrontmatter('# 只有正文');
  assert.deepEqual(meta, {});
  assert.equal(body, '# 只有正文');
});

console.log('== 技能：目录发现与读取 ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-'));
const mkSkill = (name, frontName, extra = {}) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${frontName}\ndescription: ${name} 的说明\n---\n\n# ${name}\n`);
  fs.writeFileSync(path.join(dir, 'references', 'rule.md'), `rule of ${name}`);
  if (extra.hidden) {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${frontName}\ndescription: ${name} 的说明\ndisable-model-invocation: true\n---\n\n# ${name}\n`);
  }
  if (extra.dup) fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: dup-name\ndescription: second\n---\n\n# x\n`);
};
mkSkill('alpha', 'alpha');
mkSkill('beta', 'beta', { hidden: true });
mkSkill('gamma', 'dup-name');
mkSkill('delta', 'dup-name');   // 重名：后者应被跳过

const catalog = createSkillCatalog({ roots: [tmp], log: { log: () => { } } });
t('发现 3 个技能（重名跳过）、隐藏技能不进目录但可读', () => {
  const list = catalog.list();
  assert.equal(list.length, 3, JSON.stringify(list.map((s) => s.name)));
  assert.ok(catalog.get('beta') && catalog.get('beta').disableModelInvocation === true);
  const prompt = catalog.promptText();
  assert.ok(prompt.includes('alpha') && !prompt.includes('beta'), prompt);
  assert.ok(prompt.includes('可用技能'));
});
t('read：默认 SKILL.md；references 可读；返回 basePath', () => {
  const md = catalog.read('alpha');
  assert.ok(md.content.includes('# alpha'));
  assert.ok(md.basePath.startsWith(tmp));
  const rule = catalog.read('alpha', 'references/rule.md');
  assert.equal(rule.content, 'rule of alpha');
});
t('read：路径逃逸/绝对路径/不存在 → 拒绝', () => {
  assert.throws(() => catalog.read('alpha', '../beta/SKILL.md'), /非法路径/);
  assert.throws(() => catalog.read('alpha', '/etc/passwd'), /非法路径/);
  assert.throws(() => catalog.read('alpha', 'references/../../x'), /非法路径/);
  assert.throws(() => catalog.read('alpha', 'nope.md'), /没有该文件/);
  assert.throws(() => catalog.read('missing', 'SKILL.md'), /技能不存在/);
});

console.log('== 技能：@点名解析 ==');
t('mentions：命中已有技能、未知名不收录、多个去重', () => {
  const m = catalog.mentions('看看 @alpha 和 @beta，再来一遍 @alpha；@nope 忽略');
  assert.deepEqual(m.skills, ['alpha', 'beta'], JSON.stringify(m));
  assert.deepEqual(m.unknown, ['nope']);
});
t('mentions：无 @ → 空结果', () => {
  const m = catalog.mentions('普通文本 a@b.com');
  assert.deepEqual(m.skills, []);
  assert.deepEqual(m.unknown, []);
});

console.log('== 技能：仓库内置技能可用 ==');
const repoCatalog = createSkillCatalog({ roots: [path.join(repoRoot, 'skills')], log: { log: () => { } } });
t('内置技能 ≥ 6 个且描述非空（含 workflow 三件套与既有技能）', () => {
  const names = repoCatalog.list().map((s) => s.name);
  for (const want of ['glossary-extract', 'acceptance-scan', 'text-preserve', 'glossary-workflow', 'translation-workflow', 'quality-workflow']) {
    assert.ok(names.includes(want), `${want} 缺失：${JSON.stringify(names)}`);
  }
  for (const s of repoCatalog.list()) assert.ok(String(s.description || '').trim() !== '', s.name);
});
t('read_skill 语义：glossary-workflow 正文含门槛要点', () => {
  const r = repoCatalog.read('glossary-workflow');
  assert.ok(r.content.includes('写入门槛'));
  assert.ok(r.content.includes('绝不改动原文侧'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
