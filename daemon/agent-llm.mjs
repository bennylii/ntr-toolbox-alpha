// daemon/agent-llm.mjs —— Agent 的模型调用层（OpenAI 兼容 tool calling；经 LlmScheduler 统一限流/记账）
// 职责：把调度器的原始结果规范化为 { ok, content, toolCalls:[{id,name,args,argsRaw}], finishReason, error? }；
//       工具参数 JSON 宽容解析；历史裁剪辅助。协议细节（tools 请求体）在 scheduler.mjs 的 _callToolChat。
import { estimateTokens } from './scheduler.mjs';

export { estimateTokens };

// 工具参数解析：模型偶尔给出带代码围栏/单引号/尾逗号的 JSON —— 宽容修复后仍失败则返回 null
export function parseToolArguments(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') return {};
  const attempts = [text];
  const fenced = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  if (fenced !== text) attempts.push(fenced);
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace >= 0 && lastBrace > brace) attempts.push(text.slice(brace, lastBrace + 1));
  for (const candidate of attempts) {
    try { return JSON.parse(candidate); } catch { /* 继续尝试 */ }
  }
  // 单引号 + 尾逗号兜底（仅用于字面量字符串场景，不做完整 JSON5）
  const repaired = (attempts[attempts.length - 1] || text)
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  try { return JSON.parse(repaired); } catch { return null; }
}

export function createAgentLlm({ scheduler, log = console }) {
  return {
    // 取走本进程累计用量（agent loop 在每次模型调用后落库到消息）
    takeUsage: () => scheduler.takeUsage(),
    // chat({ messages, tools, toolChoice, signal }) → 规范化结果
    async chat({ messages, tools, toolChoice, signal } = {}) {
      const result = await scheduler.call(messages, { signal, tools, toolChoice });
      if (!result || !result.ok) {
        return { ok: false, error: (result && result.error) || '请求失败', status: result && result.status, retryAfterMs: result && result.retryAfterMs };
      }
      const rawCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      const toolCalls = [];
      for (const tc of rawCalls) {
        const args = parseToolArguments(tc.arguments);
        if (args === null) {
          toolCalls.push({ id: tc.id, name: tc.name, args: null, argsRaw: tc.arguments, parseError: true });
        } else {
          toolCalls.push({ id: tc.id, name: tc.name, args, argsRaw: tc.arguments });
        }
      }
      return {
        ok: true,
        content: String(result.content || ''),
        toolCalls,
        finishReason: result.finishReason || '',
        workerId: result.workerId,
      };
    },
  };
}

// 历史裁剪（硬上限兜底）：从最旧开始丢弃直到不超预算；assistant(tool_calls) 与其 tool 结果成对移除；system 永不丢。
// 返回 { messages, dropped }（不修改入参）。更聪明的做法是 agent-session 的摘要压缩（先于本函数生效）。
export function trimToBudget(messages, { maxTokens = 200000 } = {}) {
  const list = (messages || []).map((m) => ({ ...m }));
  const tokensOf = (arr) => estimateTokens(arr).tokens;
  if (tokensOf(list) <= maxTokens) return { messages: list, dropped: 0 };
  const system = list.filter((m) => m.role === 'system');
  const rest = list.filter((m) => m.role !== 'system');
  let dropped = 0;
  while (rest.length > 0 && tokensOf(system) + tokensOf(rest) > maxTokens) {
    const first = rest.shift();
    dropped += 1;
    if (first.role === 'assistant' && Array.isArray(first.tool_calls) && first.tool_calls.length > 0) {
      while (rest.length > 0 && rest[0].role === 'tool') { rest.shift(); dropped += 1; }
    }
  }
  return { messages: [...system, ...rest], dropped };
}
