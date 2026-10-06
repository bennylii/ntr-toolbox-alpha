// daemon/processors.mjs —— 预处理/后处理链（规格 docs/cleanroom/spec-08-text-processors.md）
// 目标：资源占位符投影/还原、ruby 清洗、保留段（text_preserve）、前后替换表、标点稳定化。
// 硬不变量：行数不变、还原失败回退原文、处理链版本参与段缓存键。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CHAIN_VERSION = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const PRESET_PATH = path.join(here, 'presets', 'base.json');

const RES_OPEN = '\uE000';
const RES_CLOSE = '\uE001';
const PRE_OPEN = '\uE100';
const PRE_CLOSE = '\uE101';
const RE_RES = /\uE000(\d+)\uE001/g;
const RE_PRE = /\uE100(\d+)\uE101/g;
const RE_ANY_MARKER = /[\uE000\uE001\uE100\uE101]/;

// 资源片段（发送前投影为占位符，还原后应逐字回到译文里）
const RESOURCE_PATTERNS = [
  /https?:\/\/[^\s）」』】"']+/g,
  /<[^<>\n]{1,80}>/g,
  /\\[Nn]\[[^\]\n]{1,40}\]/g,
  /\\[A-Za-z]{1,12}\[\d{1,6}\]/g,
  /@\[[^\]\n]{1,60}\]/g,
  /\[ruby[=\s][^\]\n]{0,60}\]/gi,
];

const RUBY_PATTERNS = [
  [/([\u4E00-\u9FFF々]{1,10})[（(]([\u3041-\u3096\u30A1-\u30FAー]{1,20})[）)]/g, '$1'],
  [/[｜|]([\u4E00-\u9FFF々]{1,10})《[^》]{1,20}》/g, '$1'],
  [/\[ruby[^\]]*\]/gi, ''],
];

