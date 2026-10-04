// 助手页（/ui 的 Agent 标签）端到端：建会话 → 工具调用 → 审批面板放行 → 本地写入生效
// 依赖：mock 在 8790（?toolcall=doing,set_prompt），daemon 在 7355（--db daemon/.tmp-agent-ui.db）
// 跑法：CDP_PORT=9335 node tools/cdp.mjs open http://127.0.0.1:7355/ui && node tools/cdp.mjs evalf tools/.e2e-agent-ui.js
// 说明：mock 的脚本按「同一轮内已出现的工具结果数」推进 → 一轮里先 doing 再 set_prompt（后者需审批），最后给终答。
const out = { checks: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 25000) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await pred(); if (v) return v; } catch (e) { out.errors.push(String((e && e.message) || e)); }
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
};
const btnByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text));

try {
  check('页面加载出助手页（默认激活）', !!document.getElementById('tab-agent') && document.getElementById('tab-agent').classList.contains('active'));
  check('Agent 脚本已初始化（agentInit/AGENT 可用）', typeof agentInit === 'function' && typeof AGENT === 'object');

  // 1) 新会话
  const before = AGENT.session;
  document.getElementById('agent-new').click();
  const session = await waitFor(() => (AGENT.session && AGENT.session !== before ? AGENT.session : null), 8000);
  check('新建会话成功（sessionId 非空且已切换）', !!session, session);

  // 2) 单轮：doing → set_prompt（审批）→ 终答
  const input = document.getElementById('agent-input');
  input.value = '开始';
  document.getElementById('agent-send').click();

  const card = await waitFor(() => document.querySelector('#agent-log .agent-tool'), 20000);
  check('工具卡片渲染进对话（doing）', !!card && card.textContent.includes('doing'), card && card.textContent.slice(0, 120));

  const pending = await waitFor(() => (AGENT.pending ? AGENT.pending : null), 25000);
  check('写入工具挂起为审批（kind=write，预览含动作）', !!pending && pending.kind === 'write'
    && pending.payload && String(pending.payload.preview && pending.payload.preview.action || '').includes('设置提示词模板'), pending && pending.payload && pending.payload.preview);
  const panel = document.getElementById('agent-decision');
  check('审批面板可见且展示预览 JSON', panel.style.display !== 'none' && panel.textContent.includes('需要审批'), panel.textContent.slice(0, 140));
  const allowBtn = btnByText(panel, '允许本次');
  check('审批面板有「允许本次」按钮', !!allowBtn);
  if (allowBtn) allowBtn.click();
  else if (pending) await fetch('/agent/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pending.id, status: 'allowed', resolution: { via: 'e2e-fallback' } }) });

  const turn = await waitFor(() => {
    const msgs = AGENT.messages || [];
    const hasResult = msgs.some((m) => m.role === 'tool' && String(m.content || '').includes('"ok":true'));
    const final = msgs.length > 0 && String(msgs[msgs.length - 1].content || '').includes('完成（mock）');
    return (!AGENT.running && AGENT.pending === null && hasResult && final) ? msgs : null;
  }, 25000);
  check('放行后工具执行、一轮到达终态', !!turn, turn && turn.map((m) => m.role));
  check('审批面板已收起', document.getElementById('agent-decision').style.display === 'none');
  check('状态栏显示用量（请求 ≥ 2）', /请求 [2-9]/.test(document.getElementById('agent-status').textContent), document.getElementById('agent-status').textContent);

  // 3) 本地写入确实生效（thinking 槽），随后清理
  const prompts = await fetch('/prompts?book=').then((r) => r.json());
  const row = (prompts.rows || []).find((x) => x.slot === 'thinking' && String(x.text).includes('页面 e2e'));
  check('本地配置写入生效（thinking 槽 = 页面 e2e）', !!row, (prompts.rows || []).map((x) => x.slot + ':' + String(x.text).slice(0, 12)));
  await fetch('/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clear', bookKey: '', slot: 'thinking' }) });
  const after = await fetch('/prompts?book=').then((r) => r.json());
  check('清理完成（thinking 槽已清）', !(after.rows || []).some((x) => x.slot === 'thinking' && String(x.text).includes('页面 e2e')));
} catch (e) {
  out.errors.push(String((e && e.message) || e));
}

return JSON.stringify(out);
