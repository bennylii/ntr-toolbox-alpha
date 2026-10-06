// daemon/agent-session.mjs —— Agent 会话：消息→模型历史组装、摘要压缩、审批/追问决策（broker）
// 设计：消息全量保存在 SQLite（时间线可回放），压缩靠 session.summary + summaryUpTo 标记，
//      不删除历史；模型只看到摘要 + summaryUpTo 之后的消息。
export const DEFAULT_AGENT_SYSTEM = `你是 NTR Daemon 的本地助手，帮助用户管理 n.novelia.cc 上的书、术语表、翻译与质检。
规则：
- 需要站内信息时调用提供的工具；不要臆造书籍、术语表、译文或运行结果。
- 工具输出可能被截断；需要更多内容时缩小参数范围（按章、按行窗口、按条数）。
- 写操作（术语表写入/回滚、修改规则与提示词等）会先请求用户审批；被拒绝时不要换个说法重试同一操作，改为只读检查或给出说明。
- 程序化的数据批处理（读取/筛选/聚合/核对/准备变更清单）优先用 workspace_run 写脚本完成（CodeAct），只把需要语义判断的数据带回对话；提交修改先输出提交简报，再用 workspace_apply。
- 回复使用简体中文，简明扼要；数字、ID、书名保持原样。
- 开始新任务或新对话前，先用 read_skill 加载 agent-charter 技能并按其准则处理创作与翻译内容；未加载前不输出任务答案。`;

const SUMMARY_SYSTEM = '你是对话历史压缩器。把对话历史压缩成要点式摘要，保留：用户目标、已确认的事实与数字、已完成的操作与结果、未决事项。只输出摘要正文，不要客套。';

