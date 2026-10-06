// daemon/agent-loop.mjs —— Agent 主循环（规格见计划：LG Agent 契约层的零依赖重写）
// 一轮 = 用户消息 → [压缩/裁剪 → 模型 → 顺序派发工具 → 回填 tool 结果] × N → 无工具调用即结束。
// 终止条件：无工具调用 / 超步数 / 取消 / 模型失败。写类工具在 manual 模式下先创建审批决定并等待。
import { estimateTokens, trimToBudget } from './agent-llm.mjs';
import { createAgentSession } from './agent-session.mjs';
import { createToolRegistry, toolSchemas } from './agent-tools.mjs';

const anySignal = (signals) => {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
};

export function createAgentLoop({ store, chat, takeUsage = null, tools = [], log = console, options = {} }) {
  const opt = {
    maxSteps: 24,
    approvalMode: 'manual',       // manual | auto
    maxContextTokens: 200000,
    toolResultMaxChars: 12000,
    compactThresholdTokens: 120000,
    keepRecentMessages: 12,
    decisionTimeoutMs: 300000,
    bookKey: '',
    extraSystem: '',
    deps: {},                      // A2/A3：makeClient / pipelines / engine / skills 等
    ...options,
  };
  const registry = createToolRegistry(tools);
  const controllers = new Map();   // sessionId -> AbortController
  const sessionApi = createAgentSession({
    store,
    chat,
    log,
    options: {
      compactThresholdTokens: opt.compactThresholdTokens,
      keepRecentMessages: opt.keepRecentMessages,
      decisionTimeoutMs: opt.decisionTimeoutMs,
    },
  });

  async function runTool(tool, call, ctx) {
    if (call.args === null) return { ok: false, error: 'bad_arguments', details: '工具参数不是合法 JSON' };
    if (tool.requiresApproval && ctx.approvalMode === 'manual') {
      let preview = null;
      if (typeof tool.preview === 'function') {
        try { preview = await tool.preview(call.args, ctx); } catch (e) { preview = { error: String((e && e.message) || e) }; }
      }
      const { id, promise } = sessionApi.ask({
        sessionId: ctx.sessionId,
        kind: 'write',
        payload: { tool: tool.name, args: call.args, preview },
      });
      ctx.onEvent && ctx.onEvent({ type: 'decision', decisionId: id, kind: 'write', tool: tool.name, args: call.args, preview });
      const decision = await promise;
      ctx.onEvent && ctx.onEvent({ type: 'decision_resolved', decisionId: id, status: decision.status });
      if (decision.status !== 'allowed') {
        return { ok: false, error: 'approval_denied', details: `用户未批准（${decision.status}）` };
      }
    }
    try {
      const out = await tool.execute(call.args, ctx);
      return { ok: true, result: out === undefined ? null : out };
    } catch (e) {
      return { ok: false, error: (e && e.code) || 'tool_error', details: String((e && e.message) || e).slice(0, 500) };
    }
  }

  // 一轮对话。返回 { ok, content?, steps?, error? }；异常不抛出（除 aborted 以外都转成结果）
  async function runTurn(sessionId, userText, { signal, onEvent, approvalMode, pinnedSkills } = {}) {
    const session = store.getAgentSession(sessionId);
    if (!session) throw new Error(`会话不存在：${sessionId}`);
    const controller = new AbortController();
    controllers.set(sessionId, controller);
    const composite = signal ? anySignal([signal, controller.signal]) : controller.signal;
    const emit = (event) => { try { onEvent && onEvent(event); } catch { /* 事件回调异常不影响主流程 */ } };
    const effectiveApproval = (approvalMode === 'auto' || approvalMode === 'manual') ? approvalMode : opt.approvalMode;
    const ctx = {
      store,
      sessionId,
      bookKey: session.bookKey || opt.bookKey,
      log,
      options: opt,
      approvalMode: effectiveApproval,
      deps: opt.deps,
      sessionApi,
      onEvent: emit,
      registry,
    };
    store.touchAgentSession(sessionId, { state: 'running' });
    store.appendAgentMessage({ sessionId, role: 'user', content: String(userText == null ? '' : userText) });
    emit({ type: 'user_message', text: String(userText == null ? '' : userText) });
    let steps = 0;
    try {
      for (;;) {
        if (composite.aborted) return { ok: false, error: 'aborted' };
        if (steps >= opt.maxSteps) {
          store.appendAgentMessage({ sessionId, role: 'assistant', content: `已达单轮步数上限（${opt.maxSteps}），需要我继续时请再发一条消息。` });
          emit({ type: 'assistant_message', text: '（步数上限）' });
          return { ok: false, error: 'max_steps', steps };
        }
        steps += 1;

        // 压缩（失败不影响主流程）+ 硬预算裁剪
        let extraSystem = opt.extraSystem;
        if (session.bookKey) {
          const bk = store.getBook(session.bookKey);
          const title = bk && bk.title ? String(bk.title).replace(/\s+/g, ' ').slice(0, 60) : '';
          extraSystem = `${extraSystem}

【当前项目】${session.bookKey}${title ? '（' + title + '）' : ''}
本会话绑定这本书：阅读、翻译、术语、质检等操作的 book 参数缺省即此书；操作其它书需用户明说。`;
        }
        for (const name of pinnedSkills || []) {
          const loaded = opt.deps.skills.read(name);
          extraSystem = `${extraSystem}

【用户点名技能：${name}】
${String(loaded.content || '').slice(0, 6000)}`;
          emit({ type: 'skill_pinned', name });
        }
        const probe = sessionApi.buildMessages(sessionId, { extraSystem });
        await sessionApi.maybeCompact(sessionId, { tokens: estimateTokens(probe).tokens }).catch(() => { });
        let messages = sessionApi.buildMessages(sessionId, { extraSystem });
        messages = trimToBudget(messages, { maxTokens: opt.maxContextTokens }).messages;

        emit({ type: 'step', step: steps, messages: messages.length });
        let result;
        try {
          result = await chat({ messages, tools: toolSchemas(registry), signal: composite });
        } catch (e) {
          if (composite.aborted) return { ok: false, error: 'aborted', steps };
          const err = String((e && e.message) || e);
          store.appendAgentMessage({ sessionId, role: 'assistant', content: `（模型请求失败：${err}）` });
          emit({ type: 'error', error: err });
          return { ok: false, error: err, steps };
        }
        if (!result || !result.ok) {
          const err = (result && result.error) || '模型请求失败';
          store.appendAgentMessage({ sessionId, role: 'assistant', content: `（模型请求失败：${err}）` });
          emit({ type: 'error', error: err });
          return { ok: false, error: err, steps };
        }
        const usage = takeUsage ? takeUsage() : null;
        store.appendAgentMessage({
          sessionId,
          role: 'assistant',
          content: result.content || '',
          toolCalls: result.toolCalls && result.toolCalls.length > 0 ? result.toolCalls : null,
          usage,
        });
        emit({ type: 'assistant_message', text: result.content || '', toolCalls: (result.toolCalls || []).map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })) });

        if (!result.toolCalls || result.toolCalls.length === 0) {
          store.touchAgentSession(sessionId, { state: 'idle' });
          return { ok: true, content: result.content || '', steps };
        }
        for (const call of result.toolCalls) {
          if (composite.aborted) {
            store.appendAgentMessage({ sessionId, role: 'tool', content: JSON.stringify({ ok: false, error: 'aborted' }), toolCallId: call.id, name: call.name });
            return { ok: false, error: 'aborted', steps };
          }
          const tool = registry.get(call.name);
          const outcome = tool
            ? await runTool(tool, call, ctx)
            : { ok: false, error: 'unknown_tool', details: `没有名为 ${call.name} 的工具` };
          const content = JSON.stringify(outcome).slice(0, opt.toolResultMaxChars);
          store.appendAgentMessage({ sessionId, role: 'tool', content, toolCallId: call.id, name: call.name });
          emit({ type: 'tool_result', tool: call.name, ok: outcome.ok, error: outcome.error || '', preview: content.slice(0, 300) });
        }
      }
    } finally {
      controllers.delete(sessionId);
      const still = store.getAgentSession(sessionId);
      if (still && still.state === 'running') store.touchAgentSession(sessionId, { state: 'idle' });
    }
  }

  // 运行中热更新（GUI / 设置页用）：只接受数值预算与审批模式
  function setOptions(partial = {}) {
    for (const [key, raw] of Object.entries(partial || {})) {
      if (['maxContextTokens', 'compactThresholdTokens', 'keepRecentMessages', 'maxSteps', 'toolResultMaxChars'].includes(key)) {
        const n = Math.floor(Number(raw));
        if (Number.isFinite(n) && n > 0) opt[key] = n;
      }
      if (key === 'approvalMode' && (raw === 'auto' || raw === 'manual')) opt.approvalMode = raw;
    }
    return { ...opt };
  }

  function stop(sessionId) {
    const controller = controllers.get(sessionId);
    if (controller) controller.abort();
    // 挂起中的审批/追问一并取消，避免 stop 后还卡在等待里
    const pending = store.getPendingAgentDecision(sessionId);
    if (pending) {
      sessionApi.resolveDecision(pending.id, pending.kind === 'write' ? 'rejected' : 'cancelled', { reason: 'aborted' });
    }
    return Boolean(controller);
  }

  return {
    options: opt,
    registry,
    skills: opt.deps.skills || null,
    runTurn,
    stop,
    setOptions,
    resolveDecision: (id, status, resolution) => sessionApi.resolveDecision(id, status, resolution),
    pending: (sessionId) => sessionApi.pending(sessionId),
    session: sessionApi,
    running: (sessionId) => controllers.has(sessionId),
  };
}
