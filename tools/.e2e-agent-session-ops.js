// 助手页会话操作 e2e：重命名 → 编辑用户消息重发 → 重新生成 → 删除会话
// 依赖：mock 在 8790（普通 worker，不带 toolcall），daemon 在 7358（--db daemon/.tmp-agent-ops.db）
// 前置种子（临时 db 无凭据，每次起 daemon 后推一次）：
//   curl -s -X POST http://127.0.0.1:7358/auth -H "Content-Type: application/json" \
//     -d '{"workers":[{"id":"mock","model":"mock-glossary-1","endpoint":"http://127.0.0.1:8790/v1","key":"x"}]}'
// 跑法：CDP_PORT=9334 node tools/cdp.mjs open http://127.0.0.1:7358/ui?r=… && node tools/cdp.mjs evalf tools/.e2e-agent-session-ops.js
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

try {
  // 0) 前置：默认激活助手页 + 关掉自动批准（普通回复不需要审批，这里只是保持一致）
  check('助手页默认激活', document.getElementById('tab-agent').classList.contains('active'));
  check('会话操作脚本已就绪（全局函数可用）', typeof agentRegenerate === 'function' && typeof agentRenameSession === 'function' && typeof agentDeleteSession === 'function');

  // 1) 建会话 → 发一条消息 → 等到助手回复
  document.getElementById('agent-new').click();
  await waitFor(() => AGENT.session);
  const sid = AGENT.session;
  check('新建会话成功', !!sid, sid && sid.slice(0, 8));
  const input = document.getElementById('agent-input');
  input.value = '会话操作测试：原始问题';
  document.getElementById('agent-send').click();
  const replied = await waitFor(() => (AGENT.messages || []).some((m) => m.role === 'assistant') && !AGENT.running);
  check('一轮跑完（有助手回复）', !!replied, (AGENT.messages || []).map((m) => m.role).join(','));

  // 2) 重命名：覆盖 prompt → 点顶栏「重命名」→ 标题与侧栏同步
  const realPrompt = window.prompt;
  window.prompt = () => '会话操作改名';
  document.getElementById('agent-rename').click();
  const renamed = await waitFor(() => document.getElementById('agent-title').textContent === '会话操作改名');
  check('重命名后顶栏标题更新', !!renamed, document.getElementById('agent-title').textContent);
  const rowRenamed = await waitFor(() => {
    const row = document.querySelector('#side-sessions [data-sid="' + sid + '"] .sess-name');
    return row && row.textContent === '会话操作改名' ? row.textContent : null;
  });
  check('重命名后侧栏会话行同步', !!rowRenamed, rowRenamed);
  window.prompt = realPrompt;

  // 3) 编辑用户消息重发：点「编辑」→ 改文本 → 保存并重发 → 旧内容消失、其后消息被截断
  const userRow = document.querySelector('#agent-log .msg.user');
  check('用户消息带「编辑」按钮', !!userRow && userRow.textContent.includes('编辑'), userRow && userRow.textContent.slice(0, 20));
  userRow.querySelector('.icon-btn').click();
  const ta = await waitFor(() => document.querySelector('#agent-log .edit-box textarea'));
  check('编辑态出现内联输入框', !!ta);
  ta.value = '会话操作测试：改写后的问题';
  const saveBtn = [...document.querySelectorAll('#agent-log .edit-box button')].find((b) => b.textContent.trim() === '保存并重发');
  check('编辑态有「保存并重发」按钮', !!saveBtn);
  saveBtn.click();
  const edited = await waitFor(() => {
    const users = (AGENT.messages || []).filter((m) => m.role === 'user');
    return users.length === 1 && String(users[0].content).includes('改写后的问题') && (AGENT.messages || []).some((m) => m.role === 'assistant') && !AGENT.running;
  });
  const afterEdit = (AGENT.messages || []).filter((m) => m.role === 'user').map((m) => m.content);
  check('编辑重发：用户消息只剩改写后的一条、其后消息已截断', !!edited, JSON.stringify(afterEdit));
  check('编辑重发：旧问题已不在时间线', !(AGENT.messages || []).some((m) => String(m.content).includes('原始问题')), JSON.stringify(afterEdit));

  // 4) 重新生成：末条助手消息上的按钮 → 用户消息不重复、助手回复仍在
  const sigOf = () => (AGENT.messages || []).map((m) => m.seq + ':' + m.role + ':' + String(m.content || '').length + ':' + (m.at || 0)).join('|');
  const before = (AGENT.messages || []).map((m) => m.role).join(',');
  const sig0 = sigOf();
  const redoBtn = [...document.querySelectorAll('#agent-log .msg.assistant .msg-actions button')].find((b) => b.textContent.trim() === '重新生成');
  check('末条助手消息带「重新生成」按钮', !!redoBtn, before);
  redoBtn.click();
  // 关键：要等到"时间线真的变了"（seq 会被复用，助手文本与旧回复一样，用 at 参与签名）
  const regenerated = await waitFor(() => {
    const users = (AGENT.messages || []).filter((m) => m.role === 'user');
    const assistants = (AGENT.messages || []).filter((m) => m.role === 'assistant');
    return !AGENT.running && users.length === 1 && assistants.length >= 1 && sigOf() !== sig0;
  });
  check('重新生成：用户消息未被复制、助手回复已替换', !!regenerated, (AGENT.messages || []).map((m) => m.role).join(','));
  const idle = await waitFor(() => !AGENT.running);
  check('重新生成后回到空闲（删除会话不撞在跑的轮次）', !!idle);

  // 5) 删除会话：覆盖 confirm → 点顶栏「删除」→ 会话从侧栏消失、当前会话清空
  const realConfirm = window.confirm;
  window.confirm = () => true;
  document.getElementById('agent-delete').click();
  let gone = await waitFor(() => AGENT.session === '' && !document.querySelector('#side-sessions [data-sid="' + sid + '"]'), 8000);
  if (!gone) {   // 组建抖动时补一次（daemon 侧 409 会体现在 toast 文案里）
    await sleep(600);
    document.getElementById('agent-delete').click();
    gone = await waitFor(() => AGENT.session === '' && !document.querySelector('#side-sessions [data-sid="' + sid + '"]'), 8000);
  }
  check('删除会话：选中清空且侧栏行消失', !!gone, JSON.stringify({ session: AGENT.session, toast: document.getElementById('toast').textContent }));
  const emptyHero = await waitFor(() => document.querySelector('#agent-log .empty-hero'));
  check('删除后回到空态', !!emptyHero);
  window.confirm = realConfirm;
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
