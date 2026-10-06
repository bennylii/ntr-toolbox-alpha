// daemon/quality.mjs —— 译文质检（七码；算法 v2 对齐 LinguaGacha；规格 docs/cleanroom/spec-07-translation-quality-check.md）
// 纯函数：不触网、不落库；引擎只用于术语落地检查（scanAcceptance 语义复用）。
// 只读检查，产出报告；写站点/提案/警告落库由 check-pipeline 决定。
import { collectPreserveSegments } from './processors.mjs';

export const QUALITY_CODES = [
  'FOREIGN_CHAR_RESIDUE',
  'SIMILARITY',
  'LINE_COUNT_MISMATCH',
  'GLOSSARY',
  'TEXT_PRESERVE',
  'PUNCTUATION_MISMATCH',
  'RETRY_THRESHOLD',
];

// 归一化：去空白与标点（仅供外部兼容使用；相似度判定已对齐 LG 用原始文本）
const RE_STRIP = /[\s\u3000。、，．,.！？!?…ー「」『』“”‘’（）()【】《》〈〉：:；;—～~・·…#＃]/g;
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

// ---- FOREIGN_CHAR_RESIDUE（v2，LG 同款）：字素分割 + 书写系统分类 ----
// 目标语言 zh：允许 Han；其它字母脚本（假名/谚文/西里尔/阿拉伯/泰文…）一律算残留；
// 拉丁短串豁免：单字素 或 ^[A-Z]{2,4}$（该串混入其它脚本残留时不豁免）；相邻残留合并成片段作证据。
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const RE_LETTER = /\p{L}/u;
const RE_HAN = /\p{Script_Extensions=Han}/u;
const RE_LATIN = /\p{Script_Extensions=Latin}/u;
const RE_LATIN_EXEMPT = /^[A-Z]{2,4}$/;

function classifyGrapheme(g) {
  let hasOther = false;
  let hasLatin = false;
  let hasAllowed = false;
  for (const ch of g) {
    if (!RE_LETTER.test(ch)) continue;
    if (RE_HAN.test(ch)) { hasAllowed = true; continue; }
    if (RE_LATIN.test(ch)) { hasLatin = true; continue; }
    hasOther = true;   // 未注册/非目标字母脚本
  }
  if (hasOther) return 'other-residue';       // 混入其它脚本 → 整字素算其它残留
  if (hasLatin) return 'latin-residue';       // LG：拉丁残留优先于 allowed/neutral
  if (hasAllowed) return 'allowed';
  return 'neutral';
}

export function foreignResidueFragments(text) {
  const fragments = [];
  let current = '';
  let count = 0;
  let hasOther = false;
  const flush = () => {
    const exempt = !hasOther && (count === 1 || RE_LATIN_EXEMPT.test(current));
    if (current !== '' && !exempt) fragments.push(current);
    current = '';
    count = 0;
    hasOther = false;
  };
  for (const { segment } of GRAPHEME_SEGMENTER.segment(String(text == null ? '' : text))) {
    const cls = classifyGrapheme(segment);
    if (cls === 'latin-residue' || cls === 'other-residue') {
      current += segment;
      count += 1;
      hasOther = hasOther || cls === 'other-residue';
      continue;
    }
    flush();
  }
  flush();
  return [...new Set(fragments)];
}

// 兼容旧签名：布尔版（是否有残留）
export function foreignResidue(zh) {
  return foreignResidueFragments(zh).length > 0;
}

// ---- SIMILARITY（v2，LG 同款）：trim 后双向包含 或 字符集 Jaccard > 0.8；JA→ZH 需残留证据 ----
export const SIMILARITY_THRESHOLD = 0.8;

export function isTextSimilar(left, right) {
  const l = String(left == null ? '' : left).trim();
  const r = String(right == null ? '' : right).trim();
  if (l === '' || r === '') return false;
  return l.includes(r) || r.includes(l) || jaccard(l, r) > SIMILARITY_THRESHOLD;
}

export function similarityWarning(jp, zh, options = {}) {
  if (!isTextSimilar(jp, zh)) return false;
  // JA/KO → ZH 护栏：仅当译文另有残留证据才报（防止汉字-heavy 的合法翻译误报；LG 同款策略）
  if (options.requireResidueEvidence === false) return true;
  return foreignResidueFragments(zh).length > 0;
}

// ---- PUNCTUATION_MISMATCH（v2，LG 同款）：标点组序列逐位比对（引号变体合并、开闭分明、顺序敏感） ----
const PUNCT_GROUPS = [
  ['QUOTE', '“”„‟「」『』«»"＂'],
  ['ROUND_OPEN', '(（'], ['ROUND_CLOSE', ')）'],
  ['SQUARE_OPEN', '[［【'], ['SQUARE_CLOSE', ']］】'],
  ['BRACE_OPEN', '{｛'], ['BRACE_CLOSE', '}｝'],
  ['TITLE_OPEN', '《'], ['TITLE_CLOSE', '》'],
];
const PUNCT_GROUP_OF = (() => {
  const map = new Map();
  for (const [group, chars] of PUNCT_GROUPS) for (const ch of chars) map.set(ch, group);
  return map;
})();

export function punctuationStructure(text) {
  const out = [];
  for (const ch of String(text == null ? '' : text)) {
    const g = PUNCT_GROUP_OF.get(ch);
    if (g) out.push(g);
  }
  return out;
}

export function punctuationMismatch(jp, zh) {
  const a = punctuationStructure(jp);
  const b = punctuationStructure(zh);
  return a.length !== b.length || a.some((g, i) => g !== b[i]);
}

// ---- TEXT_PRESERVE（v2 实装）：两侧按处理链同款规则提取受保护片段，逐位比对 ----
// LG 语义：只比对非空白片段（空白符/资源 URI 等 checkOnly 项不参与逐位比较的证据出列）
// 返回 null = 通过（或无规则可查）；不通过返回 {sourceFragments, translationFragments}
export function preserveMisses(jp, zh, rules) {
  const compiled = Array.isArray(rules) ? rules.filter((r) => r && r.kind === 'text_preserve') : [];
  if (compiled.length === 0) return null;
  const nonBlank = (segs) => segs.filter((s) => String(s).trim() !== '');
  const srcSegs = nonBlank(collectPreserveSegments(jp, compiled));
  const dstSegs = nonBlank(collectPreserveSegments(zh, compiled));
  if (srcSegs.length === 0 && dstSegs.length === 0) return null;
  const mismatch = srcSegs.length !== dstSegs.length || srcSegs.some((seg, i) => seg !== dstSegs[i]);
  return mismatch ? { sourceFragments: srcSegs, translationFragments: dstSegs } : null;
}

// ---- GLOSSARY：jp 行命中的术语，其 dst 未出现在对应 zh 行（scanAcceptance 语义） ----
export function glossaryMisses(jp, zh, glossary, engine) {
  const entries = Object.entries(glossary || {}).map(([src, dst]) => ({ src, dst }));
  if (entries.length === 0 || !engine || typeof engine.scanAcceptance !== 'function') return [];
  const { rows } = engine.scanAcceptance({ entries, jpLines: [jp || ''], zhLines: [zh || ''] });
  return rows.filter((r) => r.status === 'missed').map((r) => r.src);
}

// 单对检查：返回 {codes, hits:[{code, detail, evidence}], missedTerms}
export function checkPair(pair, ctx = {}) {
  const jp = String((pair && pair.jp) || '');
  const zh = String((pair && pair.zh) || '');
  const hits = [];
  const add = (code, detail = '', evidence = null) => hits.push({ code, detail, evidence });
  if (jp !== '' && zh.trim() === '') add('LINE_COUNT_MISMATCH', '译文缺失');
  const residue = foreignResidueFragments(zh);
  if (residue.length > 0) add('FOREIGN_CHAR_RESIDUE', residue.join('、'), { fragments: residue });
  if (similarityWarning(jp, zh)) add('SIMILARITY', '疑似漏译/直抄');
  if (punctuationMismatch(jp, zh)) add('PUNCTUATION_MISMATCH', '标点结构不一致');
  const missedTerms = glossaryMisses(jp, zh, ctx.glossary, ctx.engine);
  if (missedTerms.length > 0) add('GLOSSARY', missedTerms.join('、'), { missed: missedTerms });
  const preserve = preserveMisses(jp, zh, ctx.rules);
  if (preserve) add('TEXT_PRESERVE', `${preserve.sourceFragments.length} → ${preserve.translationFragments.length}`, preserve);
  if (Number(ctx.retries) >= 2) add('RETRY_THRESHOLD', `重试 ${Number(ctx.retries)} 次`);
  return { codes: hits.map((h) => h.code), hits, missedTerms };
}

const truncate = (text, n = 120) => {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// 批量检查：pairs [{jp, zh, chapter?, chapterId?}] → 报告
// options: { glossary, engine, rules, translationMissing, retriesByChapter, limit, codes,
//            onHit(pairIndex, hit, pair) 可选：全量命中回调（落库用），samples 仍受 limit 截断 }
export function checkAligned({ pairs, glossary, engine, rules = [], translationMissing = 0, retriesByChapter = {}, limit = 50, codes = null, onHit = null } = {}) {
  const wanted = Array.isArray(codes) && codes.length > 0 ? new Set(codes) : null;
  const counts = {};
  const samples = [];
  let checked = 0;
  let pairIndex = 0;
  for (const pair of pairs || []) {
    const retries = Number(retriesByChapter[pair.chapterId]) || 0;
    const result = checkPair(pair, { glossary, engine, rules, retries });
    for (const hit of result.hits) {
      if (onHit) onHit(pairIndex, hit, pair);   // 落库用：不受 codes 报告过滤影响
      if (wanted && !wanted.has(hit.code)) continue;
      counts[hit.code] = (counts[hit.code] || 0) + 1;
      if (samples.length < limit) {
        samples.push({
          code: hit.code,
          chapter: pair.chapter || '',
          chapterId: pair.chapterId || '',
          jp: truncate(pair.jp),
          zh: truncate(pair.zh),
          detail: hit.detail || '',
        });
      }
    }
    checked += 1;
    pairIndex += 1;
  }
  if (translationMissing > 0 && (!wanted || wanted.has('LINE_COUNT_MISMATCH'))) {
    counts.LINE_COUNT_MISMATCH = (counts.LINE_COUNT_MISMATCH || 0) + translationMissing;
    if (samples.length < limit) {
      samples.push({ code: 'LINE_COUNT_MISMATCH', chapter: '', chapterId: '', jp: '', zh: '', detail: `译文缺失标记 ×${translationMissing}` });
    }
  }
  if (translationMissing > 0 && onHit) onHit(-1, { code: 'LINE_COUNT_MISMATCH', detail: `译文缺失标记 ×${translationMissing}`, evidence: null }, null);
  return { pairs: (pairs || []).length, checked, translationMissing, codes: counts, samples };
}
