// daemon/ui.mjs —— 本地控制台（零依赖单页，OpenWebUI 风格：左侧栏 + 居中对话 + 底部输入）
// server.mjs 在 GET /ui 提供本页；页面只调 daemon 的 HTTP 接口。
export const UI_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NTR Daemon 控制台</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #101014; --bg2: #16161b; --panel: #1b1b21; --panel2: #22222a;
    --border: #2a2a32; --border2: #35353f;
    --text: #e8e8ec; --muted: #9a9aa5; --accent: #6d9bf5; --accent2: #3f6ad8;
    --ok: #7fd88f; --bad: #ff8a8a; --warn: #e8c46a;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 14px/1.65 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); }
  .app { display: flex; height: 100vh; overflow: hidden; }

  .side { width: 250px; min-width: 250px; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; font-weight: 600; letter-spacing: .3px; }
  .brand .logo { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, var(--accent), #9a6df0); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; color: #fff; }
  .side nav { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; }
  .side nav button { all: unset; cursor: pointer; padding: 8px 12px; border-radius: 10px; color: var(--muted); font-size: 13.5px; display: flex; align-items: center; gap: 9px; }
  .side nav button:hover { background: var(--panel2); color: var(--text); }
  .side nav button.active { background: var(--panel2); color: var(--text); }
  .side nav button .ico { width: 18px; text-align: center; }
  .side .divider { height: 1px; background: var(--border); margin: 10px 14px; }
  .side .side-title { padding: 2px 16px 6px; font-size: 11px; color: var(--muted); letter-spacing: .8px; }
  #side-sessions { flex: 1; overflow-y: auto; padding: 0 10px 8px; }
  .sess-row { all: unset; cursor: pointer; display: block; padding: 7px 12px; border-radius: 10px; font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sess-row:hover { background: var(--panel2); color: var(--text); }
  .sess-row.active { background: var(--panel2); color: var(--text); }
  .side-foot { padding: 10px 14px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--muted); }

  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .topbar { display: flex; align-items: center; gap: 14px; padding: 10px 20px; border-bottom: 1px solid var(--border); background: var(--bg2); }
  .topbar h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .topbar .hdr { margin-left: auto; font-size: 12px; color: var(--muted); }
  .content { flex: 1; overflow-y: auto; padding: 18px 22px 60px; }
  .page { max-width: 920px; margin: 0 auto; display: none; }
  .page.active { display: block; }

  fieldset { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); margin: 0 0 14px; padding: 12px 16px 16px; }
  legend { color: var(--muted); font-size: 12px; padding: 0 6px; }
  label { display: inline-flex; gap: 6px; align-items: center; margin: 4px 14px 4px 0; color: var(--text); }
  input[type=text], input[type=number], textarea, select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; font: inherit; }
  input[type=number] { width: 96px; }
  textarea { width: 100%; min-height: 90px; box-sizing: border-box; }
  .btn { background: var(--accent2); border: 1px solid var(--accent); color: #fff; border-radius: 10px; padding: 6px 14px; cursor: pointer; font: inherit; }
  .btn:hover { filter: brightness(1.12); }
  .btn.ghost { background: var(--panel2); border-color: var(--border); color: var(--text); }
  .btn.danger { background: #6e2727; border-color: #8c3a3a; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; border-bottom: 1px solid var(--border); padding: 6px 8px; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  .muted { color: var(--muted); font-size: 12px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  code { background: var(--bg); padding: 1px 5px; border-radius: 5px; }
  pre { font-family: ui-monospace, Consolas, monospace; }

  /* 助手页（OpenWebUI 风对话） */
  .agent-page { max-width: 860px; margin: 0 auto; display: none; flex-direction: column; height: calc(100vh - 61px); padding: 0 0 0; }
  .agent-page.active { display: flex; }
  .agent-top { display: flex; align-items: center; gap: 10px; padding: 12px 4px 10px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .agent-top .spacer { flex: 1; }
  .chat { flex: 1; overflow-y: auto; padding: 18px 6px 12px; display: flex; flex-direction: column; gap: 14px; }
  .chat .empty { color: var(--muted); text-align: center; margin-top: 40px; font-size: 13px; }
  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .msg.user .bubble { background: #2b3546; border-radius: 16px 16px 4px 16px; padding: 9px 14px; max-width: 78%; white-space: pre-wrap; word-break: break-word; }
  .msg.assistant { flex-direction: column; gap: 8px; }
  .msg.assistant .who { font-size: 12px; color: var(--muted); }
  .msg.assistant .content { white-space: pre-wrap; word-break: break-word; }
  .msg.system { color: var(--muted); font-size: 12px; }
  .tool { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); margin: 2px 0; overflow: hidden; }
  .tool summary { cursor: pointer; padding: 7px 12px; font-size: 13px; color: var(--muted); list-style: none; }
  .tool summary::before { content: '▸ '; }
  .tool[open] summary::before { content: '▾ '; }
  .tool .tool-body { margin: 0; padding: 8px 12px 10px; border-top: 1px solid var(--border); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; color: var(--muted); max-height: 240px; overflow: auto; }
  .doing { min-height: 18px; font-size: 12px; color: var(--warn); padding: 0 6px; }
  .decision { border: 1px solid #6e5a2a; border-radius: var(--radius); background: #1d1a12; padding: 12px 14px; margin: 8px 0; }
  .decision .d-title { font-weight: 600; margin-bottom: 6px; }
  .decision pre { max-height: 220px; overflow: auto; background: var(--bg); border-radius: 8px; padding: 8px 10px; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--muted); margin: 6px 0; }
  .decision .d-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .decision input[type=text] { flex: 1; min-width: 160px; }
  .composer { border-top: 1px solid var(--border); padding: 12px 4px 6px; display: flex; gap: 10px; align-items: flex-end; }
  .composer textarea { flex: 1; resize: vertical; min-height: 56px; max-height: 200px; border-radius: 14px; padding: 10px 14px; }
  .composer .btn { height: 42px; padding: 0 18px; }

  #toast { position: fixed; right: 16px; bottom: 16px; background: var(--accent2); color: #fff; padding: 8px 14px; border-radius: 10px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 60vw; z-index: 9; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><span class="logo">◆</span> NTR Daemon</div>
    <nav id="side-nav">
      <button data-tab="agent" class="active"><span class="ico">💬</span>助手</button>
      <button data-tab="jobs"><span class="ico">🚚</span>任务</button>
      <button data-tab="settings"><span class="ico">⚙️</span>设置</button>
      <button data-tab="rules"><span class="ico">📏</span>规则</button>
      <button data-tab="prompts"><span class="ico">📝</span>提示词</button>
      <button data-tab="books"><span class="ico">📚</span>书籍</button>
      <button data-tab="status"><span class="ico">📊</span>状态</button>
    </nav>
    <div class="divider"></div>
    <div class="side-title">助手会话</div>
    <div id="side-sessions"></div>
    <div class="side-foot" id="side-status"></div>
  </aside>
  <div class="main">
    <header class="topbar">
      <h1 id="page-title">助手</h1>
      <div class="hdr" id="hdr"></div>
    </header>
    <div class="content">

  <div class="page agent-page active" id="tab-agent" data-title="助手">
    <div class="agent-top">
      <button class="btn ghost" id="agent-new">＋ 新会话</button>
      <label><input type="checkbox" id="agent-auto"> 自动批准写入</label>
      <span class="spacer"></span>
      <span class="muted" id="agent-status"></span>
      <button class="btn danger" id="agent-stop" disabled>停止</button>
    </div>
    <div id="agent-log" class="chat"></div>
    <div id="agent-decision" class="decision" style="display: none"></div>
    <div id="agent-doing" class="doing"></div>
    <div class="composer">
      <textarea id="agent-input" placeholder="给助手发消息（Enter 发送，Shift+Enter 换行）"></textarea>
      <button class="btn primary" id="agent-send">发送</button>
    </div>
  </div>

  <div class="page" id="tab-jobs" data-title="任务">
    <fieldset><legend>派发任务</legend>
      <label>书 <select id="job-book"></select></label>
      <label>任务 <select id="job-kind"><option value="translate">翻译 translate</option><option value="glossary">术语管线 glossary</option><option value="check">质检 check</option></select></label>
      <label>档位 <select id="job-level"><option value="expire">expire</option><option value="normal">normal</option><option value="all">all</option></select></label>
      <label>限章数 <input type="number" id="job-max" value="0" min="0"></label>
      <label><input type="checkbox" id="job-propose"> 质检出提案</label>
      <button class="btn" id="job-run">加入队列</button>
      <div class="muted">队列串行执行；进度在下方与「状态」页可见。</div>
    </fieldset>
    <fieldset><legend>运行队列（最近 20）</legend><div id="queue"></div></fieldset>
    <fieldset><legend>最近 run（SQLite）</legend><div id="runs"></div></fieldset>
  </div>

  <div class="page" id="tab-settings" data-title="设置">
    <fieldset><legend>调度与限流（保存后立即生效）</legend>
      <label>并发上限 maxInFlight <input type="number" id="llm-max" min="1"></label>
      <label>RPM <input type="number" id="llm-rpm" min="0"></label>
      <label>传输重试 <input type="number" id="llm-retries" min="0"></label>
      <label>提示词上限(字符) <input type="number" id="llm-prompt" min="1000"></label>
      <label><input type="checkbox" id="llm-strict"> 超限直接失败（strictPrompt）</label>
      <div><button class="btn" id="settings-save">保存</button></div>
      <div class="muted">单线程 Gemini：maxInFlight=1；多 key 池在站点面板「同步 Daemon」时推送。</div>
    </fieldset>
    <fieldset><legend>助手上下文预算（逆向 Gemini 等 16K 模型：建议 12000 / 8000 / 8）</legend>
      <label>上下文上限 <input type="number" id="ag-ctx" min="1024"></label>
      <label>压缩阈值 <input type="number" id="ag-compact" min="1024"></label>
      <label>保留最近消息 <input type="number" id="ag-keep" min="2"></label>
      <div><button class="btn" id="agent-budget-save">保存助手预算</button></div>
      <div class="muted">超阈值时旧对话摘要压缩；助手默认走与管线相同的模型池。</div>
    </fieldset>
    <fieldset><legend>站点</legend>
      <label>origin <input type="text" id="set-origin" size="40"></label>
      <button class="btn ghost" id="origin-save">保存 origin</button>
      <div class="muted" id="cred"></div>
    </fieldset>
  </div>

  <div class="page" id="tab-rules" data-title="规则">
    <fieldset><legend>预处理/后处理规则（priority 升序执行）</legend>
      <div>
        <label>kind <select id="rule-kind"><option value="post_replacement">post_replacement</option><option value="pre_replacement">pre_replacement</option><option value="text_preserve">text_preserve</option></select></label>
        <label>pattern <input type="text" id="rule-pattern" size="28"></label>
        <label>replacement <input type="text" id="rule-replacement" size="20"></label>
        <label><input type="checkbox" id="rule-regex"> 正则</label>
        <label><input type="checkbox" id="rule-cs"> 大小写敏感</label>
        <label>priority <input type="number" id="rule-priority" value="100" min="0"></label>
        <label>book <input type="text" id="rule-book" placeholder="空=全局" size="18"></label>
        <button class="btn" id="rule-add">添加</button>
      </div>
      <div id="rules-table" style="margin-top:10px"></div>
    </fieldset>
  </div>

  <div class="page" id="tab-prompts" data-title="提示词">
    <fieldset><legend>提示词模板（base 必须含 {format_rules}；空槽=默认）</legend>
      <label>book <input type="text" id="prompt-book" placeholder="空=全局" size="24"></label>
      <button class="btn ghost" id="prompt-load">读取</button>
      <div id="prompt-fields"></div>
      <button class="btn" id="prompt-save">保存当前 book 的模板</button>
      <button class="btn ghost" id="prompt-clear">清除当前 book 的模板</button>
      <div class="muted" id="prompt-hint"></div>
    </fieldset>
  </div>

  <div class="page" id="tab-books" data-title="书籍">
    <fieldset><legend>登记新书</legend>
      <label>URL <input type="text" id="book-url" size="52" placeholder="https://n.novelia.cc/novel/syosetu/nXXXXxx"></label>
      <button class="btn" id="book-add">登记</button>
    </fieldset>
    <fieldset><legend>已登记</legend><div id="books-table"></div></fieldset>
  </div>

  <div class="page" id="tab-status" data-title="状态">
    <fieldset><legend>概览</legend><div id="status-box"></div></fieldset>
  </div>

    </div>
  </div>
</div>
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
  el.style.background = bad ? '#6e2727' : '#3f6ad8';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

document.querySelectorAll('#side-nav button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('#side-nav button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.page').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + btn.dataset.tab));
  $('page-title').textContent = btn.dataset.title || btn.textContent.trim();
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
    $('side-status').textContent = '队列 ' + q.filter((x) => x.state !== 'done' && x.state !== 'failed').length +
      ' · 在途 ' + ((status.llm && status.llm.inFlightNow) || 0) +
      ' · RSS ' + ((status.metrics || []).length ? (status.metrics[status.metrics.length - 1].rss || 0).toFixed(0) + 'MB' : '—');
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
      '<td><button class="btn danger" data-forget="' + esc(b.key) + '">忘记</button></td></tr>').join('') + '</table>';
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
    const agent = (s.settings && s.settings.agent) || {};
    $('ag-ctx').value = agent.maxContextTokens || 200000;
    $('ag-compact').value = agent.compactThresholdTokens || 120000;
    $('ag-keep').value = agent.keepRecentMessages || 12;
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
$('agent-budget-save').addEventListener('click', async () => {
  try {
    await post('/settings', { agent: {
      maxContextTokens: Number($('ag-ctx').value) || 200000,
      compactThresholdTokens: Number($('ag-compact').value) || 120000,
      keepRecentMessages: Number($('ag-keep').value) || 12,
    } });
    toast('助手预算已保存并生效');
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
        '<td><button class="btn ghost" data-toggle="' + r.id + '" data-on="' + (r.enabled ? 1 : 0) + '">' + (r.enabled ? '禁用' : '启用') + '</button> ' +
        '<button class="btn danger" data-del="' + r.id + '">删除</button></td></tr>').join('') + '</table>';
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
    $('prompt-hint').textContent = '协议段（代码注入，不可覆盖）：' + (data.formatRules || '') + '；默认模板渲染与站点镜像提示逐字一致。';
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
let lastSessions = [];
function agentLine(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }
function renderAgentMessages() {
  const box = $('agent-log');
  box.innerHTML = '';
  if ((AGENT.messages || []).length === 0) box.appendChild(agentLine('empty', '还没有消息。让助手去查书、跑质检或整理术语表。'));
  for (const m of AGENT.messages || []) {
    if (m.role === 'user') {
      const row = document.createElement('div'); row.className = 'msg user';
      const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.content || '';
      row.appendChild(b); box.appendChild(row); continue;
    }
    if (m.role === 'assistant') {
      const row = document.createElement('div'); row.className = 'msg assistant';
      if (m.content) { const c = document.createElement('div'); c.className = 'content'; c.textContent = m.content; row.appendChild(c); }
      (m.toolCalls || []).forEach(function (tc) {
        const result = (AGENT.messages || []).find(function (x) { return x.role === 'tool' && x.toolCallId === tc.id; });
        const okFlag = result ? /"ok":true/.test(String(result.content || '')) : false;
        const card = document.createElement('details'); card.className = 'tool';
        const summary = document.createElement('summary');
        summary.textContent = '🛠 ' + tc.name + '  ' + (result ? (okFlag ? '✓ 完成' : '⚠ 有异常') : '… 执行中');
        card.appendChild(summary);
        const pre = document.createElement('pre'); pre.className = 'tool-body';
        pre.textContent = '参数：' + JSON.stringify(tc.args || {}) + (result ? '\n结果：' + String(result.content || '').slice(0, 1200) : '');
        card.appendChild(pre); row.appendChild(card);
      });
      if (m.content || (m.toolCalls || []).length) box.appendChild(row);
      continue;
    }
    if (m.role === 'tool') {
      const known = (AGENT.messages || []).some(function (x) { return x.role === 'assistant' && (x.toolCalls || []).some(function (tc) { return tc.id === m.toolCallId; }); });
      if (!known) box.appendChild(agentLine('msg system', '工具结果：' + String(m.content || '').slice(0, 200)));
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
  panel.appendChild(agentLine('d-title', d.kind === 'write' ? '需要审批' : '需要回答'));
  const body = document.createElement('pre');
  body.textContent = JSON.stringify(d.payload, null, 2);
  panel.appendChild(body);
  const row = document.createElement('div'); row.className = 'd-row';
  if (d.kind === 'question') {
    ((d.payload && d.payload.options) || []).forEach(function (o) {
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = o.label || o.id;
      b.addEventListener('click', function () { agentResolve(d.id, 'allowed', { selected: o.id }); });
      row.appendChild(b);
    });
    const custom = document.createElement('input'); custom.type = 'text'; custom.placeholder = '或直接输入回答';
    const sendCustom = document.createElement('button'); sendCustom.className = 'btn ghost'; sendCustom.textContent = '回答';
    sendCustom.addEventListener('click', function () { if (custom.value.trim() !== '') agentResolve(d.id, 'allowed', { custom: custom.value.trim() }); });
    row.appendChild(custom); row.appendChild(sendCustom);
  } else {
    const allow = document.createElement('button'); allow.className = 'btn'; allow.textContent = '允许本次';
    allow.addEventListener('click', function () { agentResolve(d.id, 'allowed', { via: 'ui' }); });
    const reject = document.createElement('button'); reject.className = 'btn danger'; reject.textContent = '拒绝';
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
  renderAgentSessions(lastSessions);
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
let lastSessions = [];
function renderAgentSessions(list) {
  lastSessions = list || [];
  const box = $('side-sessions');
  if (!box) return;
  box.innerHTML = (list || []).map(function (x) {
    return '<div class="sess-row' + (x.id === AGENT.session ? ' active' : '') + '" data-sid="' + esc(x.id) + '">' +
      esc(String(x.title || x.id).slice(0, 26)) + (x.running ? ' ●' : '') + '</div>';
  }).join('') || '<div class="muted" style="padding:4px 12px">无会话</div>';
  box.querySelectorAll('[data-sid]').forEach(function (rowEl) {
    rowEl.addEventListener('click', function () { agentSetSession(rowEl.dataset.sid); });
  });
}
async function agentInit() {
  try {
    const cfg = await api('/agent/config');
    $('agent-auto').checked = cfg.approvalMode === 'auto';
    renderAgentSessions(cfg.sessions || []);
    if (AGENT.session && !(cfg.sessions || []).some(function (x) { return x.id === AGENT.session; })) {
      AGENT.session = '';
      localStorage.removeItem('ntr-daemon-agent-session');
      AGENT.messages = []; AGENT.pending = null;
    }
    if (AGENT.session) agentRefresh(); else renderAgentMessages();
  } catch (e) { toast(e.message, true); }
}
$('agent-new').addEventListener('click', async function () {
  try { const r = await post('/agent/session', { title: '新会话' }); agentSetSession(r.sessionId); agentInit(); }
  catch (e) { toast(e.message, true); }
});
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
setInterval(function () {
  const active = document.getElementById('tab-agent').classList.contains('active');
  if (active && AGENT.session && !AGENT.polling) agentRefresh();
}, 4000);

refresh(); loadSettings(); loadRules(); loadPrompts(); agentInit();
</script>
</body>
</html>`;
