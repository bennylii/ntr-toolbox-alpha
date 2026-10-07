// daemon/agent-test.mjs —— Agent 纯函数/回路单测（DI：假 chat，不需要 mock/网络）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (name) => import(pathToFileURL(path.join(here, name)).href);
const { Store } = await imp('store.mjs');
const { parseToolArguments, trimToBudget } = await imp('agent-llm.mjs');
const { createAgentSession, DEFAULT_AGENT_SYSTEM, resetSummaryIfBeyond } = await imp('agent-session.mjs');
const { createAgentLoop } = await imp('agent-loop.mjs');
const { doingTool, askUserTool } = await imp('agent-tools.mjs');

const TEST_DB = path.join(here, '.test-agent.db');
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suffix); } catch { } }
const store = new Store(TEST_DB);
const quiet = { log: () => { }, error: () => { } };

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  const run = async () => {
    try { await fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + ((e && e.message) || e)); }
  };
  return run();
};

// ---- 假 chat：按脚本返回；脚本项用完则重复最后一项 ----
const scriptChat = (script, { onCall = null } = {}) => {
  let i = 0;
  return async (params) => {
    const item = script[Math.min(i, script.length - 1)];
    i += 1;
    if (onCall) onCall(params, i);
    if (typeof item === 'function') return item(params);
    return item;
  };
};
const text = (content) => ({ ok: true, content, toolCalls: [], finishReason: 'stop' });
const call = (name, args, { raw = null, id = `call_${name}` } = {}) => ({
  ok: true,
  content: '',
  toolCalls: [{ id, name, args: raw === null ? args : null, argsRaw: raw === null ? JSON.stringify(args) : raw }],
  finishReason: 'tool_calls',
});

console.log('== Agent：工具参数解析 ==');
await t('合法 JSON / 代码围栏 / 前后夹杂 / 单引号+尾逗号 / 非法', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseToolArguments('好的：{"a":3} 以上'), { a: 3 });
  assert.deepEqual(parseToolArguments("{'a': 4,}"), { a: 4 });
  assert.deepEqual(parseToolArguments(''), {});
  assert.equal(parseToolArguments('{oops'), null);
});

console.log('== Agent：历史裁剪 ==');
await t('未超预算不动；超预算丢最旧且保留 system；工具组整组丢（不出现半截）', () => {
  const msgs = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
  ];
  const keep = trimToBudget(msgs, { maxTokens: 10000 });
  assert.equal(keep.dropped, 0);
  const tight = trimToBudget(msgs, { maxTokens: 6 });
  assert.equal(tight.messages[0].role, 'system');
  assert.ok(!tight.messages.some((m) => m.content === 'u1'), JSON.stringify(tight.messages));
  assert.ok(tight.messages.some((m) => m.content === 'u2'), JSON.stringify(tight.messages));
  // 工具组完整性：有 tool_calls 就必有对应 tool 结果（反之亦然）
  const hasCall = tight.messages.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
  const hasResult = tight.messages.some((m) => m.role === 'tool');
  assert.equal(hasCall, hasResult, JSON.stringify(tight.messages));
});