let presetCache;
function loadPreset() {
  if (presetCache !== undefined) return presetCache;
  try { presetCache = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8')); } catch { presetCache = {}; }
  return presetCache;
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compileRules = (rules) => {
  const skipped = [];
  const list = [];
  for (const raw of rules || []) {
    if (!raw || String(raw.pattern || '') === '') continue;
    if (!(raw.enabled === undefined || raw.enabled === true || raw.enabled === 1)) continue;
    const kind = String(raw.kind || '');
    if (!['text_preserve', 'pre_replacement', 'post_replacement'].includes(kind)) continue;
    const regex = raw.regex === true || raw.regex === 1;
    const caseSensitive = raw.case_sensitive === true || raw.case_sensitive === 1;
    if (regex) {
      try { new RegExp(String(raw.pattern)); } catch { skipped.push({ pattern: String(raw.pattern), reason: '正则无效' }); continue; }
    }
    list.push({
      id: Number(raw.id) || 0,
      kind,
      pattern: String(raw.pattern),
      replacement: ((raw.replacement === null || raw.replacement === undefined) ? '' : String(raw.replacement)),
      regex,
      caseSensitive,
      priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 100,
    });
  }
  list.sort((a, b) => a.priority - b.priority || a.id - b.id);
  return { list, skipped };
};

const applyReplacement = (rule, text) => {
  if (rule.regex) return text.replace(new RegExp(rule.pattern, rule.caseSensitive ? 'g' : 'gi'), rule.replacement);
  if (rule.caseSensitive) return text.split(rule.pattern).join(rule.replacement);
  return text.replace(new RegExp(escapeRegExp(rule.pattern), 'gi'), rule.replacement);
};

// 保留段：匹配片段替换为占位符并记录原文，译文还原时回填
const markPreserves = (rule, text, ctx) => {
  const mark = (m) => {
    ctx.preserves.push(m);
    return `${PRE_OPEN}${ctx.preserves.length - 1}${PRE_CLOSE}`;
  };
  if (rule.regex) return text.replace(new RegExp(rule.pattern, rule.caseSensitive ? 'g' : 'gi'), mark);
  if (rule.caseSensitive) {
    const parts = text.split(rule.pattern);
    if (parts.length === 1) return text;
    return parts.map((part, i) => (i === 0 ? part : mark(rule.pattern) + part)).join('');
  }
  return text.replace(new RegExp(escapeRegExp(rule.pattern), 'gi'), mark);
};

// 提取受保护片段（与处理链同款匹配语义：同名同参、按 priority 顺序、占位替换防重叠）——质检 TEXT_PRESERVE 复用
export function collectPreserveSegments(text, rules = []) {
  const compiled = compileRules(rules).list.filter((r) => r.kind === 'text_preserve');
  const ctx = { source: '', resources: [], preserves: [] };
  let out = String(text == null ? '' : text);
  for (const rule of compiled) out = markPreserves(rule, out, ctx);
  return ctx.preserves.slice();
}

// 标点稳定化：jp 句末标点 → zh 半角转全角（jp-end）；full 模式恒转
const applyPunctuation = (sourceLine, zhLine, mode) => {
  if (mode === 'off' || !zhLine) return zhLine;
  const src = String(sourceLine || '').trimEnd();
  let out = zhLine;
  const endsWith = (ch) => new RegExp(`${escapeRegExp(ch)}(?=[」』）】]*$)`);
  if (mode === 'full' || /[！!]$/.test(src)) out = out.replace(endsWith('!'), '！');
  if (mode === 'full' || /[？?]$/.test(src)) out = out.replace(endsWith('?'), '？');
  return out;
};

export function createProcessor({ rules = [], options = {} } = {}) {
  const preset = loadPreset();
  const opt = {
    resourceProtect: options.resourceProtect !== undefined ? options.resourceProtect : (preset.options || {}).resourceProtect !== false,
    rubyClean: options.rubyClean !== undefined ? options.rubyClean : (preset.options || {}).rubyClean === true,
    punctuation: options.punctuation !== undefined ? options.punctuation : ((preset.options || {}).punctuation || 'jp-end'),
  };
  const { list, skipped } = compileRules(rules);
  const fingerprint = crypto.createHash('sha1')
    .update(JSON.stringify(list.map((r) => ({ k: r.kind, p: r.pattern, r: r.replacement, x: r.regex, c: r.caseSensitive, o: r.priority }))))
    .update(JSON.stringify(opt))
    .digest('hex').slice(0, 12);
  const version = `${CHAIN_VERSION}:${fingerprint}`;
  const byKind = (kind) => list.filter((r) => r.kind === kind);

  return {
    version,
    skipped,
    options: opt,
    // pre(line) → { text, ctx }（ctx 为 null 表示无需还原）
    pre(line) {
      let text = String(line == null ? '' : line);
      if (text.trim() === '') return { text, ctx: null };
      const ctx = { source: text, resources: [], preserves: [] };
      if (opt.rubyClean) for (const [re, rep] of RUBY_PATTERNS) text = text.replace(re, rep);
      if (opt.resourceProtect) {
        for (const re of RESOURCE_PATTERNS) {
          text = text.replace(re, (m) => {
            ctx.resources.push(m);
            return `${RES_OPEN}${ctx.resources.length - 1}${RES_CLOSE}`;
          });
        }
      }
      for (const rule of byKind('text_preserve')) text = markPreserves(rule, text, ctx);
      for (const rule of byKind('pre_replacement')) text = applyReplacement(rule, text);
      return { text, ctx };
    },
    // post(zh, ctx) → { text, fellBack, warnings }
    post(zh, ctx) {
      const warnings = [];
      let text = String(zh == null ? '' : zh);
      if (!ctx) return { text, fellBack: false, warnings };
      for (const rule of byKind('post_replacement')) text = applyReplacement(rule, text);

      const seenPreserves = new Set();
      text = text.replace(RE_PRE, (m, i) => {
        const idx = Number(i);
        if (ctx.preserves[idx] === undefined) return m;
        seenPreserves.add(idx);
        return ctx.preserves[idx];
      });
      const missing = [];
      for (let i = 0; i < ctx.preserves.length; i += 1) if (!seenPreserves.has(i)) missing.push(i);
      if (missing.length > 0) {
        warnings.push(`保留段缺失 ${missing.length} 处，已在行尾补回`);
        text += missing.map((i) => ctx.preserves[i]).join('');
      }

      const seenResources = new Set();
      text = text.replace(RE_RES, (m, i) => {
        const idx = Number(i);
        if (ctx.resources[idx] === undefined) return m;
        seenResources.add(idx);
        return ctx.resources[idx];
      });
      if (ctx.resources.some((_, i) => !seenResources.has(i))) {
        return { text, fellBack: true, warnings: [...warnings, '资源占位符缺失，回退原文'] };
      }
      text = applyPunctuation(ctx.source, text, opt.punctuation);
      if (RE_ANY_MARKER.test(text)) {
        return { text, fellBack: true, warnings: [...warnings, '占位符残留，回退原文'] };
      }
      return { text, fellBack: false, warnings };
    },
  };
}

// 从 store 装配处理链（全局规则 + 该书规则；store 缺方法时退化为空规则）
export function processorFromStore(store, bookKey, options = {}) {
  const rules = store && typeof store.listRules === 'function' ? store.listRules(bookKey) : [];
  return createProcessor({ rules, options });
}