export function createAgentSession({ store, chat, log = console, options = {} }) {
  const opt = {
    compactThresholdTokens: 120000,   // 超过则压缩（估算值）
    keepRecentMessages: 12,           // 压缩时保留的最近消息条数
    decisionTimeoutMs: 300000,        // 审批/追问等待上限（超时视为拒绝/取消）
  };
  for (const [key, value] of Object.entries(options || {})) if (value !== undefined) opt[key] = value;
  const waiters = new Map();   // decisionId -> { resolve, timer }

  function settle(id, status, resolution) {
    const waiter = waiters.get(Number(id));
    if (waiter) {
      waiters.delete(Number(id));
      clearTimeout(waiter.timer);
      waiter.resolve({ id: Number(id), status, resolution: resolution || null });
    }
  }

  // 外部（CLI / HTTP / GUI）解析决定
  function resolveDecision(id, status, resolution) {
    const ok = store.resolveAgentDecision(id, status, resolution);
    if (ok) settle(id, status, resolution);
    return ok;
  }

  // 发起一个决定并等待：kind='write'（审批）/ 'question'（追问）
  function ask({ sessionId, kind, payload = null, timeoutMs = opt.decisionTimeoutMs }) {
    const id = store.createAgentDecision({ sessionId, kind, payload });
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        store.resolveAgentDecision(id, kind === 'write' ? 'rejected' : 'cancelled', { reason: 'timeout' });
        settle(id, kind === 'write' ? 'rejected' : 'cancelled', { reason: 'timeout' });
      }, Math.max(1000, Number(timeoutMs) || opt.decisionTimeoutMs));
      waiters.set(id, { resolve, timer });
    });
    return { id, promise };
  }

  // 组装模型历史：system(+摘要) + summaryUpTo 之后的消息
  function buildMessages(sessionId, { extraSystem = '' } = {}) {
    const session = store.getAgentSession(sessionId);
    const summary = (session && session.summary) || '';
    const upTo = (session && session.summaryUpTo) || 0;
    const system = [
      session.personality ? `【用户系统指令】
${session.personality}` : '',
      extraSystem ? `${DEFAULT_AGENT_SYSTEM}\n\n${extraSystem}` : DEFAULT_AGENT_SYSTEM,
      summary ? `【历史摘要（更早的对话已压缩）】\n${summary}` : '',
    ].filter(Boolean).join('\n\n');
    const messages = [{ role: 'system', content: system }];
    for (const row of store.listAgentMessages(sessionId, { afterSeq: upTo })) {
      if (row.role === 'user') {
        messages.push({ role: 'user', content: row.content });
      } else if (row.role === 'assistant') {
        const msg = { role: 'assistant', content: row.content || '' };
        if (Array.isArray(row.toolCalls) && row.toolCalls.length > 0) {
          msg.tool_calls = row.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argsRaw || JSON.stringify(tc.args || {}) },
          }));
          if (!msg.content) msg.content = null;
        }
        messages.push(msg);
      } else if (row.role === 'tool') {
        const msg = { role: 'tool', tool_call_id: row.toolCallId || '', content: row.content || '' };
        if (row.name) msg.name = row.name;
        messages.push(msg);
      } else if (row.role === 'system') {
        messages.push({ role: 'system', content: row.content });
      }
    }
    return messages;
  }

  const transcriptOf = (rows) => rows.map((row) => {
    if (row.role === 'assistant') {
      const calls = Array.isArray(row.toolCalls) && row.toolCalls.length > 0
        ? `（调用工具：${row.toolCalls.map((tc) => tc.name).join('、')}）` : '';
      return `助手：${row.content || ''}${calls}`;
    }
    if (row.role === 'tool') return `工具(${row.name || row.toolCallId})：${String(row.content || '').slice(0, 600)}`;
    return `用户：${row.content || ''}`;
  }).join('\n');

  // 摘要压缩：把 summaryUpTo 之后、"最近 N 条"之前的部分并入摘要
  async function maybeCompact(sessionId, { tokens = null } = {}) {
    const session = store.getAgentSession(sessionId);
    if (!session) return { compacted: false };
    const rows = store.listAgentMessages(sessionId, { afterSeq: session.summaryUpTo || 0 });
    if (rows.length <= opt.keepRecentMessages) return { compacted: false };
    const estimated = tokens == null ? null : tokens;
    if (estimated != null && estimated <= opt.compactThresholdTokens) return { compacted: false };
    let cutoff = rows.length - opt.keepRecentMessages;
    while (cutoff > 0 && rows[cutoff] && rows[cutoff].role === 'tool') cutoff -= 1;
    if (cutoff > 0 && rows[cutoff - 1] && rows[cutoff - 1].role === 'assistant'
      && Array.isArray(rows[cutoff - 1].toolCalls) && rows[cutoff - 1].toolCalls.length > 0) cutoff -= 1;
    if (cutoff <= 0) return { compacted: false };
    const old = rows.slice(0, cutoff);
    const upToSeq = old[old.length - 1].seq;
    const prompt = [
      session.summary ? `已有摘要：\n${session.summary}\n` : '',
      `需要合并的新对话：\n${transcriptOf(old)}`,
    ].filter(Boolean).join('\n');
    const result = await chat({ messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: prompt }] });
    if (!result || !result.ok || !String(result.content || '').trim()) {
      log.log('[agent] 压缩失败：摘要请求未成功，保留全量历史');
      return { compacted: false };
    }
    const summary = String(result.content).trim();
    store.setAgentSummary(sessionId, { summary, summaryUpTo: upToSeq });
    log.log(`[agent] 已压缩 ${old.length} 条历史（seq ≤ ${upToSeq}，摘要 ${summary.length} 字）`);
    return { compacted: true, summarized: old.length, upToSeq, summary };
  }

  return {
    options: opt,
    resolveDecision,
    ask,
    buildMessages,
    maybeCompact,
    pending: (sessionId) => store.getPendingAgentDecision(sessionId),
    hasWaiter: (id) => waiters.has(Number(id)),
  };
}
