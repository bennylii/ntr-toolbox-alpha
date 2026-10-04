// daemon/ui.mjs —— 本地设置/控制台页面（零依赖单页；由 server.mjs 在 GET /ui 提供）
// 页面只做三件事：读 /status /settings /rules /prompts，写 /settings /rules /prompts /books /run。
export const UI_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NTR Daemon 控制台</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #101418; color: #e6e9ee; }
  header { padding: 12px 20px; background: #171d24; border-bottom: 1px solid #26303a; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  header .stat { color: #9fb0c0; font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 8px 20px 0; background: #171d24; border-bottom: 1px solid #26303a; flex-wrap: wrap; }
  nav button { border: 1px solid #2c3946; background: #1d252e; color: #cfd8e3; padding: 6px 14px; border-radius: 6px 6px 0 0; cursor: pointer; }
  nav button.active { background: #101418; border-bottom-color: #101418; color: #fff; }
  main { padding: 16px 20px 48px; max-width: 1100px; }
  section { display: none; }
  section.active { display: block; }
  fieldset { border: 1px solid #2c3946; border-radius: 8px; margin: 0 0 14px; padding: 10px 14px 14px; }
  legend { color: #8fd1ff; font-size: 12px; padding: 0 6px; }
  label { display: inline-flex; gap: 6px; align-items: center; margin: 4px 14px 4px 0; }
  input[type=text], input[type=number], textarea, select { background: #0d1116; color: #e6e9ee; border: 1px solid #2c3946; border-radius: 6px; padding: 5px 8px; font: inherit; }
  textarea { width: 100%; min-height: 90px; box-sizing: border-box; }
  input[type=number] { width: 90px; }
  button.act { background: #215a8f; border: 1px solid #2f6ea8; color: #fff; border-radius: 6px; padding: 5px 12px; cursor: pointer; }
  button.act.danger { background: #7a2a2a; border-color: #9c3a3a; }
  button.act.ghost { background: #1d252e; border-color: #2c3946; color: #cfd8e3; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; border-bottom: 1px solid #26303a; padding: 5px 8px; vertical-align: top; }
  th { color: #9fb0c0; font-weight: 500; }
  .muted { color: #8b98a5; font-size: 12px; }
  .ok { color: #7fd88f; } .bad { color: #ff8a8a; }
  code { background: #0d1116; padding: 1px 5px; border-radius: 4px; }
  .agent-log { max-height: 440px; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding: 6px 2px; }
  .agent-line { white-space: pre-wrap; word-break: break-word; }
  .agent-line.user { color: #9fd1ff; }
  .agent-line.assistant { color: #e6e9ee; }
  .agent-line.muted { color: #8b98a5; font-size: 12px; }
  .agent-tool { border: 1px solid #2c3946; border-radius: 6px; padding: 6px 8px; background: #131a21; font-size: 13px; }
  .agent-decision { border: 1px solid #7a5a2a; border-radius: 8px; padding: 8px 10px; margin-top: 8px; background: #1c1a14; }
  .agent-preview { max-height: 220px; overflow: auto; background: #0d1116; padding: 8px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; }
  #toast { position: fixed; right: 16px; bottom: 16px; background: #215a8f; color: #fff; padding: 8px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 60vw; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1>NTR Daemon 控制台</h1>
  <span class="stat" id="hdr"></span>
</header>
<nav>
  <button data-tab="agent" class="active">助手</button>
  <button data-tab="jobs">任务</button>
  <button data-tab="settings">设置</button>
  <button data-tab="rules">规则</button>
  <button data-tab="prompts">提示词</button>
  <button data-tab="books">书籍</button>
  <button data-tab="status">状态</button>
</nav>
<main>
  <section id="tab-jobs">
    <fieldset><legend>派发任务</legend>
      <label>书 <select id="job-book"></select></label>
      <label>任务 <select id="job-kind"><option value="translate">翻译 translate</option><option value="glossary">术语管线 glossary</option><option value="check">质检 check</option></select></label>
      <label>档位 <select id="job-level"><option value="expire">expire</option><option value="normal">normal</option><option value="all">all</option></select></label>
      <label>限章数 <input type="number" id="job-max" value="0" min="0"></label>
      <label><input type="checkbox" id="job-propose"> 质检出提案</label>
      <button class="act" id="job-run">加入队列</button>
      <div class="muted">队列串行执行；进度在下方与「状态」页可见。</div>
    </fieldset>
    <fieldset><legend>运行队列（最近 20）</legend><div id="queue"></div></fieldset>
    <fieldset><legend>最近 run（SQLite）</legend><div id="runs"></div></fieldset>
  </section>

  <section id="tab-settings">
    <fieldset><legend>调度与限流（保存后立即生效）</legend>
      <label>并发上限 maxInFlight <input type="number" id="llm-max" min="1"></label>
      <label>RPM <input type="number" id="llm-rpm" min="0"></label>
      <label>传输重试 <input type="number" id="llm-retries" min="0"></label>
      <label>提示词上限(字符) <input type="number" id="llm-prompt" min="1000"></label>
      <label><input type="checkbox" id="llm-strict"> 超限直接失败（strictPrompt）</label>
      <div><button class="act" id="settings-save">保存</button></div>
      <div class="muted">单线程 Gemini：maxInFlight=1；多 key 池在站点面板「同步 Daemon」时推送。</div>
    </fieldset>
    <fieldset><legend>站点</legend>
      <label>origin <input type="text" id="set-origin" size="40"></label>
      <button class="act ghost" id="origin-save">保存 origin</button>
      <div class="muted" id="cred"></div>
    </fieldset>
  </section>

  <section id="tab-rules">
    <fieldset><legend>预处理/后处理规则（priority 升序执行）</legend>
      <div>
        <label>kind <select id="rule-kind"><option value="post_replacement">post_replacement</option><option value="pre_replacement">pre_replacement</option><option value="text_preserve">text_preserve</option></select></label>
        <label>pattern <input type="text" id="rule-pattern" size="28"></label>
        <label>replacement <input type="text" id="rule-replacement" size="20"></label>
        <label><input type="checkbox" id="rule-regex"> 正则</label>
        <label><input type="checkbox" id="rule-cs"> 大小写敏感</label>
        <label>priority <input type="number" id="rule-priority" value="100" min="0"></label>
        <label>book <input type="text" id="rule-book" placeholder="空=全局" size="18"></label>
        <button class="act" id="rule-add">添加</button>
      </div>
      <div id="rules-table" style="margin-top:10px"></div>
    </fieldset>
  </section>

  <section id="tab-prompts">
    <fieldset><legend>提示词模板（base 必须含 {format_rules}；空槽=默认）</legend>
      <label>book <input type="text" id="prompt-book" placeholder="空=全局" size="24"></label>
      <button class="act ghost" id="prompt-load">读取</button>
      <div id="prompt-fields"></div>
      <button class="act" id="prompt-save">保存当前 book 的模板</button>
      <button class="act ghost" id="prompt-clear">清除当前 book 的模板</button>
      <div class="muted" id="prompt-hint"></div>
    </fieldset>
  </section>

  <section id="tab-books">
    <fieldset><legend>登记新书</legend>
      <label>URL <input type="text" id="book-url" size="52" placeholder="https://n.novelia.cc/novel/syosetu/nXXXXxx"></label>
      <button class="act" id="book-add">登记</button>
    </fieldset>
    <fieldset><legend>已登记</legend><div id="books-table"></div></fieldset>
  </section>

  <section id="tab-status">
    <fieldset><legend>概览</legend><div id="status-box"></div></fieldset>
  </section>
  <section id="tab-agent" class="active">
    <fieldset><legend>会话</legend>
      <label>会话 <select id="agent-sessions" style="min-width: 220px"></select></label>
      <button class="act ghost" id="agent-new">新会话</button>
      <label><input type="checkbox" id="agent-auto"> 自动批准写入（不弹确认）</label>
      <button class="act danger" id="agent-stop" disabled>停止</button>
      <div class="muted" id="agent-status"></div>
      <div class="muted" id="agent-doing"></div>
    </fieldset>
    <fieldset><legend>对话</legend>
      <div id="agent-log" class="agent-log"></div>
      <div id="agent-decision" class="agent-decision" style="display: none"></div>
      <div style="display: flex; gap: 8px; margin-top: 8px">
        <textarea id="agent-input" placeholder="输入消息（Enter 发送，Shift+Enter 换行）" style="min-height: 64px"></textarea>
        <button class="act" id="agent-send" style="align-self: flex-end">发送</button>
      </div>
      <div class="muted">助手可读书目/正文/译文/质检，执行翻译与术语管线，写术语表/回滚/改规则前会请求审批。</div>
    </fieldset>
  </section>
</main>
<div id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
const api = async (path, options) => {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch (e) { data = { ok: false, error: 'HTTP ' + res.status }; }
  if (!res.ok || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
};
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const toast = (msg, bad) => {
  const el = $('toast');
  el.textContent = msg;
  el.style.background = bad ? '#7a2a2a' : '#215a8f';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

document.querySelectorAll('nav button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + btn.dataset.tab));
  if (btn.dataset.tab === 'agent') { agentInit(); return; }
  refresh();
}));

let STATE = { books: [] };
async function refresh() {
  try {
    const status = await api('/status');
    STATE.books = status.books || [];
    const q = status.queue || [];
    $('hdr').textContent = '队列 ' + q.filter((x) => x.state === 'running' || x.state === 'queued').length +
      ' · 在途 ' + ((status.llm && status.llm.inFlightNow) || 0) + '/' + ((status.llm && status.llm.maxInFlight) || '?') +
      ' · workers ' + ((status.llm && status.llm.workers) || 0) +
      ' · 用量 ' + ((status.usage && status.usage.requests) || 0) + ' req / ' + ((status.usage && (status.usage.promptTokens + status.usage.completionTokens)) || 0) + ' tok';
    renderJobs(status);
    renderStatus(status);
    renderBooks();
  } catch (e) { $('hdr').textContent = 'daemon 不可达：' + e.message; }
}
function renderJobs(status) {
  $('job-book').innerHTML = STATE.books.map((b) => '<option value="' + esc(b.key) + '">' + esc(b.key) + '</option>').join('');
  $('queue').innerHTML = (status.queue || []).slice().reverse().map((x) =>
    '<div>' + esc(x.job) + ' · ' + esc(x.bookKey) + ' · <b>' + esc(x.state) + '</b>' +
    (x.stats ? ' · ' + esc(JSON.stringify(x.stats).slice(0, 160)) : '') +
    (x.error ? ' · <span class="bad">' + esc(x.error) + '</span>' : '') + '</div>').join('') || '<span class="muted">空</span>';
  $('runs').innerHTML = '<table><tr><th>id</th><th>job</th><th>book</th><th>state</th><th>stats</th></tr>' +
    (status.runs || []).map((r) => '<tr><td>' + r.id + '</td><td>' + esc(r.job) + '</td><td>' + esc(r.bookKey) + '</td><td>' + esc(r.state) + '</td><td class="muted">' + esc(JSON.stringify(r.stats || {}).slice(0, 200)) + '</td></tr>').join('') + '</table>';
}
function renderStatus(status) {
  const m = (status.metrics || []).slice(-3).map((x) => 'rss ' + x.rss.toFixed(1) + 'MB').join(' / ');
  $('status-box').innerHTML =
    '<div>llm：' + esc(JSON.stringify(status.llm || {})) + '</div>' +
    '<div>usage：' + esc(JSON.stringify(status.usage || {})) + '</div>' +
    '<div>metrics：' + esc(m) + '</div>';
}
function renderBooks() {
  $('books-table').innerHTML = '<table><tr><th>key</th><th>state</th><th>title</th><th>已译章</th><th></th></tr>' +
    STATE.books.map((b) => '<tr><td>' + esc(b.key) + '</td><td>' + esc(b.state) + '</td><td>' + esc(b.title) + '</td><td>' + b.progress + '</td>' +
      '<td><button class="act danger" data-forget="' + esc(b.key) + '">忘记</button></td></tr>').join('') + '</table>';
  document.querySelectorAll('[data-forget]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('从本地 daemon 忘记 ' + btn.dataset.forget + '？（站点数据不动）')) return;
    try { await post('/books', { action: 'forget', key: btn.dataset.forget }); toast('已忘记'); refresh(); } catch (e) { toast(e.message, true); }
  }));
}

async function loadSettings() {
  try {
    const s = await api('/settings');
    const llm = (s.settings && s.settings.llm) || {};
    $('llm-max').value = llm.maxInFlight != null ? llm.maxInFlight : 1;
    $('llm-rpm').value = llm.rpm || 0;
    $('llm-retries').value = llm.transportRetries != null ? llm.transportRetries : 3;
    $('llm-prompt').value = llm.maxPromptChars || 12000;
    $('llm-strict').checked = llm.strictPrompt === true;
    $('set-origin').value = (s.settings && s.settings.origin) || '';
    $('cred').textContent = 'token：' + (s.settings.tokenSet ? '已同步' : '未同步（站点页面点「同步 Daemon」）') +
      '；workers：' + ((s.settings.workers || []).map((w) => (w.id || '?') + '/' + (w.model || '?')).join('、') || '无');
  } catch (e) { toast(e.message, true); }
}
$('settings-save').addEventListener('click', async () => {
  try {
    await post('/settings', { llm: {
      maxInFlight: Number($('llm-max').value) || 1,
      rpm: Number($('llm-rpm').value) || 0,
      transportRetries: Number($('llm-retries').value) || 0,
      maxPromptChars: Number($('llm-prompt').value) || 12000,
      strictPrompt: $('llm-strict').checked,
    } });
    toast('设置已保存并生效'); loadSettings();
  } catch (e) { toast(e.message, true); }
});
$('origin-save').addEventListener('click', async () => {
  try { await post('/settings', { origin: $('set-origin').value.trim() }); toast('origin 已保存'); } catch (e) { toast(e.message, true); }
});

async function loadRules() {
  try {
    const data = await api('/rules');
    $('rules-table').innerHTML = '<table><tr><th>id</th><th>on</th><th>kind</th><th>pattern</th><th>replacement</th><th>re/cs</th><th>prio</th><th>book</th><th></th></tr>' +
      (data.rules || []).map((r) => '<tr><td>' + r.id + '</td><td>' + (r.enabled ? '<span class="ok">✓</span>' : '—') + '</td><td>' + esc(r.kind) + '</td><td><code>' + esc(r.pattern) + '</code></td><td>' + esc(r.replacement) + '</td><td>' + (r.regex ? 're ' : '') + (r.case_sensitive ? 'cs' : '') + '</td><td>' + r.priority + '</td><td>' + esc(r.bookKey || '全局') + '</td>' +
        '<td><button class="act ghost" data-toggle="' + r.id + '" data-on="' + (r.enabled ? 1 : 0) + '">' + (r.enabled ? '禁用' : '启用') + '</button> ' +
        '<button class="act danger" data-del="' + r.id + '">删除</button></td></tr>').join('') + '</table>';
    document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      try { await post('/rules', { action: 'toggle', id: Number(b.dataset.toggle), enabled: b.dataset.on !== '1' }); loadRules(); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      try { await post('/rules', { action: 'delete', id: Number(b.dataset.del) }); loadRules(); } catch (e) { toast(e.message, true); }
    }));
  } catch (e) { toast(e.message, true); }
}
$('rule-add').addEventListener('click', async () => {
  try {
    await post('/rules', {
      action: 'add', kind: $('rule-kind').value, pattern: $('rule-pattern').value,
      replacement: $('rule-replacement').value, regex: $('rule-regex').checked,
      case_sensitive: $('rule-cs').checked, priority: Number($('rule-priority').value) || 100,
      bookKey: $('rule-book').value.trim(),
    });
    $('rule-pattern').value = ''; $('rule-replacement').value = '';
    toast('规则已添加'); loadRules();
  } catch (e) { toast(e.message, true); }
});

let PROMPT_DEFAULTS = {};
async function loadPrompts() {
  try {
    const book = $('prompt-book').value.trim();
    const data = await api('/prompts?book=' + encodeURIComponent(book));
    PROMPT_DEFAULTS = data.defaults || {};
    $('prompt-hint').textContent = '协议段（代码注入，不可覆盖）：' + (data.formatRules || '') +
      '；默认模板渲染与站点镜像提示逐字一致。';
    const rows = new Map((data.rows || []).filter((r) => (r.bookKey || '') === book).map((r) => [r.slot, r.text]));
    $('prompt-fields').innerHTML = ['prefix', 'base', 'thinking', 'suffix'].map((slot) =>
      '<div><b>' + slot + '</b>' + (rows.has(slot) ? '' : ' <span class="muted">（默认）</span>') +
      '<textarea id="prompt-' + slot + '" placeholder="' + esc(String(PROMPT_DEFAULTS[slot] || '').slice(0, 120)) + '">' + esc(rows.get(slot) || '') + '</textarea></div>').join('');
  } catch (e) { toast(e.message, true); }
}
$('prompt-load').addEventListener('click', loadPrompts);
$('prompt-save').addEventListener('click', async () => {
  try {
    const book = $('prompt-book').value.trim();
    for (const slot of ['prefix', 'base', 'thinking', 'suffix']) {
      const text = $('prompt-' + slot).value;
      if (text.trim() === '') await post('/prompts', { action: 'clear', bookKey: book, slot });
      else await post('/prompts', { bookKey: book, slot, text });
    }
    toast('模板已保存'); loadPrompts();
  } catch (e) { toast(e.message, true); }
});
$('prompt-clear').addEventListener('click', async () => {
  try {
    await post('/prompts', { action: 'clear-all', bookKey: $('prompt-book').value.trim() });
    toast('已清除该 book 的模板'); loadPrompts();
  } catch (e) { toast(e.message, true); }
});

$('book-add').addEventListener('click', async () => {
  try { await post('/books', { action: 'add', url: $('book-url').value.trim() }); $('book-url').value = ''; toast('已登记'); refresh(); }
  catch (e) { toast(e.message, true); }
});

$('job-run').addEventListener('click', async () => {
  try {
    const kind = $('job-kind').value;
    const body = { bookKey: $('job-book').value, job: kind };
    if (kind === 'translate') { body.level = $('job-level').value; body.options = { maxChapters: Number($('job-max').value) || 0 }; }
    if (kind === 'check') body.options = { propose: $('job-propose').checked };
    const r = await post('/run', body);
    toast('已入队 #' + r.id); refresh();
  } catch (e) { toast(e.message, true); }
});

// ---------------- 助手（Agent） ----------------
let AGENT = { session: localStorage.getItem('ntr-daemon-agent-session') || '', es: null, polling: null, messages: [], pending: null, running: false, usage: null, transport: '' };
function agentLine(text, cls) { const d = document.createElement('div'); d.className = 'agent-line ' + (cls || ''); d.textContent = text; return d; }
function renderAgentMessages() {
  const box = $('agent-log');
  box.innerHTML = '';
  for (const m of AGENT.messages) {
    if (m.role === 'user') { box.appendChild(agentLine('你：' + m.content, 'user')); continue; }
    if (m.role === 'assistant') {
      if (m.content) box.appendChild(agentLine('助手：' + m.content, 'assistant'));
      (m.toolCalls || []).forEach(function (tc) {
        const card = document.createElement('div'); card.className = 'agent-tool';
        card.textContent = '工具：' + tc.name + ' ' + JSON.stringify(tc.args || {});
        const result = AGENT.messages.find(function (x) { return x.role === 'tool' && x.toolCallId === tc.id; });
        const r = document.createElement('div'); r.className = 'muted';
        r.textContent = result ? ('结果：' + String(result.content || '').slice(0, 300)) : '（等待结果…）';
        card.appendChild(r); box.appendChild(card);
      });
      continue;
    }
    if (m.role === 'tool') {
      const known = AGENT.messages.some(function (x) { return x.role === 'assistant' && (x.toolCalls || []).some(function (tc) { return tc.id === m.toolCallId; }); });
      if (!known) box.appendChild(agentLine('工具结果：' + String(m.content || '').slice(0, 200), 'muted'));
    }
  }
  box.scrollTop = box.scrollHeight;
}
function renderAgentDecision() {
  const panel = $('agent-decision');
  const d = AGENT.pending;
  if (!d) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
  panel.style.display = 'block';
  panel.innerHTML = '';
  panel.appendChild(agentLine(d.kind === 'write' ? '需要审批' : '需要回答', 'assistant'));
  const body = document.createElement('pre'); body.className = 'agent-preview';
  body.textContent = JSON.stringify(d.payload, null, 2);
  panel.appendChild(body);
  const row = document.createElement('div');
  if (d.kind === 'question') {
    ((d.payload && d.payload.options) || []).forEach(function (o) {
      const b = document.createElement('button'); b.className = 'act'; b.textContent = o.label || o.id;
      b.addEventListener('click', function () { agentResolve(d.id, 'allowed', { selected: o.id }); });
      row.appendChild(b);
    });
    const custom = document.createElement('input'); custom.type = 'text'; custom.placeholder = '或直接输入回答';
    const sendCustom = document.createElement('button'); sendCustom.className = 'act ghost'; sendCustom.textContent = '回答';
    sendCustom.addEventListener('click', function () { if (custom.value.trim() !== '') agentResolve(d.id, 'allowed', { custom: custom.value.trim() }); });
    row.appendChild(custom); row.appendChild(sendCustom);
  } else {
    const allow = document.createElement('button'); allow.className = 'act'; allow.textContent = '允许本次';
    allow.addEventListener('click', function () { agentResolve(d.id, 'allowed', { via: 'ui' }); });
    const reject = document.createElement('button'); reject.className = 'act danger'; reject.textContent = '拒绝';
    reject.addEventListener('click', function () { agentResolve(d.id, 'rejected', { via: 'ui' }); });
    row.appendChild(allow); row.appendChild(reject);
  }
  panel.appendChild(row);
}
async function agentResolve(id, status, resolution) {
  try { await post('/agent/decision', { id: id, status: status, resolution: resolution || null }); toast(status === 'allowed' ? '已允许' : '已拒绝'); }
  catch (e) { toast(e.message, true); }
  agentRefresh();
}
function renderAgentStatus() {
  $('agent-status').textContent = (AGENT.running ? '进行中…' : '空闲') +
    ' · 会话 ' + (AGENT.session ? AGENT.session.slice(0, 8) : '—') +
    ' · 请求 ' + (AGENT.usage ? AGENT.usage.requests : 0) +
    ' · tokens ' + (AGENT.usage ? (AGENT.usage.promptTokens + AGENT.usage.completionTokens) : 0) +
    (AGENT.transport ? ' · ' + AGENT.transport : '');
}
async function agentSnapshot() {
  if (!AGENT.session) return;
  const data = await api('/agent/snapshot?session=' + encodeURIComponent(AGENT.session));
  AGENT.messages = data.messages || [];
  AGENT.pending = data.pendingDecision || null;
  AGENT.running = !!data.running;
  AGENT.usage = data.usage || null;
  AGENT.transport = '在线';
  renderAgentMessages(); renderAgentDecision(); renderAgentStatus();
  $('agent-send').disabled = AGENT.running;
  $('agent-stop').disabled = !AGENT.running;
}
async function agentRefresh() { try { await agentSnapshot(); } catch (e) { AGENT.transport = '离线：' + e.message; renderAgentStatus(); } }
function agentSetSession(id) {
  AGENT.session = id || '';
  if (id) localStorage.setItem('ntr-daemon-agent-session', id); else localStorage.removeItem('ntr-daemon-agent-session');
  AGENT.messages = []; AGENT.pending = null;
  if (AGENT.es) { AGENT.es.close(); AGENT.es = null; }
  if (AGENT.polling) { clearInterval(AGENT.polling); AGENT.polling = null; }
  if (id) { agentOpenStream(); agentRefresh(); }
}
function agentOpenStream() {
  if (!AGENT.session || typeof EventSource === 'undefined') { agentStartPolling(); return; }
  try {
    const es = new EventSource('/agent/events?session=' + encodeURIComponent(AGENT.session) + '&since=0');
    AGENT.es = es;
    es.onmessage = function (e) {
      let ev = null; try { ev = JSON.parse(e.data); } catch (err) { return; }
      if (ev.type === 'doing') { $('agent-doing').textContent = '进度：' + (ev.text || ''); }
      if (['user_message', 'assistant_message', 'tool_result', 'turn_end', 'decision', 'decision_resolved', 'question', 'error'].indexOf(ev.type) >= 0) agentRefresh();
    };
    es.onerror = function () { try { es.close(); } catch (err) { } AGENT.es = null; agentStartPolling(); };
  } catch (e) { agentStartPolling(); }
}
function agentStartPolling() {
  if (AGENT.polling) return;
  AGENT.polling = setInterval(agentRefresh, 1500);
  agentRefresh();
}
function renderAgentSessions(list) {
  const sel = $('agent-sessions');
  sel.innerHTML = (list || []).map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(String(x.title || x.id).slice(0, 30)) + (x.running ? '（进行中）' : '') + '</option>'; }).join('');
  if (AGENT.session) sel.value = AGENT.session;
}
async function agentInit() {
  try {
    const cfg = await api('/agent/config');
    $('agent-auto').checked = cfg.approvalMode === 'auto';
    const list = cfg.sessions || [];
    renderAgentSessions(list);
    if (AGENT.session && !list.some(function (x) { return x.id === AGENT.session; })) {
      AGENT.transport = '会话已不存在，请新建';
      agentSetSession('');
      renderAgentStatus();
      return;
    }
    if (!AGENT.session) { AGENT.transport = '没有会话：点「新会话」开始'; renderAgentStatus(); return; }
    agentRefresh();
  } catch (e) { toast(e.message, true); }
}
$('agent-new').addEventListener('click', async function () {
  try { const r = await post('/agent/session', { title: '新会话' }); agentSetSession(r.sessionId); agentInit(); }
  catch (e) { toast(e.message, true); }
});
$('agent-sessions').addEventListener('change', function () { agentSetSession($('agent-sessions').value); });
$('agent-auto').addEventListener('change', async function () {
  try { await post('/agent/config', { approvalMode: $('agent-auto').checked ? 'auto' : 'manual' }); toast('审批模式已更新'); } catch (e) { toast(e.message, true); }
});
$('agent-stop').addEventListener('click', async function () {
  try { await post('/agent/stop', { session: AGENT.session }); toast('已请求停止'); agentRefresh(); } catch (e) { toast(e.message, true); }
});
async function agentSend() {
  const input = $('agent-input');
  const text = input.value.trim();
  if (text === '') return;
  input.value = '';
  try {
    if (!AGENT.session) { const r = await post('/agent/session', { title: text.slice(0, 30) }); agentSetSession(r.sessionId); }
    await post('/agent/message', { session: AGENT.session, message: text, approvalMode: $('agent-auto').checked ? 'auto' : 'manual' });
    $('agent-doing').textContent = '';
    agentRefresh();
  } catch (e) { toast(e.message, true); }
}
$('agent-send').addEventListener('click', agentSend);
$('agent-input').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); } });
setInterval(function () { if (document.getElementById('tab-agent').classList.contains('active') && AGENT.session && !AGENT.polling) agentRefresh(); }, 4000);

refresh(); loadSettings(); loadRules(); loadPrompts();
agentInit();
setInterval(() => { if ($('tab-jobs').classList.contains('active') || $('tab-status').classList.contains('active')) refresh(); }, 4000);
</script>
</body>
</html>`;
