// daemon/agent-tools.mjs —— Agent 工具注册表（v1：框架 + doing/ask_user；A2 只读工具 / A3 写入工具在此追加）
// 工具契约：{ name, description, parameters(JSON Schema), requiresApproval?, preview?(args,ctx), execute(args,ctx) }
// execute 返回可 JSON 化的对象；抛错会被 loop 归一化为 { ok:false, error, details }。
export function createToolRegistry(tools = []) {
  const map = new Map();
  for (const tool of tools) {
    if (!tool || !tool.name || typeof tool.execute !== 'function') throw new Error('工具定义不合法：需要 name 与 execute');
    map.set(tool.name, tool);
  }
  return map;
}

export function toolSchemas(registry) {
  return [...registry.values()].map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

// ---- 内置：doing（进度说明，无副作用） ----
export const doingTool = {
  name: 'doing',
  description: '向用户显示一行当前进度的说明（例如「正在核对第三章」）。不产生任何副作用。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '一行进度说明' } },
    required: ['text'],
  },
  async execute(args, ctx) {
    const text = String((args && args.text) || '').slice(0, 200);
    ctx.onEvent && ctx.onEvent({ type: 'doing', text });
    return { ok: true, doing: text };
  },
};

// ---- 内置：ask_user（追问；阻塞等待用户回答） ----
export const askUserTool = {
  name: 'ask_user',
  description: '向用户提出一个选择题并等待回答（最多 4 个选项）。需要用户拍板或补充信息时使用。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问的问题' },
      options: {
        type: 'array',
        description: '2-4 个选项',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, label: { type: 'string' } },
          required: ['id', 'label'],
        },
      },
    },
    required: ['question'],
  },
  async execute(args, ctx) {
    const question = String((args && args.question) || '').slice(0, 500);
    const options = (Array.isArray(args && args.options) ? args.options : [])
      .slice(0, 4)
      .map((o) => ({ id: String((o && o.id) || ''), label: String((o && o.label) || '') }))
      .filter((o) => o.id !== '' || o.label !== '');
    const { id, promise } = ctx.sessionApi.ask({ sessionId: ctx.sessionId, kind: 'question', payload: { question, options } });
    ctx.onEvent && ctx.onEvent({ type: 'question', decisionId: id, question, options });
    const decision = await promise;
    if (decision.status !== 'allowed') return { ok: false, error: 'ask_cancelled', details: '用户未回答（取消或超时）' };
    return { ok: true, answer: decision.resolution || null };
  },
};
