// daemon/translate.mjs —— GPT 翻译核心（纯函数 + 单段执行；镜像站点 packages/translator 语义）
// 语义已对照 auto-novel 源码逐条核对：
// - 分段：createLineSegmenter(1500, 30)（长度含换行 +1；超长单行自成一段）
// - 提示词：openai-prompt.ts —— 系统提示固定文本；术语表仅当"段内任一行包含 src"时注入
//   （表头 + "jp => zh"）；正文为 "#${i+1}:${line}"；单行段追加"原文到此为止"
// - 解析：/^#(\d+)(?:[:：]|\s+)(.*)/；空行保留原文；缺失编号抛"行数不匹配"；保留原行前导空白
// - 重试：≤3 次；"输出语言不是中文"用 detectChinese 判定（utils.ts 的阈值）
// - 二分拆分：仅当"连续 3 次显式行数检查失败且行数>1"触发（与站点一致的语义，含其可达性局限）
// - 相邻段上下文：可选的「参考上文/参考下文」块（默认 0 行 = 关闭，与现状逐字相同）。
//   上文镜像 LinguaGacha 的 preceding_lines_threshold（含"句末标点门槛"）；下文是本仓库的对称扩展。

export const TRANSLATE_SYSTEM_PROMPT =
  '你是一个轻小说翻译者，将下面的轻小说翻译成简体中文。要求翻译准确，译文流畅，尽量保持原文写作风格。要求人名和专有名词也要翻译成中文。既不要漏掉任何一句，也不要增加额外的说明。注意保持换行格式，译文的行数必须要和原文相等。';

export const SEGMENT_MAX_LEN = 1500;
export const SEGMENT_MAX_LINES = 30;

// ---- 分段（镜像 createLineSegmenter）----
export function segmentLines(lines, options = {}) {
  const maxLen = options.maxLen ?? SEGMENT_MAX_LEN;
  const maxLines = options.maxLines ?? SEGMENT_MAX_LINES;
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const ranges = [];
  let segStart = 0;
  let segChars = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const isLastLine = i === lines.length - 1;
    const lineLen = lines[i].length + (isLastLine ? 0 : 1);
    const isCharLimitReached = segChars + lineLen > maxLen;
    const isLineLimitReached = i - segStart >= maxLines;
    if ((isCharLimitReached || isLineLimitReached) && i > segStart) {
      ranges.push({ start: segStart, end: i });
      segStart = i;
      segChars = 0;
    }
    segChars += lineLen;
  }
  if (segStart < lines.length) ranges.push({ start: segStart, end: lines.length });
  return ranges.map((r) => lines.slice(r.start, r.end));
}

// ---- 相邻段上下文（参考上文/参考下文）----
// 上文语义镜像 LinguaGacha v0.125.0 `src/backend/batch-translation/planning/translation-planner.ts:21,265-293`：
// 从段首往前收集「以句末标点结尾」的连续行，遇到不以句末标点结尾的行即停（因此可能一行都不带）；
// 下文（LG 没有的方向）对称：从段尾往后收，收到句末标点为止。都在本章 lines 内走，不跨章。
export const CONTEXT_END_PUNCTUATION = new Set(['.', '。', '?', '？', '!', '！', '…', '\'', '"', '」', '』']);

export function collectContextLines(lines, { start, end } = {}, { before = 0, after = 0 } = {}) {
  const src = Array.isArray(lines) ? lines : [];
  const from = Number.isFinite(start) ? start : 0;
  const to = Number.isFinite(end) ? end : src.length;
  const preceding = [];
  const following = [];
  const isEmpty = (line) => String(line == null ? '' : line).trim() === '';
  const endsSentence = (line) => CONTEXT_END_PUNCTUATION.has(String(line == null ? '' : line).trim().slice(-1));
  if (before > 0) {
    for (let i = from - 1; i >= 0 && preceding.length < before; i -= 1) {
      const line = src[i];
      if (line === undefined) break;
      if (isEmpty(line)) continue;        // 空行不进上下文（真站点空段已在分段前过滤，这里只做防御）
      if (!endsSentence(line)) break;     // LG 语义：遇到非句末行就停（不是跳过）
      preceding.unshift(line);
    }
  }
  if (after > 0) {
    for (let i = to; i < src.length && following.length < after; i += 1) {
      const line = src[i];
      if (line === undefined) break;
      if (isEmpty(line)) continue;
      following.push(line);
      if (endsSentence(line)) break;      // 收到句末标点为止（含该行）
    }
  }
  return { preceding, following };
}

