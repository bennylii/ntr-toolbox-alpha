// daemon/prompt.mjs —— 提示词模板（规格 docs/cleanroom/spec-09-prompt-templates.md）
// 四槽：prefix / base / thinking / suffix；base 必须含 {format_rules}（协议段由代码注入，模板不可覆盖）。
// 默认模板渲染结果与站点镜像的固定系统提示逐字相同（translate.mjs 的 TRANSLATE_SYSTEM_PROMPT）。
import { TRANSLATE_SYSTEM_PROMPT } from './translate.mjs';

const DEFAULT_PREFIX = '你是一个轻小说翻译者，将下面的轻小说翻译成简体中文。';
const DEFAULT_BASE = '要求翻译准确，译文流畅，尽量保持原文写作风格。要求人名和专有名词也要翻译成中文。{format_rules}';
// 协议段（代码内置，不可被模板替换）：行数相等 + 不加说明；编号由用户消息与解析器共同保证
export const FORMAT_RULES = '既不要漏掉任何一句，也不要增加额外的说明。注意保持换行格式，译文的行数必须要和原文相等。';

export const DEFAULT_TEMPLATE = {
  prefix: DEFAULT_PREFIX,
  base: DEFAULT_BASE,
  thinking: '',
  suffix: '',
};

export const PROMPT_SLOTS = ['prefix', 'base', 'thinking', 'suffix'];

// 渲染：{format_rules} 注入协议段，{source_language}/{target_language} 替换
export function renderSystemPrompt(template = {}, { sourceLanguage = '日文', targetLanguage = '简体中文' } = {}) {
  const t = { ...DEFAULT_TEMPLATE, ...(template || {}) };
  const warnings = [];
  // 默认模板零改动：直接返回站点镜像提示（逐字一致，无行为变化）
  const isDefault = PROMPT_SLOTS.every((slot) => String(t[slot] || '') === String(DEFAULT_TEMPLATE[slot] || ''));
  if (isDefault) return { text: TRANSLATE_SYSTEM_PROMPT, usedDefault: false, warnings };
  const invalid = (text) => (
    !String(text || '').includes('{format_rules}')
    || String(text || '').trim().length < 10
  );
  if (typeof t.base !== 'string' || t.base.trim() === '' || invalid(t.base)) {
    return { text: TRANSLATE_SYSTEM_PROMPT, usedDefault: true, warnings: ['base 模板缺少 {format_rules} 或过短：已回退默认模板'] };
  }
  const fill = (text) => String(text)
    .split('{format_rules}').join(FORMAT_RULES)
    .split('{source_language}').join(sourceLanguage)
    .split('{target_language}').join(targetLanguage);
  const parts = [fill(t.prefix), fill(t.base)];
  if (String(t.suffix || '').trim() !== '') parts.push(fill(t.suffix));
  let text = parts.map((p) => String(p).trim()).filter((p) => p !== '').join('\n');
  if (!/行数/.test(text) || !/(不要|不得)/.test(text)) {
    return { text: TRANSLATE_SYSTEM_PROMPT, usedDefault: true, warnings: ['渲染结果缺少协议关键词：已回退默认模板'] };
  }
  return { text, usedDefault: false, warnings };
}

// 槽位解析：该书行 → 全局行 → 默认（空白视为未设置）
export function resolveTemplate(rows = [], bookKey = '') {
  const pick = (slot) => {
    const find = (key) => rows.find((r) => r && r.slot === slot && (r.bookKey || '') === key);
    const book = find(bookKey);
    if (book && String(book.text || '').trim() !== '') return book.text;
    const global = find('');
    if (global && String(global.text || '').trim() !== '') return global.text;
    return DEFAULT_TEMPLATE[slot];
  };
  return { prefix: pick('prefix'), base: pick('base'), thinking: pick('thinking'), suffix: pick('suffix') };
}

export function templateFromStore(store, bookKey = '') {
  const rows = store && typeof store.listPrompts === 'function' ? store.listPrompts(bookKey) : [];
  return resolveTemplate(rows, bookKey);
}

// 思考指引：追加到用户消息最前（为空则不加）
export function thinkingBlock(thinking) {
  const text = String(thinking || '').trim();
  if (text === '') return '';
  return `【思考指引】\n${text}\n`;
}
