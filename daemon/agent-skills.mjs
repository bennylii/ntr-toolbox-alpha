// daemon/agent-skills.mjs —— Agent 技能目录（SKILL.md 包约定：frontmatter name/description + references/**）
// 参考 LG 的技能包约定独立实现：发现（按根目录、首个 SKILL.md 为包边界）、读取（每次读盘、防路径逃逸）、
// 目录注入（<available_skills>，disable-model-invocation 的技能不进目录但仍可 read_skill）。
import fs from 'node:fs';
import path from 'node:path';

export function parseFrontmatter(text) {
  const src = String(text || '');
  const meta = {};
  let body = src;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (m) {
    body = src.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const mm = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!mm) continue;
      let value = mm[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (value === 'true') meta[mm[1]] = true;
      else if (value === 'false') meta[mm[1]] = false;
      else meta[mm[1]] = value;
    }
  }
  return { meta, body };
}

const listFiles = (dir, { cap = 200 } = {}) => {
  const out = [];
  const walk = (current, rel) => {
    if (out.length >= cap) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= cap) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relPath);
      else out.push(relPath);
    }
  };
  walk(dir, '');
  return out.sort();
};

export function createSkillCatalog({ roots = [], log = console } = {}) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    const base = path.resolve(String(root || ''));
    let dirs = [];
    try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { continue; }
    for (const name of dirs) {
      const dir = path.join(base, name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      let meta = {};
      let extract = '';
      try {
        const parsed = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
        meta = parsed.meta;
        extract = String(parsed.body || '').trim().split(/\r?\n/).slice(0, 3).join(' ').slice(0, 200);
      } catch (e) { log.log(`[skills] 读取失败 ${skillFile}: ${(e && e.message) || e}`); continue; }
      const skillName = String(meta.name || name);
      if (seen.has(skillName)) { log.log(`[skills] 重名跳过：${skillName}（${dir}）`); continue; }
      seen.add(skillName);
      found.push({
        name: skillName,
        description: String(meta.description || extract || '').trim(),
        dir,
        disableModelInvocation: meta['disable-model-invocation'] === true,
        files: listFiles(dir),
      });
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name));

  const byName = new Map(found.map((s) => [s.name, s]));

  const read = (name, relPath = 'SKILL.md') => {
    const skill = byName.get(String(name || ''));
    if (!skill) throw Object.assign(new Error(`技能不存在：${name}`), { code: 'skill_not_found' });
    const rel = String(relPath || 'SKILL.md').replace(/\\/g, '/');
    if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) {
      throw Object.assign(new Error(`非法路径：${relPath}`), { code: 'bad_path' });
    }
    const full = path.resolve(skill.dir, rel);
    if (full !== skill.dir && !full.startsWith(skill.dir + path.sep)) {
      throw Object.assign(new Error(`路径越界：${relPath}`), { code: 'bad_path' });
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw Object.assign(new Error(`技能内没有该文件：${relPath}`), { code: 'file_not_found' });
    }
    return { skill: skill.name, path: rel, basePath: skill.dir, content: fs.readFileSync(full, 'utf8') };
  };

  const promptText = () => {
    const visible = found.filter((s) => !s.disableModelInvocation);
    if (visible.length === 0) return '';
    const lines = visible.map((s) => `- ${s.name}: ${s.description || '(无描述)'}`);
    return `可用技能（需要时用 read_skill 读取完整说明与 references）：\n${lines.join('\n')}`;
  };

  return {
    roots,
    list: () => found.map(({ name, description, files, disableModelInvocation }) => ({ name, description, files, disableModelInvocation })),
    get: (name) => byName.get(String(name || '')) || null,
    read,
    promptText,
  };
}