// 上下文行：行首 # 转全角，防止模型把参考行回显成 "#n:" 被 parseTranslateAnswer 误认成正文行（静默串位）
const contextLine = (line) => String(line == null ? '' : line).replace(/^(\s*)#/, '$1＃');

// ---- 空段预过滤（④ 探针实测真站点 paragraphJp 含空段：空段不占编号/token，提交前原位回填）----
// splitEmptyParagraphs：filled = 参与翻译的段（原序）；map[i] = 该段在 filled 中的下标（空段 -1）
export function splitEmptyParagraphs(paragraphs) {
  const filled = [];
  const map = [];
  for (const raw of paragraphs || []) {
    const text = String(raw == null ? '' : raw);
    if (text.trim() === '') { map.push(-1); continue; }
    map.push(filled.length);
    filled.push(text);
  }
  return { filled, map };
}

// mergeEmptyParagraphs：filledZh 按 filled 顺序回填；空段原样保留（段数/顺序 = 上传契约）
export function mergeEmptyParagraphs(paragraphs, filledZh) {
  const { map } = splitEmptyParagraphs(paragraphs);
  const out = [];
  let k = 0;
  (paragraphs || []).forEach((raw, i) => {
    if (map[i] < 0) { out.push(String(raw == null ? '' : raw)); return; }
    out.push(filledZh[k]);
    k += 1;
  });
  return out;
}

// ---- 提示词（镜像 openai-prompt.ts；systemPrompt/thinking 可由模板注入，协议段不可改）----
// preceding/following（默认 0 行）：已由调用方投影过的相邻段文本，渲染成「参考上文/参考下文」块；
// 都为空时用户消息与旧实现逐字相同（回归红线，translate-test 钉死）
export function buildTranslateMessages(lines, glossary, options = {}) {
  const opts = options || {};
  const systemPrompt = (typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim() !== '')
    ? opts.systemPrompt
    : TRANSLATE_SYSTEM_PROMPT;
  const messages = [{ role: 'system', content: systemPrompt }];
  const parts = [];
  const thinking = String(opts.thinking || '').trim();
  if (thinking !== '') parts.push(`【思考指引】\n${thinking}\n`);
  const preceding = (Array.isArray(opts.preceding) ? opts.preceding : []).filter((line) => String(line == null ? '' : line).trim() !== '');
  const following = (Array.isArray(opts.following) ? opts.following : []).filter((line) => String(line == null ? '' : line).trim() !== '');
  if (preceding.length > 0) {
    parts.push('【参考上文】（只用于理解语境，不要翻译，也不要出现在输出里）：');
    preceding.forEach((line) => parts.push(contextLine(line)));
  }
  if (following.length > 0) {
    parts.push('【参考下文】（同上）：');
    following.forEach((line) => parts.push(contextLine(line)));
  }
  // 术语表激活只看正文行命中（上下文不参与，避免把无关术语拉进请求）
  const pairs = Object.entries(glossary || {}).filter(([jp]) => lines.some((line) => line.includes(jp)));
  if (pairs.length > 0) {
    parts.push('翻译的时候参考下面的术语表：');
    for (const [jp, zh] of pairs) parts.push(`${jp} => ${zh}`);
  }
  parts.push('小说原文如下，注意要保留每一段开头的编号：');
  lines.forEach((line, i) => parts.push(`#${i + 1}:${line}`));
  if (lines.length === 1) parts.push('原文到此为止');   // 防止乱编
  messages.push({ role: 'user', content: parts.join('\n') });
  return messages;
}

// ---- 中文检测（镜像 utils.ts detectChinese）----
const RE_CHINESE = /[:|#| |0-9|\u4e00-\u9fa5|\u3002|\uff1f|\uff01|\uff0c|\u3001|\uff1b|\uff1a|\u201c|\u201d|\u2018|\u2019|\uff08|\uff09|\u300a|\u300b|\u3008|\u3009|\u3010|\u3011|\u300e|\u300f|\u300c|\u300d|\ufe43|\ufe44|\u3014|\u3015|\u2026|\u2014|\uff5e|\ufe4f|\uffe5]/;
const RE_KANA = /[\u3041-\u3096]|[\u30A1-\u30FA]/;
const RE_ENGLISH = /[a-zA-Z]/;

export function detectChinese(text) {
  const cleaned = String(text || '').replace(/(https?:\/\/[^\s]+)/g, '');
  if (cleaned.length === 0) return false;
  let zh = 0;
  let jp = 0;
  let en = 0;
  for (const c of cleaned) {
    if (RE_CHINESE.test(c)) zh += 1;
    else if (RE_KANA.test(c)) jp += 1;
    else if (RE_ENGLISH.test(c)) en += 1;
  }
  const pZh = zh / cleaned.length;
  const pJp = jp / cleaned.length;
  const pEn = en / cleaned.length;
  return pZh > 0.75 || (pZh > pJp && pZh > pEn * 2 && pJp < 0.1);
}

// ---- 解析（镜像 openai-prompt.ts parseAnswer）----
export function parseTranslateAnswer(answer, originalLines) {
  const lineContentMap = new Map();
  for (const rawLine of String(answer || '').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^#(\d+)(?:[:：]|\s+)(.*)/);
    if (match) lineContentMap.set(Number.parseInt(match[1], 10), match[2]);
  }
  const result = [];
  for (let i = 0; i < originalLines.length; i += 1) {
    const originalLine = originalLines[i];
    if (originalLine.trim().length === 0) {
      result.push(originalLine);
      continue;
    }
    const translated = lineContentMap.get(i + 1);
    if (translated === undefined) throw new Error('行数不匹配');
    const heading = originalLine.match(/^(\s*)/)?.[1] ?? '';
    result.push(heading + translated.trimStart());
  }
  return result;
}

// ---- 条目级对账解析（③ 补发重试用；语义与 parseTranslateAnswer 逐条一致，缺行不抛）----
// 返回 { map: Map<index0, 已含前导空白的译文>, missing: number[]（缺失行 index0） }；
// 空行不进 map/missing（调用方原样保留原文）。
export function parseTranslateAnswerPartial(answer, originalLines) {
  const lineContentMap = new Map();
  for (const rawLine of String(answer || '').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^#(\d+)(?:[:：]|\s+)(.*)/);
    if (match) lineContentMap.set(Number.parseInt(match[1], 10), match[2]);
  }
  const map = new Map();
  const missing = [];
  for (let i = 0; i < originalLines.length; i += 1) {
    const originalLine = originalLines[i];
    if (originalLine.trim().length === 0) continue;
    const translated = lineContentMap.get(i + 1);
    if (translated === undefined) { missing.push(i); continue; }
    const heading = originalLine.match(/^(\s*)/)?.[1] ?? '';
    map.set(i, heading + translated.trimStart());
  }
  return { map, missing };
}

// ---- 单段翻译（镜像 openai-translator 的重试/二分语义）----
// call: (messages) => Promise<{ ok, content?, error? }>（由管线注入，测试可桩）
// context.preceding / context.following：相邻段上下文（可选；补发请求同样带上——刻意偏离 LG 的"重试丢上下文"：
// 补发只剩缺行，上下文此时最有用于对齐人称/指代）
async function translateLines(lines, context) {
  if (lines.length === 0) return [];
  if (lines.every((l) => l.trim().length === 0)) return [...lines];
  if (context.signal && context.signal.aborted) throw new Error('aborted');
  const messages = buildTranslateMessages(lines, context.glossary, {
    systemPrompt: context.systemPrompt,
    thinking: context.thinking,
    preceding: context.preceding,
    following: context.following,
  });
  const result = await context.call(messages);
  if (!result || !result.ok) {
    const err = new Error((result && result.error) || '请求失败');
    if (result && result.retryAfterMs) err.retryAfterMs = result.retryAfterMs;   // 调度器重试耗尽后仍失败：给调用方等待依据
    throw err;
  }
  return parseTranslateAnswer(String(result.content || ''), lines);
}

// 条目级对账单次请求：返回 { map, missing }（缺行不抛，供补发模式使用；请求失败仍抛）
async function translateLinesPartial(lines, context) {
  if (lines.length === 0) return { map: new Map(), missing: [] };
  if (lines.every((l) => l.trim().length === 0)) return { map: new Map(), missing: [] };
  if (context.signal && context.signal.aborted) throw new Error('aborted');
  const messages = buildTranslateMessages(lines, context.glossary, {
    systemPrompt: context.systemPrompt,
    thinking: context.thinking,
    preceding: context.preceding,
    following: context.following,
  });
  const result = await context.call(messages);
  if (!result || !result.ok) {
    const err = new Error((result && result.error) || '请求失败');
    if (result && result.retryAfterMs) err.retryAfterMs = result.retryAfterMs;   // 调度器重试耗尽后仍失败：给调用方等待依据
    throw err;
  }
  return parseTranslateAnswerPartial(String(result.content || ''), lines);
}

// 二分拆分（对单行失败回退原文；与站点 binaryTranslate 相同）
export async function binaryTranslate(lines, context) {
  const binary = async (left, right) => {
    if (context.signal && context.signal.aborted) throw new Error('aborted');
    if (left >= right) return [];
    if (right - left === 1) {
      const result = await translateLines([lines[left]], context);
      return result.length === 1 ? result : [lines[left]];
    }
    const mid = Math.floor((left + right) / 2);
    const [partLeft, partRight] = await Promise.all([binary(left, mid), binary(mid, right)]);
    const expectedLeftLen = mid - left;
    const expectedRightLen = right - mid;
    const fixedLeft = partLeft.length === expectedLeftLen ? partLeft : await binary(left, mid);
    const fixedRight = partRight.length === expectedRightLen ? partRight : await binary(mid, right);
    return fixedLeft.concat(fixedRight);
  };
  return binary(0, lines.length);
}

export async function translateSegment(lines, context) {
  if (lines.length === 0) return [];
  if (lines.every((l) => l.trim().length === 0)) return [...lines];
  const log = context.log || (() => { });
  let retry = 0;
  let failBecauseLineNumberNotMatch = 0;
  const bump = () => { retry += 1; if (context.onRetry) context.onRetry(retry); };
  // 条目级补发（③）：已拿到的行按原位保存；空行原样保留、不占编号。整段重试时重置回全量。
  const resetPending = () => {
    const got = lines.map((line) => (line.trim().length === 0 ? line : null));
    return { got, pending: lines.map((line, idx) => ({ idx, line })).filter((p) => got[p.idx] === null) };
  };
  let { got, pending } = resetPending();
  while (retry < 3) {
    let parsed;
    try {
      // 只对缺失行重编号组段（buildTranslateMessages 语义不变：段内 #1..#M）
      parsed = await translateLinesPartial(pending.map((p) => p.line), context);
    } catch (err) {
      const message = (err && err.message) || String(err);
      if (context.signal && context.signal.aborted) throw err;
      log(`翻译错误：${message}`);
      // 上游限流/超时（带 retryAfterMs）时先按给出时间等待再重试，避免连续重锤
      if (context.wait && err && err.retryAfterMs) {
        try { await context.wait(err.retryAfterMs); } catch (e) { throw err; }
      }
      bump();
      continue;
    }
    let hit = 0;
    for (const [i, text] of parsed.map) {
      if (i < 0 || i >= pending.length) continue;   // 越界编号忽略（模型多编/错编）
      got[pending[i].idx] = text;
      hit += 1;
    }
    if (hit === 0) {
      // 全失败（一条编号都没对账上）→ 与旧「行数不匹配」路径同形：普通重试（不触发二分）
      log('输出错误：输出行数不匹配');
      ({ got, pending } = resetPending());
      bump();
      continue;
    }
    pending = lines.map((line, idx) => ({ idx, line })).filter((p) => got[p.idx] === null);
    if (pending.length > 0) {
      log(`输出错误：缺少 ${pending.length} 行，下一轮只补发缺失行`);
      bump();
      continue;
    }
    if (!detectChinese(got.join(' '))) {
      log('输出错误：输出语言不是中文');
      ({ got, pending } = resetPending());
      bump();
      continue;
    }
    return got;
  }
  // 与站点一致：只有"显式行数检查"连续 3 次失败才二分（补发模式下解析缺行走补发路径，该计数不累积——可达性同旧实现）
  if (failBecauseLineNumberNotMatch === 3 && lines.length > 1) {
    return binaryTranslate(lines, context);
  }
  throw new Error('翻译失败：重试次数过多');
}
