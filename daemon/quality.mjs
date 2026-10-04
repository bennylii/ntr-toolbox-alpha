// daemon/quality.mjs —— 译文质检（七码；规格 docs/cleanroom/spec-07-translation-quality-check.md）
// 纯函数：不触网、不落库；引擎只用于术语落地检查（scanAcceptance 语义复用）。
// 只读检查，产出报告；写站点/提案由 check-pipeline 决定。

export const QUALITY_CODES = [
  'FOREIGN_CHAR_RESIDUE',
  'SIMILARITY',
  'LINE_COUNT_MISMATCH',
  'GLOSSARY',
  'TEXT_PRESERVE',
  'PUNCTUATION_MISMATCH',
  'RETRY_THRESHOLD',
];

const RE_KANA_G = /[\u3041-\u3096\u30A1-\u30FA\u31F0-\u31FF]/g;
const RE_CJK_G = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const RE_STRIP = /[\s\u3000。、，．,.！？!?…ー「」『』“”‘’（）()【】《》〈〉：:；;—～~・·…#＃]/g;
const RE_END_JP = /[。！？!?…]$/;
const RE_END_ZH = /[。！？…！？]$/;   // 收尾引号/括号不算句末标点（两侧一致，避免对话行误报）
const QUOTE_PAIRS = [['「', '」'], ['『', '』'], ['“', '”'], ['（', '）'], ['《', '》'], ['【', '】']];

// 归一化：去空白与标点（相似度/包含判定用）
export function stripForCompare(text) {
  return String(text || '').replace(RE_STRIP, '');
}

// 字符集合 Jaccard 相似度
export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// 2. 源语言字符残留：行内含假名且中文（汉字）占比 < 50%
export function foreignResidue(zh, options = {}) {
  const text = String(zh || '');
  const kana = (text.match(RE_KANA_G) || []).length;
  if (kana === 0) return false;
  const cjk = (text.match(RE_CJK_G) || []).length;
  const ratio = cjk / (cjk + kana);
  return ratio < (options.minChineseRatio ?? 0.5);
}

// 3. 高度相似（疑似漏译/直抄）：归一化后包含（双方长度 ≥ minLen）或 Jaccard > 阈值
export function similarityWarning(jp, zh, options = {}) {
  const minLen = options.minLen ?? 8;
  const threshold = options.jaccardThreshold ?? 0.8;
  const a = stripForCompare(jp);
  const b = stripForCompare(zh);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  if (a.length >= minLen && b.length >= minLen && (a.includes(b) || b.includes(a))) return true;
  return jaccard(a, b) > threshold;
}

// 6. 标点结构：句末标点不一致 / 译文成对引号不平衡
export function punctuationMismatch(jp, zh) {
  const j = String(jp || '').trimEnd();
  const z = String(zh || '').trimEnd();
  if (j === '' || z === '') return false;
  const jEnd = RE_END_JP.test(j);
  const zEnd = RE_END_ZH.test(z);
  if (jEnd !== zEnd) return true;
  for (const [open, close] of QUOTE_PAIRS) {
    const count = (ch) => (z.match(new RegExp(ch, 'g')) || []).length;
    if (count(open) !== count(close)) return true;
  }
  return false;
}

// 5. 保留段缺失（P3 落地 rules 后填充实现；当前无规则 → 恒不触发）
export function preserveMisses(jp, zh, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  return [];   // P3 由 processors.mjs 提供实现并在此接入
}

// 4. 术语未落地：jp 行命中的术语，其 dst 未出现在对应 zh 行（scanAcceptance 语义）
export function glossaryMisses(jp, zh, glossary, engine) {
  const entries = Object.entries(glossary || {}).map(([src, dst]) => ({ src, dst }));
  if (entries.length === 0 || !engine || typeof engine.scanAcceptance !== 'function') return [];
  const { rows } = engine.scanAcceptance({ entries, jpLines: [jp || ''], zhLines: [zh || ''] });
  return rows.filter((r) => r.status === 'missed').map((r) => r.src);
}

// 单对检查：返回命中码与细节
export function checkPair(pair, ctx = {}) {
  const jp = String((pair && pair.jp) || '');
  const zh = String((pair && pair.zh) || '');
  const codes = [];
  if (jp !== '' && zh.trim() === '') codes.push('LINE_COUNT_MISMATCH');
  if (foreignResidue(zh)) codes.push('FOREIGN_CHAR_RESIDUE');
  if (similarityWarning(jp, zh)) codes.push('SIMILARITY');
  if (punctuationMismatch(jp, zh)) codes.push('PUNCTUATION_MISMATCH');
  const missedTerms = glossaryMisses(jp, zh, ctx.glossary, ctx.engine);
  if (missedTerms.length > 0) codes.push('GLOSSARY');
  if (preserveMisses(jp, zh, ctx.rules).length > 0) codes.push('TEXT_PRESERVE');
  if (Number(ctx.retries) >= 2) codes.push('RETRY_THRESHOLD');
  return { codes, missedTerms };
}

const truncate = (text, n = 120) => {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// 批量检查：pairs [{jp, zh, chapter?, chapterId?}] → 报告
// options: { glossary, engine, rules, translationMissing, retriesByChapter, limit, codes }
export function checkAligned({ pairs, glossary, engine, rules = [], translationMissing = 0, retriesByChapter = {}, limit = 50, codes = null } = {}) {
  const wanted = Array.isArray(codes) && codes.length > 0 ? new Set(codes) : null;
  const counts = {};
  const samples = [];
  let checked = 0;
  for (const pair of pairs || []) {
    const retries = Number(retriesByChapter[pair.chapterId]) || 0;
    const result = checkPair(pair, { glossary, engine, rules, retries });
    checked += 1;
    for (const code of result.codes) {
      if (wanted && !wanted.has(code)) continue;
      counts[code] = (counts[code] || 0) + 1;
      if (samples.length < limit) {
        samples.push({
          code,
          chapter: pair.chapter || '',
          chapterId: pair.chapterId || '',
          jp: truncate(pair.jp),
          zh: truncate(pair.zh),
          detail: code === 'GLOSSARY' ? result.missedTerms.join('、') : '',
        });
      }
    }
  }
  if (translationMissing > 0 && (!wanted || wanted.has('LINE_COUNT_MISMATCH'))) {
    counts.LINE_COUNT_MISMATCH = (counts.LINE_COUNT_MISMATCH || 0) + translationMissing;
    if (samples.length < limit) {
      samples.push({ code: 'LINE_COUNT_MISMATCH', chapter: '', chapterId: '', jp: '', zh: '', detail: `译文缺失标记 ×${translationMissing}` });
    }
  }
  return { pairs: (pairs || []).length, checked, translationMissing, codes: counts, samples };
}
