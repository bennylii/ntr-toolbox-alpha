// 助手页输入指令 e2e：@技能自动补全 + 点名注入 + /命令本地回显 + 系统指令编辑器
// 依赖：mock 在 8790（普通 worker，不带 toolcall），daemon 在 7356（--db daemon/.tmp-agent-ui2.db）
// 跑法：CDP_PORT=9335 node tools/cdp.mjs open http://127.0.0.1:7356/ui?r=… && node tools/cdp.mjs evalf tools/.e2e-agent-ui-mention.js
const out = { checks: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await pred(); if (v) return v; } catch (e) { out.errors.push(String((e && e.message) || e)); }
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
};
const btnByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text));

try {
  check('助手页已激活', !!document.getElementById('tab-agent') && document.getElementById('tab-agent').classList.contains('active'));
  check('输入指令脚本可用（AGENT_MENTION/agentCommand）', typeof AGENT_MENTION === 'object' && typeof agentCommand === 'function');

  // 1) 新会话
  const before = AGENT.session;
  document.getElementById('agent-new').click();
  const session = await waitFor(() => (AGENT.session && AGENT.session !== before ? AGENT.session : null), 8000);
  check('新建会话', !!session, session);

  // 2) @ 自动补全：输入 @gloss → 弹层出现 → 键盘选第一项
  const input = document.getElementById('agent-input');
  input.focus();
  document.execCommand('insertText', false, '@glossary-work');
  const popup = await waitFor(() => (document.getElementById('agent-mention').style.display === 'block'
    && document.querySelectorAll('#agent-mention .mi').length > 0) ? true : null, 5000);
  check('输入 @ 后弹技能候选', !!popup, document.getElementById('agent-mention').innerHTML.slice(0, 120));
  if (popup) {
    const first = document.querySelector('#agent-mention .mi.sel');
    check('候选里是 glossary-workflow', first.textContent.includes('glossary-workflow'), first.textContent);
    document.getElementById('agent-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('Enter 补全为完整技能名', /@glossary-workflow\s?$/.test(input.value) || input.value.includes('@glossary-workflow '), input.value);
  }
  document.execCommand('insertText', false, '点名测试');

  // 3) 发送 → 等终态 → mock 侧系统提示应含点名技能
  document.getElementById('agent-send').click();
  const done = await waitFor(() => {
    const msgs = AGENT.messages || [];
    return (!AGENT.running && msgs.length >= 2 && String(msgs[msgs.length - 1].content || '').length > 0) ? msgs : null;
  }, 25000);
  check('点名轮到达终态', !!done, done && done.map((m) => m.role));
  const stats = await fetch('http://127.0.0.1:8790/__stats').then((r) => r.json());
  check('mock 收到的系统提示含「用户点名技能：glossary-workflow」', String(stats.lastSystem || '').includes('用户点名技能：glossary-workflow'), String(stats.lastSystem || '').slice(0, 160));

  // 4) 系统指令编辑器：打开 → 保存 → 再发一条 → mock 系统提示含【用户系统指令】
  document.getElementById('agent-sys').click();
  const editor = await waitFor(() => (document.getElementById('agent-syseditor').style.display === 'block') ? true : null, 5000);
  check('系统指令编辑器展开', !!editor);
  document.getElementById('agent-sys-text').value = '回答要短，先结论。';
  document.getElementById('agent-sys-save').click();
  await sleep(400);
  const beforeMsgs = (AGENT.messages || []).length;
  input.focus();
  document.execCommand('insertText', false, '再来一条');
  document.getElementById('agent-send').click();
  await waitFor(() => {
    const msgs = AGENT.messages || [];
    return (!AGENT.running && msgs.length >= beforeMsgs + 2 && msgs[msgs.length - 1].role === 'assistant') ? true : null;
  }, 25000);
  const stats2 = await fetch('http://127.0.0.1:8790/__stats').then((r) => r.json());
  check('系统指令注入下一轮（mock lastSystem）', String(stats2.lastSystem || '').includes('【用户系统指令】') && String(stats2.lastSystem || '').includes('先结论'), String(stats2.lastSystem || '').slice(0, 200));
  const snap = await fetch('/agent/snapshot?session=' + encodeURIComponent(AGENT.session)).then((r) => r.json());
  check('snapshot 带回 personality', (snap.session && snap.session.personality) === '回答要短，先结论。', snap.session && snap.session.personality);
  await fetch('/agent/personality', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: AGENT.session, text: '' }) });

  // 5) /help：本地回显，不发模型
  input.focus();
  document.execCommand('insertText', false, '/help');
  document.getElementById('agent-send').click();
  const helpLine = await waitFor(() => [...document.querySelectorAll('#agent-log .msg.system')].find((x) => x.textContent.includes('命令：')) ? true : null, 5000);
  check('/help 本地回显命令表', !!helpLine);
  const beforeCount = AGENT.messages.length;
  await sleep(600);
  check('/help 不产生模型消息', AGENT.messages.length === beforeCount);
} catch (e) {
  out.errors.push(String((e && e.message) || e));
}

return JSON.stringify(out);