console.log('== Agent：会话存储与历史组装 ==');
const sid = store.createAgentSession({ bookKey: 'web:mock/x', title: 't' });
await t('会话 CRUD / 消息 seq / 用量累计', () => {
  assert.ok(store.getAgentSession(sid));
  assert.equal(store.listAgentSessions(5).length, 1);
  const m1 = store.appendAgentMessage({ sessionId: sid, role: 'user', content: '你好' });
  const m2 = store.appendAgentMessage({ sessionId: sid, role: 'assistant', content: '在', usage: { requests: 1, promptTokens: 10, completionTokens: 5 } });
  assert.equal(m2.seq, m1.seq + 1);
  const usage = store.agentSessionUsage(sid);
  assert.deepEqual(usage, { requests: 1, promptTokens: 10, completionTokens: 5 });
  assert.equal(store.listAgentMessages(sid).length, 2);
});
await t('buildMessages：角色映射 + assistant tool_calls 线上格式', () => {
  store.appendAgentMessage({ sessionId: sid, role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'doing', args: { text: 'x' }, argsRaw: '{"text":"x"}' }] });
  store.appendAgentMessage({ sessionId: sid, role: 'tool', content: '{"ok":true}', toolCallId: 'c9', name: 'doing' });
  const api = createAgentSession({ store, chat: null, log: quiet });
  const messages = api.buildMessages(sid);
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.startsWith(DEFAULT_AGENT_SYSTEM.slice(0, 10)));
  const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant.tool_calls[0].function.name, 'doing');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"text":"x"}');
  assert.equal(assistant.content, null);
  const tool = messages.find((m) => m.role === 'tool');
  assert.equal(tool.tool_call_id, 'c9');
});
await t('摘要注入 + summaryUpTo 之前的消息不再进模型历史', () => {
  const rows = store.listAgentMessages(sid);
  store.setAgentSummary(sid, { summary: '早前：用户打了招呼。', summaryUpTo: rows[0].seq });
  const api = createAgentSession({ store, chat: null, log: quiet });
  const messages = api.buildMessages(sid);
  assert.ok(messages[0].content.includes('早前：用户打了招呼。'), messages[0].content);
  assert.ok(!messages.some((m) => m.role === 'user' && m.content === '你好'), JSON.stringify(messages));
});

console.log('== Agent：压缩 ==');
await t('maybeCompact：旧段并入摘要、retain 最近消息、摘要请求失败则不动', async () => {
  const sid2 = store.createAgentSession({ bookKey: '', title: 'compact' });
  for (let i = 0; i < 20; i += 1) {
    store.appendAgentMessage({ sessionId: sid2, role: 'user', content: `问题${i}` });
    store.appendAgentMessage({ sessionId: sid2, role: 'assistant', content: `回答${i}` });
  }
  let summaryCalls = 0;
  const chat = async ({ messages }) => {
    assert.ok(String(messages[0].content).includes('压缩'));
    summaryCalls += 1;
    return text('要点：用户问了 0-15 号问题。');
  };
  const api = createAgentSession({ store, chat, log: quiet, options: { keepRecentMessages: 4, compactThresholdTokens: 1 } });
  const r = await api.maybeCompact(sid2, { tokens: 999999 });
  assert.equal(r.compacted, true, JSON.stringify(r));
  assert.equal(summaryCalls, 1);
  const session = store.getAgentSession(sid2);
  assert.ok(session.summary.includes('0-15'));
  assert.ok(session.summaryUpTo > 0);
  const kept = store.listAgentMessages(sid2, { afterSeq: session.summaryUpTo });
  assert.equal(kept.length, 4, JSON.stringify(kept.map((k) => k.content)));
  // 全量历史仍在（时间线不删）
  assert.equal(store.listAgentMessages(sid2).length, 40);
  // 失败路径
  const api2 = createAgentSession({ store, chat: async () => ({ ok: false, error: 'x' }), log: quiet, options: { keepRecentMessages: 4, compactThresholdTokens: 1 } });
  const sid3 = store.createAgentSession({ bookKey: '', title: 'fail' });
  for (let i = 0; i < 10; i += 1) store.appendAgentMessage({ sessionId: sid3, role: 'user', content: `u${i}` });
  const r2 = await api2.maybeCompact(sid3, { tokens: 999999 });
  assert.equal(r2.compacted, false);
  assert.equal(store.getAgentSession(sid3).summaryUpTo, 0);
});

