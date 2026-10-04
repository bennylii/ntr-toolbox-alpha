// daemon/translate.mjs —— GPT 翻译核心（纯函数 + 单段执行；镜像站点 packages/translator 语义）
// 语义已对照 auto-novel 源码逐条核对：
// - 分段：createLineSegmenter(1500, 30)（长度含换行 +1；超长单行自成一段）
// - 提示词：openai-prompt.ts —— 系统提示固定文本；术语表仅当"段内任一行包含 src"时注入
//   （表头 + "jp => zh"）；正文为 "#${i+1}:${line}"；单行段追加"原文到此为止"
// - 解析：/^#(\d+)(?:[:：]|\s+)(.*)/；空行保留原文；缺失编号抛"行数不匹配"；保留原行前导空白
// - 重试：≤3 次；"输出语言不是中文"用 detectChinese 判定（utils.ts 的阈值）
// - 二分拆分：仅当"连续 3 次显式行数检查失败且行数>1"触发（与站点一致的语义，含其可达性局限）

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

// ---- 提示词（镜像 openai-prompt.ts；systemPrompt/thinking 可由模板注入，协议段不可改）----
export function buildTranslateMessages(lines, glossary, options = {}) {
  const opts = options || {};
  const systemPrompt = (typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim() !== '')
    ? opts.systemPrompt
    : TRANSLATE_SYSTEM_PROMPT;
  const messages = [{ role: 'system', content: systemPrompt }];
  const parts = [];
  const thinking = String(opts.thinking || '').trim();
  if (thinking !== '') parts.push(`【思考指引】\n${thinking}\n`);
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

// ---- 单段翻译（镜像 openai-translator 的重试/二分语义）----
// call: (messages) => Promise<{ ok, content?, error? }>（由管线注入，测试可桩）
async function translateLines(lines, context) {
  if (lines.length === 0) return [];
  if (lines.every((l) => l.trim().length === 0)) return [...lines];
  if (context.signal && context.signal.aborted) throw new Error('aborted');
  const messages = buildTranslateMessages(lines, context.glossary, { systemPrompt: context.systemPrompt, thinking: context.thinking });
  const result = await context.call(messages);
  if (!result || !result.ok) {
    const err = new Error((result && result.error) || '请求失败');
    if (result && result.retryAfterMs) err.retryAfterMs = result.retryAfterMs;   // 调度器重试耗尽后仍失败：给调用方等待依据
    throw err;
  }
  return parseTranslateAnswer(String(result.content || ''), lines);
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
  while (retry < 3) {
    let result;
    try {
      result = await translateLines(lines, context);
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
    if (lines.length !== result.length) {
      failBecauseLineNumberNotMatch += 1;
      log('输出错误：输出行数不匹配');
      bump();
      continue;
    }
    if (!detectChinese(result.join(' '))) {
      log('输出错误：输出语言不是中文');
      bump();
      continue;
    }
    return result;
  }
  // 与站点一致：只有"显式行数检查"连续 3 次失败才二分（解析抛"行数不匹配"走的是普通重试路径）
  if (failBecauseLineNumberNotMatch === 3 && lines.length > 1) {
    return binaryTranslate(lines, context);
  }
  throw new Error('翻译失败：重试次数过多');
}
