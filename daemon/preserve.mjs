// daemon/preserve.mjs —— 内置保护规则库（对齐 LinguaGacha builtin/text_preserve/preset，独立实现）
// 语义：base 恒用；kag/renpy（KAG/RenPy 引擎命令）与 rpgmaker/wolf（RPG Maker/WOLF 控制码）按
//       config.textPreserve.preset 选择；再叠加用户自定的 text_preserve 规则（pattern 相同以用户规则为准）。
// checkOnly 项（空白符 / LG 资源 URI）只参与质检比对，不进翻译预处理链（逐字符占位会污染提示词）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.join(here, 'presets', 'text_preserve.json');

let cache;
function lib() {
  if (cache !== undefined) return cache;
  try { cache = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8')); } catch { cache = {}; }
  return cache;
}

export const PRESET_NAMES = ['base', 'kag', 'renpy', 'rpgmaker', 'wolf'];

// 预设名 → rules 表同形规则（regex 恒开、大小写不敏感、unicode 旗标对齐 LG 的 giu 编译）
export function presetRules(name) {
  const entries = lib()[String(name || '')] || [];
  return entries.map((e, i) => ({
    kind: 'text_preserve',
    pattern: String(e.src || ''),
    replacement: '',
    regex: true,
    case_sensitive: false,
    unicode: true,
    priority: 10 + i,
    preset: name,
    info: e.info || '',
    checkOnly: e.checkOnly === true,
  })).filter((r) => r.pattern !== '');
}

export function readTextPreserveConfig(store) {
  const cfg = (store && typeof store.getConfig === 'function' ? store.getConfig('textPreserve') : null) || {};
  const preset = (cfg.preset === 'none' || PRESET_NAMES.includes(cfg.preset)) ? cfg.preset : 'base';   // 默认 base（LG 恒用 base 的对齐）
  return { preset };
}

// 有效保护规则 = 预设（base + 所选层，或 preset:'none' 时无）+ 用户规则（同为 text_preserve）
// forPrep=true 时剔除 checkOnly 项（空白符/URI 不参与预处理占位）
export function effectivePreserveRules(store, bookKey, { forPrep = false } = {}) {
  const { preset } = readTextPreserveConfig(store);
  let presetList = [];
  if (preset !== 'none') {
    presetList = [...presetRules('base'), ...(preset === 'base' ? [] : presetRules(preset))];
  }
  if (forPrep) presetList = presetList.filter((r) => !r.checkOnly);
  const dbRules = (store && typeof store.listRules === 'function' ? store.listRules(bookKey) : [])
    .filter((r) => r && r.kind === 'text_preserve');
  const byPattern = new Map();
  for (const r of presetList) byPattern.set(r.pattern, r);
  for (const r of dbRules) {
    byPattern.set(String(r.pattern || ''), { ...r, regex: r.regex === true || r.regex === 1, case_sensitive: r.case_sensitive === true || r.case_sensitive === 1, preset: null });
  }
  return { preset, rules: [...byPattern.values()].filter((r) => r.pattern !== '') };
}

export function presetInfo() {
  const l = lib();
  return PRESET_NAMES.map((name) => ({ name, count: (l[name] || []).length })).filter((x) => x.count > 0);
}