console.log('== Agent：系统指令与点名技能 ==');
await t('buildMessages：会话 personality 注入【用户系统指令】', () => {
  const sidP = store.createAgentSession({ bookKey: '', title: 'p' });
  store.setAgentPersonality(sidP, '回答风格：短句、先结论。');
  const api = createAgentSession({ store, chat: null, log: quiet });
  const messages = api.buildMessages(sidP);
  assert.ok(messages[0].content.includes('【用户系统指令】'), messages[0].content);
  assert.ok(messages[0].content.includes('先结论'), messages[0].content);
});
await t('runTurn：pinnedSkills 注入系统提示（假 chat 捕获）', async () => {
  const skillsFake = { read: (name) => ({ skill: name, path: 'SKILL.md', basePath: '/x', content: `【技能正文 ${name}】请按流程执行。` }) };
  let seenSystem = '';
  const ses2 = store.createAgentSession({ bookKey: '', title: 'pin' });
  const loop = createAgentLoop({
    store,
    chat: async (params) => { seenSystem = String(params.messages[0].content || ''); return text('好的。'); },
    tools: [doingTool], log: quiet,
    options: { deps: { skills: skillsFake } },
  });
  const r = await loop.runTurn(ses2, '按 @glossary-workflow 来', { pinnedSkills: ['glossary-workflow'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(seenSystem.includes('【用户点名技能：glossary-workflow】'), seenSystem.slice(0, 200));
  assert.ok(seenSystem.includes('请按流程执行'), seenSystem.slice(0, 200));
});

console.log('== Agent：任务宪章接线 ==');
t('DEFAULT_AGENT_SYSTEM 要求先加载 agent-charter', () => {
  assert.ok(DEFAULT_AGENT_SYSTEM.includes('agent-charter'), DEFAULT_AGENT_SYSTEM);
  assert.ok(DEFAULT_AGENT_SYSTEM.includes('read_skill'), '应指明用 read_skill 加载');
});

console.log('== Agent：决策（审批/追问） ==');
await t('ask → 挂起 → resolve allowed；超时按 kind 拒绝/取消', async () => {
  const api = createAgentSession({ store, chat: null, log: quiet, options: { decisionTimeoutMs: 60000 } });
  const w = api.ask({ sessionId: sid, kind: 'write', payload: { tool: 'x' } });
  const pending = store.getPendingAgentDecision(sid);
  assert.ok(pending && pending.payload.tool === 'x');
  api.resolveDecision(w.id, 'allowed', { via: 'test' });
  const d = await w.promise;
  assert.equal(d.status, 'allowed');
  assert.equal(store.getPendingAgentDecision(sid), null);

  const q = api.ask({ sessionId: sid, kind: 'question', payload: { question: 'q' }, timeoutMs: 60 });
  const dq = await q.promise;
  assert.equal(dq.status, 'cancelled');
  assert.equal(dq.resolution.reason, 'timeout');
  const w2 = api.ask({ sessionId: sid, kind: 'write', payload: {}, timeoutMs: 60 });
  const dw = await w2.promise;
  assert.equal(dw.status, 'rejected');
});

console.log('== Agent：主循环 ==');
const mkLoop = ({ script, tools, options = {}, onEvent = null }) => {
  const ses = store.createAgentSession({ bookKey: '', title: 'loop' });
  const loop = createAgentLoop({
    store, chat: scriptChat(script), takeUsage: () => ({ requests: 1, promptTokens: 3, completionTokens: 2 }),
    tools, log: quiet, options: { maxSteps: 4, approvalMode: 'manual', ...options },
  });
  return { ses, loop, events: () => loop.__events || [] };
};
await t('工具调用 → 回填 → 最终文本；消息与事件序列正确', async () => {
  const { ses, loop } = mkLoop({
    script: [call('doing', { text: '第一步' }), text('完成了。')],
    tools: [doingTool],
  });
  const events = [];
  const r = await loop.runTurn(ses, '开始', { onEvent: (e) => events.push(e.type) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.content, '完成了。');
  assert.deepEqual(events, ['user_message', 'step', 'assistant_message', 'doing', 'tool_result', 'step', 'assistant_message']);
  const rows = store.listAgentMessages(ses);
  assert.deepEqual(rows.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(rows[2].name, 'doing');
  assert.equal(rows[3].content, '完成了。');
  assert.equal(store.agentSessionUsage(ses).requests, 2, 'usage 每次模型调用落库');
});
await t('审批拒绝 → approval_denied 回填，模拟不执行', async () => {
  let executed = 0;
  const writeTool = {
    name: 'write_x', description: '写', parameters: { type: 'object', properties: {} }, requiresApproval: true,
    preview: () => ({ diff: 'x' }),
    async execute() { executed += 1; return { ok: true }; },
  };
  const { ses, loop } = mkLoop({ script: [call('write_x', {}), text('好，已放弃。')], tools: [writeTool] });
  const r = await loop.runTurn(ses, '写点东西', {
    onEvent: (e) => { if (e.type === 'decision') setTimeout(() => loop.resolveDecision(e.decisionId, 'rejected'), 0); },
  });
  assert.equal(r.ok, true);
  assert.equal(executed, 0);
  const toolRow = store.listAgentMessages(ses).find((x) => x.role === 'tool');
  assert.ok(toolRow.content.includes('approval_denied'), toolRow.content);
});
await t('审批放行 → 执行；auto 模式跳过审批', async () => {
  let executed = 0;
  const writeTool = {
    name: 'write_y', description: '写', parameters: { type: 'object', properties: {} }, requiresApproval: true,
    async execute() { executed += 1; return { ok: true, wrote: 1 }; },
  };
  const manual = mkLoop({ script: [call('write_y', {}), text('完成。')], tools: [writeTool] });
  await manual.loop.runTurn(manual.ses, 'go', {
    onEvent: (e) => { if (e.type === 'decision') setTimeout(() => manual.loop.resolveDecision(e.decisionId, 'allowed'), 0); },
  });
  assert.equal(executed, 1);
  const auto = mkLoop({ script: [call('write_y', {}), text('完成。')], tools: [writeTool], options: { approvalMode: 'auto' } });
  const events = [];
  await auto.loop.runTurn(auto.ses, 'go', { onEvent: (e) => events.push(e.type) });
  assert.equal(executed, 2);
  assert.ok(!events.includes('decision'), 'auto 模式不应产生审批事件');
});
await t('未知工具 / 非法参数 → 归一化错误回填后继续', async () => {
  const { ses, loop } = mkLoop({
    script: [
      { ok: true, content: '', toolCalls: [{ id: 'u1', name: 'nope', args: {}, argsRaw: '{}' }, { id: 'u2', name: 'doing', args: null, argsRaw: '{bad' }], finishReason: 'tool_calls' },
      text('知道了。'),
    ],
    tools: [doingTool],
  });
  const r = await loop.runTurn(ses, 'x', {});
  assert.equal(r.ok, true);
  const tools = store.listAgentMessages(ses).filter((x) => x.role === 'tool');
  assert.ok(tools[0].content.includes('unknown_tool'));
  assert.ok(tools[1].content.includes('bad_arguments'));
});
await t('超步数终止（max_steps）', async () => {
  const { ses, loop } = mkLoop({ script: [call('doing', { text: 'x' })], tools: [doingTool], options: { maxSteps: 3 } });
  const r = await loop.runTurn(ses, 'go', {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'max_steps');
  assert.equal(r.steps, 3);
});
await t('stop() 中止在途轮次（aborted）', async () => {
  const sesAbort = store.createAgentSession({ bookKey: '', title: 'abort' });
  const loop = createAgentLoop({
    store,
    chat: async ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(text('太慢了')), 5000);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    }),
    tools: [doingTool], log: quiet, options: { maxSteps: 2 },
  });
  const pending = loop.runTurn(sesAbort, '慢任务', {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(loop.stop(sesAbort), true);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.ok(/abort/i.test(r.error), JSON.stringify(r));
  assert.equal(store.getAgentSession(sesAbort).state, 'idle');
});
await t('模型失败 → 落一条说明并返回错误', async () => {
  const { ses, loop } = mkLoop({ script: [{ ok: false, error: 'HTTP 500' }], tools: [doingTool] });
  const r = await loop.runTurn(ses, 'x', {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'HTTP 500');
  const last = store.listAgentMessages(ses).at(-1);
  assert.ok(last.role === 'assistant' && last.content.includes('HTTP 500'));
});
await t('ask_user：提问事件 → 回答回填工具结果', async () => {
  const { ses, loop } = mkLoop({
    script: [call('ask_user', { question: '选哪个？', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), text('收到。')],
    tools: [askUserTool],
  });
  const r = await loop.runTurn(ses, '问一下', {
    onEvent: (e) => { if (e.type === 'question') setTimeout(() => loop.resolveDecision(e.decisionId, 'allowed', { selected: 'b' }), 0); },
  });
  assert.equal(r.ok, true);
  const toolRow = store.listAgentMessages(ses).find((x) => x.role === 'tool');
  assert.ok(toolRow.content.includes('"selected":"b"'), toolRow.content);
});

console.log('== Agent：会话截断/重跑原语（重新生成与编辑重发的地基） ==');
await t('appendUserMessage:false → 不落重复用户消息，直接以既有历史续跑', async () => {
  const { ses, loop } = mkLoop({ script: [text('第一版回复'), text('第二版回复')] });
  const r1 = await loop.runTurn(ses, '原始问题', {});
  assert.equal(r1.ok, true);
  assert.deepEqual(store.listAgentMessages(ses).map((x) => x.role), ['user', 'assistant']);
  const userSeq = store.listAgentMessages(ses)[0].seq;
  assert.equal(store.deleteAgentMessagesFrom(ses, userSeq + 1), 1, '只丢该轮助手/工具消息（保留用户消息）');
  const r2 = await loop.runTurn(ses, '原始问题', { appendUserMessage: false });
  assert.equal(r2.ok, true);
  const rows = store.listAgentMessages(ses);
  assert.deepEqual(rows.map((x) => x.role), ['user', 'assistant'], '重跑不再落重复的用户消息');
  assert.equal(rows[0].content, '原始问题');
  assert.equal(rows[1].content, '第二版回复');
  assert.equal(rows.filter((x) => x.role === 'user').length, 1);
});
await t('resetSummaryIfBeyond：跨过截断点才清摘要（摘要正文引用被删消息）', () => {
  const ses = store.createAgentSession({ title: 'sum' });
  store.appendAgentMessage({ sessionId: ses, role: 'user', content: 'a' });
  store.appendAgentMessage({ sessionId: ses, role: 'assistant', content: 'b' });
  store.setAgentSummary(ses, { summary: '摘要', summaryUpTo: 1 });
  assert.equal(resetSummaryIfBeyond(store, ses, 2), false, '截断点在摘要覆盖之外 → 保留');
  assert.equal(store.getAgentSession(ses).summary, '摘要');
  assert.equal(resetSummaryIfBeyond(store, ses, 1), true, '截断点落在摘要覆盖内 → 清空');
  assert.equal(store.getAgentSession(ses).summary, '');
  assert.equal(store.getAgentSession(ses).summaryUpTo, 0);
  assert.equal(resetSummaryIfBeyond(store, ses, 1), false, '已清空后再调用不重复动作');
});
await t('deleteAgentMessagesFrom：含边界 seq 起全部删除、越界不误删', () => {
  const ses = store.createAgentSession({ title: 'trunc' });
  for (const role of ['user', 'assistant', 'tool', 'assistant']) store.appendAgentMessage({ sessionId: ses, role, content: role });
  assert.equal(store.deleteAgentMessagesFrom(ses, 3), 2);
  assert.deepEqual(store.listAgentMessages(ses).map((x) => x.seq), [1, 2]);
  assert.equal(store.deleteAgentMessagesFrom(ses, 99), 0);
});
await t('deleteAgentSession：会话/消息/决定三连清，且不再出现在列表', () => {
  const ses = store.createAgentSession({ title: 'del' });
  store.appendAgentMessage({ sessionId: ses, role: 'user', content: 'x' });
  store.createAgentDecision({ sessionId: ses, kind: 'write', payload: { tool: 't' } });
  assert.equal(store.deleteAgentSession(ses), true);
  assert.equal(store.getAgentSession(ses), null);
  assert.equal(store.listAgentMessages(ses).length, 0);
  assert.equal(store.listAgentDecisions(ses).length, 0);
  assert.ok(!store.listAgentSessions(100).some((s) => s.id === ses));
  assert.equal(store.deleteAgentSession(ses), false, '重复删除返回 false');
});
await t('agent-events.forget：丢弃该会话的事件历史与 revision', async () => {
  const { createAgentEvents } = await imp('agent-events.mjs');
  const bus = createAgentEvents({});
  bus.publish('s1', { type: 'x' });
  assert.equal(bus.since('s1', 0).length, 1);
  bus.forget('s1');
  assert.equal(bus.since('s1', 0).length, 0);
  assert.equal(bus.revision('s1'), 0);
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
store.close();
process.exit(fail === 0 ? 0 : 1);
