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
  .sess-group { padding: 10px 12px 2px; font-size: 11px; color: var(--muted); letter-spacing: .5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .proj-card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); padding: 10px 14px; margin: 8px 0; cursor: pointer; }
  .proj-card:hover { border-color: var(--accent); }
  .proj-card.current { border-color: var(--accent); background: var(--panel2); }
  .proj-actions { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
  .proj-detail { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 8px; font-size: 12.5px; cursor: default; }
  .proj-detail table { font-size: 12px; }
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

  .mention { position: absolute; bottom: 100%; left: 0; right: 0; max-height: 240px; overflow: auto; background: var(--panel2); border: 1px solid var(--border2); border-radius: 10px; margin-bottom: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.4); z-index: 5; }
  .mention .mi { padding: 7px 12px; font-size: 13px; cursor: pointer; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mention .mi.sel, .mention .mi:hover { background: var(--accent2); color: #fff; }
  .composer-wrap { position: relative; border-top: 1px solid var(--border); padding: 12px 4px 6px; }
  .syseditor { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); padding: 10px 12px; margin-top: 8px; }
  .syseditor textarea { min-height: 70px; }
  #toast { position: fixed; right: 16px; bottom: 16px; background: var(--accent2); color: #fff; padding: 8px 14px; border-radius: 10px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 60vw; z-index: 9; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><span class="logo">◆</span> NTR Daemon</div>
    <div style="padding:0 12px 6px">
      <select id="project-select" style="width:100%" title="当前项目：任务/规则/助手/状态默认作用于它；通用 = 全局视角"></select>
    </div>
    <nav id="side-nav">
      <button data-tab="agent" class="active"><span class="ico">💬</span>助手</button>
      <button data-tab="jobs"><span class="ico">🚚</span>任务</button>
      <button data-tab="settings"><span class="ico">⚙️</span>设置</button>
      <button data-tab="rules"><span class="ico">📏</span>规则</button>
      <button data-tab="prompts"><span class="ico">📝</span>提示词</button>
      <button data-tab="books"><span class="ico">📚</span>项目</button>
      <button data-tab="status"><span class="ico">📊</span>状态</button>
    </nav>
    <div class="divider"></div>
    <div class="side-title">项目 / 会话</div>
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
      <button class="btn ghost" id="agent-sys">系统指令</button>
      <button class="btn danger" id="agent-stop" disabled>停止</button>
    </div>
    <div id="agent-log" class="chat"></div>
    <div id="agent-decision" class="decision" style="display: none"></div>
    <div id="agent-doing" class="doing"></div>
    <div class="composer-wrap">
      <div id="agent-mention" class="mention" style="display: none"></div>
      <div class="composer">
        <textarea id="agent-input" placeholder="给助手发消息；@技能名 点名技能，/help 看命令（Enter 发送）"></textarea>
        <button class="btn primary" id="agent-send">发送</button>
      </div>
    </div>
    <div id="agent-syseditor" class="syseditor" style="display: none">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px">
        <b>会话系统指令</b>
        <span class="muted">每轮以「用户系统指令」注入（在技能目录之后）</span>
      </div>
      <textarea id="agent-sys-text" placeholder="例如：回答要短；这本书的人名统一用旧版译名；先给结论再给证据……"></textarea>
      <div style="display: flex; gap: 8px; margin-top: 6px">
        <button class="btn" id="agent-sys-save">保存</button>
        <button class="btn ghost" id="agent-sys-close">取消</button>
      </div>
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
    <div class="muted" style="margin:0 0 10px">以下均为全局设置，作用于所有项目（规则可按项目覆盖，见「规则」页）。</div>
    <fieldset><legend>连接（端口 / 跨域白名单 / 上次同步）</legend>
      <label>默认端口（重启生效） <input type="number" id="conn-port" min="1" max="65535"></label>
      <button class="btn ghost" id="conn-save">保存连接设置</button>
      <div style="margin-top:8px"><label>跨域白名单附加条目（每行一个 hostname 或 origin；内置默认 n.novelia.cc / 127.0.0.1 / localhost 不可移除）</label></div>
      <textarea id="conn-origins" style="min-height:56px" placeholder="例：novelia.cc 或 https://mirror.example.com"></textarea>
      <div class="muted" id="conn-info" style="margin-top:6px"></div>
    </fieldset>
    <fieldset><legend>翻译模型池（translate · 站点上传用；保存后立即生效）</legend>
      <div id="pool-tl"></div>
      <div><button class="btn ghost" id="tl-add">＋ 添加端点</button> <button class="btn" id="tl-save">保存翻译池</button></div>
      <div class="muted">key 留空 = 保持原值（只回显掩码，明文不出本机）；站点页面「同步 Daemon」的推送会整表覆盖此列表。</div>
    </fieldset>
    <fieldset><legend>助手 / 术语模型池（agent+glossary · 工具调用模型）</legend>
      <div id="pool-ag"></div>
      <div><button class="btn ghost" id="ag-add">＋ 添加端点</button> <button class="btn" id="ag-save">保存助手池</button> <button class="btn ghost" id="ag-clear">清空（跟随翻译池）</button></div>
      <div class="muted">独立并发/限流，与翻译池互不抢并发门；建议助手/术语走支持 tools 的模型，翻译仍走逆向 Gemini 单线程。</div>
    </fieldset>
    <fieldset><legend>翻译池调度与限流</legend>
      <label>并发上限 maxInFlight <input type="number" id="llm-max" min="1"></label>
      <label>RPM <input type="number" id="llm-rpm" min="0"></label>
      <label>传输重试 <input type="number" id="llm-retries" min="0"></label>
      <label>提示词上限(字符) <input type="number" id="llm-prompt" min="1000"></label>
      <label><input type="checkbox" id="llm-strict"> 超限直接失败（strictPrompt）</label>
      <div><button class="btn" id="settings-save">保存</button></div>
      <div class="muted">单线程 Gemini：maxInFlight=1。</div>
    </fieldset>
    <fieldset><legend>助手池调度与限流</legend>
      <label>并发上限 maxInFlight <input type="number" id="ag-max" min="1"></label>
      <label>RPM <input type="number" id="ag-rpm" min="0"></label>
      <label>传输重试 <input type="number" id="ag-retries" min="0"></label>
      <label>提示词上限(字符) <input type="number" id="ag-prompt" min="1000"></label>
      <label><input type="checkbox" id="ag-strict"> 超限直接失败（strictPrompt）</label>
      <div><button class="btn" id="ag-llm-save">保存</button></div>
      <div class="muted">默认与翻译池默认值相同；多 key 池在此直接配置即可，不必经油猴。</div>
    </fieldset>
    <fieldset><legend>助手参数（审批 / 步数 / 上下文预算）</legend>
      <label><input type="checkbox" id="ag-auto-mode"> 自动批准写入（auto；默认 manual 逐次审批）</label>
      <label>单轮步数上限 maxSteps <input type="number" id="ag-steps" min="1"></label>
      <label>工具结果截断(字符) <input type="number" id="ag-toolmax" min="500"></label>
      <label>上下文上限 <input type="number" id="ag-ctx" min="1024"></label>
      <label>压缩阈值 <input type="number" id="ag-compact" min="1024"></label>
      <label>保留最近消息 <input type="number" id="ag-keep" min="2"></label>
      <div><button class="btn" id="agent-budget-save">保存助手参数</button></div>
      <div class="muted">超压缩阈值时旧对话摘要化；审批模式也可在「助手」页顶部切换。</div>
    </fieldset>
    <fieldset><legend>站点与凭据</legend>
      <label>origin <input type="text" id="set-origin" size="40"></label>
      <button class="btn ghost" id="origin-save">保存 origin</button>
      <div style="margin-top:6px">
        <label>token <input type="password" id="set-token" size="40" placeholder="粘贴站点 token（只写不回显）"></label>
        <button class="btn ghost" id="token-save">保存 token</button>
        <span class="muted" id="cred"></span>
      </div>
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
        <label>作用域 <select id="rule-scope"><option value="project">当前项目</option><option value="global">全局（所有项目）</option></select></label>
        <button class="btn" id="rule-add">添加</button>
      </div>
      <div id="rules-table" style="margin-top:10px"></div>
    </fieldset>
  </div>

  <div class="page" id="tab-prompts" data-title="提示词">
    <fieldset><legend>提示词模板（全局 · 所有项目共用；base 必须含 {format_rules}；空槽=默认）</legend>
      <div id="prompt-fields"></div>
      <button class="btn" id="prompt-save">保存全局模板</button>
      <button class="btn ghost" id="prompt-clear">清除覆盖（回退默认）</button>
      <div class="muted" id="prompt-hint"></div>
    </fieldset>
  </div>

  <div class="page" id="tab-books" data-title="项目">
    <fieldset><legend>登记新项目（书 URL）</legend>
      <label>URL <input type="text" id="book-url" size="52" placeholder="https://n.novelia.cc/novel/syosetu/nXXXXxx"></label>
      <button class="btn" id="book-add">登记</button>
    </fieldset>
    <fieldset><legend>项目列表（点卡片展开详情）</legend><div id="books-table"></div></fieldset>
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

let STATE = { books: [], runs: [], queue: [] };
let PROJECT = localStorage.getItem('ntr-daemon-project') || '';
function renderProjectSelect() {
  const sel = $('project-select');
  if (!sel) return;
  if (PROJECT && !(STATE.books || []).some((b) => b.key === PROJECT)) { PROJECT = ''; localStorage.removeItem('ntr-daemon-project'); }
  sel.innerHTML = '<option value="">通用（全局视角）</option>' + (STATE.books || []).map((b) =>
    '<option value="' + esc(b.key) + '"' + (b.key === PROJECT ? ' selected' : '') + '>' + esc(String(b.title || b.key).slice(0, 30)) + '</option>').join('');
  const scope = $('rule-scope');
  if (scope) scope.value = PROJECT ? 'project' : 'global';
}
$('project-select').addEventListener('change', function () {
  PROJECT = this.value || '';
  if (PROJECT) localStorage.setItem('ntr-daemon-project', PROJECT); else localStorage.removeItem('ntr-daemon-project');
  refresh(); loadRules(); loadPrompts();
});
async function refresh() {
  try {
    const status = await api('/status');
    STATE.books = status.books || [];
    STATE.runs = status.runs || [];
    const q = status.queue || [];
    STATE.queue = q;
    renderProjectSelect();
    const hdrParts = [];
    if (PROJECT) hdrParts.push('📚 ' + String(((STATE.books || []).find((b) => b.key === PROJECT) || {}).title || PROJECT).slice(0, 18));
    hdrParts.push('队列 ' + q.filter((x) => x.state === 'running' || x.state === 'queued').length);
    hdrParts.push('在途 ' + ((status.llm && status.llm.inFlightNow) || 0) + '/' + ((status.llm && status.llm.maxInFlight) || '?'));
    hdrParts.push('workers ' + ((status.llm && status.llm.workers) || 0));
    hdrParts.push('用量 ' + ((status.usage && status.usage.requests) || 0) + ' req / ' + ((status.usage && (status.usage.promptTokens + status.usage.completionTokens)) || 0) + ' tok');
    $('hdr').textContent = hdrParts.join(' · ');
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
  if (PROJECT && STATE.books.some((b) => b.key === PROJECT)) $('job-book').value = PROJECT;
  $('queue').innerHTML = (status.queue || []).slice().reverse().map((x) =>
    '<div>' + esc(x.job) + ' · ' + esc(x.bookKey) + ' · <b>' + esc(x.state) + '</b>' +
    (x.stats ? ' · ' + esc(JSON.stringify(x.stats).slice(0, 160)) : '') +
    (x.error ? ' · <span class="bad">' + esc(x.error) + '</span>' : '') + '</div>').join('') || '<span class="muted">空</span>';
  $('runs').innerHTML = '<table><tr><th>id</th><th>job</th><th>book</th><th>state</th><th>stats</th></tr>' +
    (status.runs || []).map((r) => '<tr><td>' + r.id + '</td><td>' + esc(r.job) + '</td><td>' + esc(r.bookKey) + '</td><td>' + esc(r.state) + '</td><td class="muted">' + esc(JSON.stringify(r.stats || {}).slice(0, 200)) + '</td></tr>').join('') + '</table>';
}
function renderStatus(status) {
  const m = (status.metrics || []).slice(-3).map((x) => 'rss ' + x.rss.toFixed(1) + 'MB').join(' / ');
  let pj = '';
  if (PROJECT) {
    const b = (STATE.books || []).find((x) => x.key === PROJECT) || {};
    const runs = (STATE.runs || []).filter((r) => r.bookKey === PROJECT).slice(0, 3)
      .map((r) => r.job + '/' + r.state).join('、') || '—';
    pj = '<div>当前项目：' + esc(String(b.title || PROJECT).slice(0, 40)) + ' · 状态 ' + esc(b.state || 'idle') +
      ' · 已译 ' + (b.progress || 0) + ' 章 · 最近 run ' + esc(runs) + '</div>';
  }
  $('status-box').innerHTML = pj +
    '<div>llm（翻译池）：' + esc(JSON.stringify(status.llm || {})) + '</div>' +
    '<div>llm（助手/术语池）：' + esc(JSON.stringify(status.llmAgent || null)) + '</div>' +
    '<div>usage：' + esc(JSON.stringify(status.usage || {})) + '</div>' +
    '<div>metrics：' + esc(m) + '</div>';
}
async function renderBooks() {
  let openByBook = {};
  try {
    const pr = await api('/proposals');
    (pr.proposals || []).forEach((p) => { if (p.status === 'open') openByBook[p.bookKey] = (openByBook[p.bookKey] || 0) + 1; });
  } catch (e) { }
  const queueByBook = {};
  (STATE.queue || []).forEach((q) => { if (q.state !== 'done' && q.state !== 'failed') queueByBook[q.bookKey] = (queueByBook[q.bookKey] || 0) + 1; });
  const runsByBook = {};
  (STATE.runs || []).forEach((r) => { if (!runsByBook[r.bookKey]) runsByBook[r.bookKey] = r; });
  $('books-table').innerHTML = (STATE.books || []).map((b) => {
    const run = runsByBook[b.key];
    return '<div class="proj-card' + (b.key === PROJECT ? ' current' : '') + '" data-pk="' + esc(b.key) + '">' +
      '<div><b>' + esc(String(b.title || b.key).slice(0, 46)) + '</b>' + (b.key === PROJECT ? ' <span class="ok">当前</span>' : '') + '</div>' +
      '<div class="muted">' + esc(b.key) + ' · ' + esc(b.state || 'idle') + '</div>' +
      '<div class="muted">已译 ' + (b.progress || 0) + ' 章 · 最近 run ' + (run ? esc(run.job + '/' + run.state) : '—') +
      ' · 队列 ' + (queueByBook[b.key] || 0) + ' · open 提案 ' + (openByBook[b.key] || 0) + '</div>' +
      '<div class="proj-actions">' +
      '<button class="btn ghost" data-cur="' + esc(b.key) + '">设为当前</button> ' +
      '<button class="btn" data-run="' + esc(b.key) + '">派发任务</button> ' +
      '<button class="btn ghost" data-lgexport="' + esc(b.key) + '">导出 LG 源文</button> ' +
      '<button class="btn ghost" data-lgimport="' + esc(b.key) + '">导入 LG 译文</button> ' +
      '<button class="btn danger" data-forget="' + esc(b.key) + '">忘记</button></div>' +
      '<div class="proj-detail" style="display:none"></div>' +
      '</div>';
  }).join('') || '<span class="muted">还没有项目：用上方 URL 登记一本书。</span>';
  document.querySelectorAll('#books-table .proj-card').forEach((card) => {
    card.addEventListener('click', (ev) => { if (ev.target && ev.target.tagName === 'BUTTON') return; toggleProjectDetail(card); });
  });
  document.querySelectorAll('[data-cur]').forEach((btn) => btn.addEventListener('click', () => {
    PROJECT = btn.dataset.cur;
    localStorage.setItem('ntr-daemon-project', PROJECT);
    refresh(); loadRules(); loadPrompts(); toast('当前项目：' + PROJECT);
  }));
  document.querySelectorAll('[data-run]').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelector('#side-nav button[data-tab=jobs]').click();
    $('job-book').value = btn.dataset.run;
  }));
  document.querySelectorAll('[data-forget]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('从本地 daemon 忘记 ' + btn.dataset.forget + '？（站点数据不动）')) return;
    try { await post('/books', { action: 'forget', key: btn.dataset.forget }); toast('已忘记'); refresh(); } catch (e) { toast(e.message, true); }
  }));
  document.querySelectorAll('[data-lgexport]').forEach((btn) => btn.addEventListener('click', async () => {
    const bookKey = btn.dataset.lgexport;
    const card = btn.closest('.proj-card');
    const box = card.querySelector('.proj-detail');
    box.style.display = 'block';
    box.textContent = '导出中（逐章取原文）…';
    try {
      const r = await post('/lg/export', { bookKey });
      LG_LAST[bookKey] = { file: r.file, manifestFile: r.manifestFile };
      box.innerHTML = '<div><b>已导出 ' + esc(String(r.linesTotal)) + ' 行 / ' + esc(String(r.chapters)) + ' 章</b></div>' +
        '<div>源文：<code>' + esc(r.file) + '</code>（交给 LinguaGacha 建项目翻译，保持行数）</div>' +
        '<div>清单：<code>' + esc(r.manifestFile) + '</code>（导入时用；已为本项目记住）</div>' +
        '<div class="muted">翻译完成后点「导入 LG 译文」，选择 LG 导出的结果 txt 即可。</div>';
      toast('已导出 ' + r.linesTotal + ' 行');
    } catch (e) { box.textContent = ''; box.style.display = 'none'; toast(e.message, true); }
  }));
  document.querySelectorAll('[data-lgimport]').forEach((btn) => btn.addEventListener('click', () => {
    openLgImportPanel(btn.closest('.proj-card'), btn.dataset.lgimport);
  }));
}
// 项目页：LG 译文导入面板（本会话记住最近一次导出的清单路径）
const LG_LAST = {};
function openLgImportPanel(card, bookKey) {
  const box = card.querySelector('.proj-detail');
  box.style.display = 'block';
  box.innerHTML = '';
  const state = { txtPath: '', manifestPath: (LG_LAST[bookKey] || {}).manifestFile || '' };
  const mkRow = () => { const row = document.createElement('div'); row.style.cssText = 'margin:4px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap'; return row; };
  // 结果 txt
  const txtRow = mkRow();
  const txtLabel = document.createElement('span'); txtLabel.textContent = 'LG 结果 txt：';
  const txtInput = document.createElement('input'); txtInput.type = 'file'; txtInput.accept = '.txt,text/plain';
  txtRow.append(txtLabel, txtInput);
  // 清单
  const mfRow = mkRow();
  const mfLabel = document.createElement('span'); mfLabel.textContent = '清单 json：';
  const mfInput = document.createElement('input'); mfInput.type = 'file'; mfInput.accept = '.json,application/json';
  const mfHint = document.createElement('span'); mfHint.className = 'muted';
  mfHint.textContent = state.manifestPath ? ('默认用本会话导出时的清单：' + state.manifestPath + '（可另选覆盖）') : '未记住清单，请选择导出时生成的 .manifest.json';
  mfRow.append(mfLabel, mfInput, mfHint);
  // 操作行
  const opRow = mkRow();
  const verifyBtn = document.createElement('button'); verifyBtn.className = 'btn'; verifyBtn.textContent = '校验';
  const limitLabel = document.createElement('span'); limitLabel.textContent = '限章数';
  const limitInput = document.createElement('input'); limitInput.type = 'number'; limitInput.min = '0'; limitInput.value = '0';
  const applyBtn = document.createElement('button'); applyBtn.className = 'btn'; applyBtn.textContent = '提交通过章'; applyBtn.disabled = true;
  opRow.append(verifyBtn, limitLabel, limitInput, applyBtn);
  const report = document.createElement('div'); report.className = 'muted';
  report.textContent = '选好文件后点「校验」：逐章核对行数/空行模式/源 sha1，再决定提交。';
  box.append(txtRow, mfRow, opRow, report);
  const uploadFile = async (file) => {
    const text = await file.text();
    const r = await post('/lg/upload', { filename: file.name, content: text });
    return r.path;
  };
  verifyBtn.addEventListener('click', async () => {
    try {
      const txtFile = txtInput.files && txtInput.files[0];
      if (!txtFile) { toast('请先选择 LG 结果 txt', true); return; }
      report.textContent = '上传并校验中…';
      state.txtPath = await uploadFile(txtFile);
      const mfFile = mfInput.files && mfInput.files[0];
      if (mfFile) state.manifestPath = await uploadFile(mfFile);
      const v = await post('/lg/verify', { bookKey, txtPath: state.txtPath, manifestPath: state.manifestPath || undefined });
      if (v.globalError) {
        applyBtn.disabled = true;
        report.innerHTML = '<div class="bad">' + esc(v.globalError) + '</div>' +
          '<div class="muted">结果 ' + v.linesIn + ' 行 / 清单 ' + v.linesTotal + ' 行</div>';
        return;
      }
      const rows = (v.chapters || []).map((c) =>
        '<div>' + (c.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') + ' ' +
        esc(c.title || c.chapterId) + '（' + c.count + ' 段）' + (c.ok ? '' : '：' + esc(c.reason)) + '</div>').join('');
      report.innerHTML = '<div><b>校验：' + v.okCount + '/' + v.total + ' 章通过 · 疑似未翻 ' + v.untranslated + ' 行</b>（' + esc(v.note) + '）</div>' + rows;
      applyBtn.disabled = !(v.okCount > 0);
      toast('校验完成：' + v.okCount + '/' + v.total + ' 章通过');
    } catch (e) { report.textContent = '校验失败：' + e.message; applyBtn.disabled = true; }
  });
  applyBtn.addEventListener('click', async () => {
    try {
      const limit = Math.max(0, Number(limitInput.value) || 0);
      const r = await post('/run', { bookKey, job: 'lg-import', options: { txtPath: state.txtPath, manifestPath: state.manifestPath, limit } });
      applyBtn.disabled = true;
      const progressBox = document.createElement('div');
      progressBox.style.cssText = 'margin-top:6px; border-top:1px dashed var(--border); padding-top:6px';
      progressBox.textContent = '已入队 lg-import #' + r.id + '，等待执行…';
      box.appendChild(progressBox);
      toast('已入队 lg-import（#' + r.id + '）');
      const timer = setInterval(async () => {
        try {
          const st = await api('/status');
          const item = (st.queue || []).find((x) => x.id === r.id);
          if (!item) { progressBox.textContent = '队列已滚动出最近 20 条；完整结果看「任务」页最近 run。'; clearInterval(timer); return; }
          const p = item.progress || null;
          const head = 'lg-import #' + r.id + ' · ' + esc(item.state);
          if (item.state === 'queued') { progressBox.innerHTML = head + '（排队中）'; return; }
          let body = '';
          if (p) {
            if (p.phase === 'verify') body = esc(p.message || '校验中…');
            else if (p.phase === 'apply') body = esc(p.message || '提交中…') + (p.failed ? ' · 失败 ' + p.failed : '');
            else if (p.phase === 'done') body = esc(p.message || '完成');
            else if (p.phase === 'error') body = '<span class="bad">' + esc(p.message || '失败') + '</span>';
          }
          let results = '';
          if ((item.state === 'done' || item.state === 'failed') && item.stats) {
            const s = item.stats;
            const list = (s.results || []).map((x) =>
              '<div>' + (x.status === 'uploaded' ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') + ' ' +
              esc(x.title || x.chapterId) + (x.status === 'uploaded' ? '（' + x.count + ' 段）' : '：' + esc(x.error || '')) + '</div>').join('');
            results = '<div>上传 ' + s.uploaded + ' · 失败 ' + s.failed + ' · 未过校验 ' + (s.total - s.ok) + ' · 疑似未翻 ' + s.untranslated + ' 行</div>' + list;
          }
          progressBox.innerHTML = '<div><b>' + head + '</b> ' + body + '</div>' + results;
          if (item.state === 'done' || item.state === 'failed') { clearInterval(timer); refresh(); }
        } catch (e) { progressBox.textContent = '进度查询失败：' + e.message; }
      }, 1000);
    } catch (e) { toast(e.message, true); }
  });
}
async function toggleProjectDetail(card) {
  const box = card.querySelector('.proj-detail');
  if (!box) return;
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.textContent = '加载详情…';
  const key = card.dataset.pk;
  const fallback = (v) => v;
  const prog = await api('/progress?book=' + encodeURIComponent(key)).catch(() => null);
  const rules = await api('/rules?book=' + encodeURIComponent(key)).catch(() => null);
  const sessions = await api('/agent/sessions').catch(() => null);
  const rows = (prog && prog.progress) || [];
  const byState = {};
  rows.forEach((p) => { byState[p.state] = (byState[p.state] || 0) + 1; });
  const ruleCount = ((rules && rules.rules) || []).filter((r) => (r.bookKey || '') === key).length;
  const sessList = ((sessions && sessions.sessions) || []).filter((x) => (x.bookKey || '') === key);
  const recent = (STATE.runs || []).filter((r) => r.bookKey === key).slice(0, 3)
    .map((r) => esc(r.job + '/' + r.state)).join('、') || '—';
  box.innerHTML =
    '<div>进度：' + rows.length + ' 章' + (Object.keys(byState).length ? '（' + Object.keys(byState).map((s) => esc(s) + ' ' + byState[s]).join(' / ') + '）' : '') + ' · 最近 run：' + recent + '</div>' +
    '<div>本项目规则覆盖 ' + ruleCount + ' 条 · 助手会话 ' + sessList.length + ' 个</div>' +
    (sessList.length ? '<div>' + sessList.slice(0, 5).map((x) => '<span class="sess-row" data-jumpsess="' + esc(x.id) + '" style="display:inline-block;padding:2px 8px">' + esc(String(x.title || x.id).slice(0, 20)) + '</span>').join(' ') + '</div>' : '') +
    '<div class="muted">进度明细（前 8）：</div>' +
    '<table><tr><th>章节</th><th>状态</th><th>glossaryUuid</th></tr>' +
    rows.slice(0, 8).map((p) => '<tr><td>' + esc(p.chapterKey) + '</td><td>' + esc(p.state) + '</td><td class="muted">' + esc(p.glossaryUuid || '—') + '</td></tr>').join('') + '</table>' +
    (rows.length > 8 ? '<div class="muted">…其余 ' + (rows.length - 8) + ' 章略</div>' : '');
  box.querySelectorAll('[data-jumpsess]').forEach((el) => el.addEventListener('click', () => {
    document.querySelector('#side-nav button[data-tab=agent]').click();
    agentSetSession(el.dataset.jumpsess);
  }));
}

// ---- 模型池行编辑（DOM API 构建；key 只回显掩码，留空 = 服务器按 id 沿用原 key） ----
function workerRow(container, w) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0';
  if (w && w.id) row.dataset.id = w.id;
  const mkInput = (ph, val, minPx, isKey) => {
    const inp = document.createElement('input');
    inp.type = isKey ? 'password' : 'text';
    inp.placeholder = ph;
    if (!isKey && val != null) inp.value = val;
    inp.style.cssText = 'flex:1 1 ' + minPx + 'px; min-width:0';
    return inp;
  };
  const ep = mkInput('https://127.0.0.1:8000/v1', w && w.endpoint, 260, false);
  const md = mkInput('model 名', w && w.model, 130, false);
  const ky = mkInput(w && w.key ? '保持 ' + w.key : '新 key', '', 90, true);
  const del = document.createElement('button');
  del.className = 'btn danger';
  del.style.cssText = 'flex:0 0 auto';
  del.textContent = '删';
  del.addEventListener('click', () => row.remove());
  row.append(ep, md, ky, del);
  container.appendChild(row);
}
function collectWorkers(container) {
  return Array.from(container.children).map((row, i) => ({
    id: row.dataset.id || ('w' + i),
    endpoint: row.children[0].value.trim(),
    model: row.children[1].value.trim(),
    key: row.children[2].value,
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
    $('ag-auto-mode').checked = agent.approvalMode === 'auto';
    $('ag-steps').value = agent.maxSteps || 24;
    $('ag-toolmax').value = agent.toolResultMaxChars || 12000;
    const agLlm = agent.llm || {};
    $('ag-max').value = agLlm.maxInFlight != null ? agLlm.maxInFlight : 1;
    $('ag-rpm').value = agLlm.rpm || 0;
    $('ag-retries').value = agLlm.transportRetries != null ? agLlm.transportRetries : 3;
    $('ag-prompt').value = agLlm.maxPromptChars || 12000;
    $('ag-strict').checked = agLlm.strictPrompt === true;
    $('set-origin').value = (s.settings && s.settings.origin) || '';
    const serve = (s.settings && s.settings.serve) || {};
    $('conn-port').value = serve.port || 7331;
    $('conn-origins').value = (serve.origins || []).join('\\n');
    const ls = (s.settings && s.settings.lastSync) || null;
    $('conn-info').textContent = '当前监听 127.0.0.1:' + (serve.port || 7331) + ' · ' +
      (ls ? '上次同步 ' + new Date(ls.at).toLocaleString() + ' · ' + (ls.origin || '?') + ' · ' + (ls.ua || '?') +
        ' · ' + (ls.workersCount == null ? '?' : ls.workersCount) + ' 个翻译器' : '从未同步（在站点页面点「同步 Daemon」）');
    $('cred').textContent = 'token：' + (s.settings.tokenSet ? '已同步' : '未同步') +
      ' · 翻译池 ' + ((s.settings.workers || []).length) + ' 个 · 助手池 ' +
      ((agent.workers || []).length > 0 ? (agent.workers.length + ' 个（显式）') : '跟随翻译池');
    const tlBox = $('pool-tl');
    const agBox = $('pool-ag');
    tlBox.innerHTML = '';
    agBox.innerHTML = '';
    const tl = s.settings.workers || [];
    tl.forEach((w) => workerRow(tlBox, w));
    if (tl.length === 0) workerRow(tlBox, null);
    (agent.workers || []).forEach((w) => workerRow(agBox, w));
  } catch (e) { toast(e.message, true); }
}
$('tl-add').addEventListener('click', () => workerRow($('pool-tl'), null));
$('ag-add').addEventListener('click', () => workerRow($('pool-ag'), null));
$('tl-save').addEventListener('click', async () => {
  try { await post('/settings', { workers: collectWorkers($('pool-tl')) }); toast('翻译池已保存并生效'); loadSettings(); }
  catch (e) { toast(e.message, true); }
});
$('ag-save').addEventListener('click', async () => {
  try { await post('/settings', { agent: { workers: collectWorkers($('pool-ag')) } }); toast('助手池已保存并生效'); loadSettings(); }
  catch (e) { toast(e.message, true); }
});
$('ag-clear').addEventListener('click', async () => {
  try { await post('/settings', { agent: { workers: [] } }); toast('助手池已清空：跟随翻译池'); loadSettings(); }
  catch (e) { toast(e.message, true); }
});
$('ag-llm-save').addEventListener('click', async () => {
  try {
    await post('/settings', { agent: { llm: {
      maxInFlight: Number($('ag-max').value) || 1,
      rpm: Number($('ag-rpm').value) || 0,
      transportRetries: Number($('ag-retries').value) || 0,
      maxPromptChars: Number($('ag-prompt').value) || 12000,
      strictPrompt: $('ag-strict').checked,
    } } });
    toast('助手池调度已保存并生效'); loadSettings();
  } catch (e) { toast(e.message, true); }
});
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
      approvalMode: $('ag-auto-mode').checked ? 'auto' : 'manual',
      maxSteps: Number($('ag-steps').value) || 24,
      toolResultMaxChars: Number($('ag-toolmax').value) || 12000,
      maxContextTokens: Number($('ag-ctx').value) || 200000,
      compactThresholdTokens: Number($('ag-compact').value) || 120000,
      keepRecentMessages: Number($('ag-keep').value) || 12,
    } });
    const agAuto = $('agent-auto');
    if (agAuto) agAuto.checked = $('ag-auto-mode').checked;
    toast('助手参数已保存并生效');
  } catch (e) { toast(e.message, true); }
});
$('origin-save').addEventListener('click', async () => {
  try { await post('/settings', { origin: $('set-origin').value.trim() }); toast('origin 已保存'); } catch (e) { toast(e.message, true); }
});
$('conn-save').addEventListener('click', async () => {
  try {
    const origins = $('conn-origins').value.split('\\n').map((x) => x.trim()).filter(Boolean);
    await post('/settings', { serve: { port: Number($('conn-port').value) || 7331, origins } });
    toast('连接设置已保存（端口重启后生效）'); loadSettings();
  } catch (e) { toast(e.message, true); }
});
$('token-save').addEventListener('click', async () => {
  try {
    const tok = $('set-token').value.trim();
    if (!tok) { toast('token 为空', true); return; }
    await post('/auth', { token: tok });
    $('set-token').value = '';
    toast('token 已保存'); loadSettings();
  } catch (e) { toast(e.message, true); }
});

async function loadRules() {
  try {
    const data = await api('/rules?book=' + encodeURIComponent(PROJECT));
    $('rules-table').innerHTML = '<div class="muted" style="margin-bottom:4px">展示：全局 + ' + (PROJECT ? '当前项目' : '通用视角仅全局；在侧栏选项目后可看项目覆盖') + '</div>' +
      '<table><tr><th>id</th><th>on</th><th>kind</th><th>pattern</th><th>replacement</th><th>re/cs</th><th>prio</th><th>来源</th><th></th></tr>' +
      (data.rules || []).map((r) => '<tr><td>' + r.id + '</td><td>' + (r.enabled ? '<span class="ok">✓</span>' : '—') + '</td><td>' + esc(r.kind) + '</td><td><code>' + esc(r.pattern) + '</code></td><td>' + esc(r.replacement) + '</td><td>' + (r.regex ? 're ' : '') + (r.case_sensitive ? 'cs' : '') + '</td><td>' + r.priority + '</td><td>' + (r.bookKey ? '<span class="ok">项目</span> ' + esc(r.bookKey.slice(0, 16)) : '全局') + '</td>' +
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
      bookKey: ($('rule-scope').value === 'global' || !PROJECT) ? '' : PROJECT,
    });
    $('rule-pattern').value = ''; $('rule-replacement').value = '';
    toast('规则已添加'); loadRules();
  } catch (e) { toast(e.message, true); }
});

let PROMPT_DEFAULTS = {};
async function loadPrompts() {
  try {
    const data = await api('/prompts?book=');
    PROMPT_DEFAULTS = data.defaults || {};
    $('prompt-hint').textContent = '协议段（代码注入，不可覆盖）：' + (data.formatRules || '') + '；默认模板渲染与站点镜像提示逐字一致。全局模板，所有项目共用。';
    const rows = new Map((data.rows || []).filter((r) => (r.bookKey || '') === '').map((r) => [r.slot, r.text]));
    $('prompt-fields').innerHTML = ['prefix', 'base', 'thinking', 'suffix'].map((slot) =>
      '<div><b>' + slot + '</b>' + (rows.has(slot) ? '' : ' <span class="muted">（默认）</span>') +
      '<textarea id="prompt-' + slot + '" placeholder="' + esc(String(PROMPT_DEFAULTS[slot] || '').slice(0, 120)) + '">' + esc(rows.get(slot) || '') + '</textarea></div>').join('');
  } catch (e) { toast(e.message, true); }
}
$('prompt-save').addEventListener('click', async () => {
  try {
    for (const slot of ['prefix', 'base', 'thinking', 'suffix']) {
      const text = $('prompt-' + slot).value;
      if (text.trim() === '') await post('/prompts', { action: 'clear', bookKey: '', slot });
      else await post('/prompts', { bookKey: '', slot, text });
    }
    toast('全局模板已保存'); loadPrompts();
  } catch (e) { toast(e.message, true); }
});
$('prompt-clear').addEventListener('click', async () => {
  try {
    await post('/prompts', { action: 'clear-all', bookKey: '' });
    toast('已清除全局覆盖（回退默认）'); loadPrompts();
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
let AGENT = { session: localStorage.getItem('ntr-daemon-agent-session') || '', es: null, polling: null, messages: [], pending: null, running: false, usage: null, transport: '', sessionBook: '' };
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
        pre.textContent = '参数：' + JSON.stringify(tc.args || {}) + (result ? '\\n结果：' + String(result.content || '').slice(0, 1200) : '');
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
  const pj = AGENT.sessionBook ? ' · 项目 ' + String(((STATE.books || []).find((b) => b.key === AGENT.sessionBook) || {}).title || AGENT.sessionBook).slice(0, 16) : '';
  $('agent-status').textContent = (AGENT.running ? '进行中…' : '空闲') +
    ' · 请求 ' + (AGENT.usage ? AGENT.usage.requests : 0) +
    ' · tokens ' + (AGENT.usage ? (AGENT.usage.promptTokens + AGENT.usage.completionTokens) : 0) +
    pj +
    (AGENT.transport ? ' · ' + AGENT.transport : '');
}
async function agentSnapshot() {
  if (!AGENT.session) return;
  const data = await api('/agent/snapshot?session=' + encodeURIComponent(AGENT.session));
  AGENT.messages = data.messages || [];
  AGENT.pending = data.pendingDecision || null;
  AGENT.running = !!data.running;
  AGENT.usage = data.usage || null;
  AGENT.sessionBook = (data.session && data.session.bookKey) || '';
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
function renderAgentSessions(list) {
  lastSessions = list || [];
  const box = $('side-sessions');
  if (!box) return;
  const groups = {};
  (list || []).forEach(function (x) {
    const g = x.bookKey || '';
    (groups[g] = groups[g] || []).push(x);
  });
  const bookTitle = function (key) {
    const b = (STATE.books || []).find(function (b) { return b.key === key; });
    return b ? (b.title || b.key) : key;
  };
  const keys = Object.keys(groups).sort(function (a, b) {
    if (!a) return 1;
    if (!b) return -1;
    return (groups[b][0].updatedAt || 0) - (groups[a][0].updatedAt || 0);
  });
  let html = '';
  keys.forEach(function (g) {
    html += '<div class="sess-group">' + esc(String(g ? bookTitle(g) : '通用（未绑定项目）').slice(0, 26)) + (g ? ' <span style="opacity:.6">' + esc(g.slice(0, 20)) + '</span>' : '') + '</div>';
    html += groups[g].map(function (x) {
      return '<div class="sess-row' + (x.id === AGENT.session ? ' active' : '') + '" data-sid="' + esc(x.id) + '">' +
        esc(String(x.title || x.id).slice(0, 26)) + (x.running ? ' ●' : '') + '</div>';
    }).join('');
  });
  box.innerHTML = html || '<div class="muted" style="padding:4px 12px">无会话</div>';
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
  try { const r = await post('/agent/session', { title: '新会话', bookKey: PROJECT || '' }); agentSetSession(r.sessionId); agentInit(); }
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
  agentMentionClose();
  if (text.startsWith('/')) { agentCommand(text); return; }
  try {
    if (!AGENT.session) { const r = await post('/agent/session', { title: text.slice(0, 30), bookKey: PROJECT || '' }); agentSetSession(r.sessionId); }
    await post('/agent/message', { session: AGENT.session, message: text, approvalMode: $('agent-auto').checked ? 'auto' : 'manual' });
    $('agent-doing').textContent = '';
    agentRefresh();
  } catch (e) { toast(e.message, true); }
}
$('agent-send').addEventListener('click', agentSend);
$('agent-input').addEventListener('keydown', function (e) {
  if (AGENT_MENTION.active) {
    if (e.key === 'ArrowDown') { e.preventDefault(); agentMentionMove(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); agentMentionMove(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); agentMentionPick(AGENT_MENTION.index); return; }
    if (e.key === 'Escape') { e.preventDefault(); agentMentionClose(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
});
setInterval(function () {
  const active = document.getElementById('tab-agent').classList.contains('active');
  if (active && AGENT.session && !AGENT.polling) agentRefresh();
}, 4000);

// ---------------- 输入框指令（@技能 / 斜杠命令 / 系统指令） ----------------
const AGENT_COMMANDS = [
  { cmd: '/help', desc: '命令表' },
  { cmd: '/new [标题]', desc: '新会话' },
  { cmd: '/stop', desc: '停止当前轮' },
  { cmd: '/auto [on|off]', desc: '审批模式' },
  { cmd: '/tools', desc: '列出工具' },
  { cmd: '/skills', desc: '列出技能' },
  { cmd: '/translate <book> [level] [max]', desc: '入队翻译' },
  { cmd: '/glossary <book>', desc: '入队术语管线' },
  { cmd: '/check <book> [propose]', desc: '入队质检' },
];
let AGENT_MENTION = { active: false, items: [], index: 0, kind: '', from: 0 };
let AGENT_SKILLS = null;
function agentLocalLine(text, cls) {
  const box = $('agent-log');
  box.appendChild(agentLine('msg system' + (cls ? ' ' + cls : ''), text));
  box.scrollTop = box.scrollHeight;
}
function agentMentionClose() {
  AGENT_MENTION.active = false;
  const box = $('agent-mention');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}
function agentMentionRender() {
  const box = $('agent-mention');
  box.innerHTML = AGENT_MENTION.items.map(function (it, i) {
    return '<div class="mi' + (i === AGENT_MENTION.index ? ' sel' : '') + '" data-i="' + i + '">' + esc(it.label) + '</div>';
  }).join('');
  box.style.display = 'block';
  box.querySelectorAll('.mi').forEach(function (el) {
    el.addEventListener('mousedown', function (e) { e.preventDefault(); agentMentionPick(Number(el.dataset.i)); });
  });
}
function agentMentionMove(delta) {
  const n = AGENT_MENTION.items.length;
  AGENT_MENTION.index = (AGENT_MENTION.index + delta + n) % n;
  const box = $('agent-mention');
  box.querySelectorAll('.mi').forEach(function (el, i) { el.classList.toggle('sel', i === AGENT_MENTION.index); });
}
function agentMentionPick(i) {
  const input = $('agent-input');
  const it = AGENT_MENTION.items[i];
  const caret = input.selectionStart;
  const before = input.value.slice(0, AGENT_MENTION.from);
  const after = input.value.slice(caret);
  input.value = before + it.token + ' ' + after;
  const pos = (before + it.token + ' ').length;
  input.setSelectionRange(pos, pos);
  agentMentionClose();
  input.focus();
}
async function agentSkillsCache() {
  if (!AGENT_SKILLS) {
    try { AGENT_SKILLS = (await api('/agent/skills')).skills || []; } catch (e) { AGENT_SKILLS = []; }
  }
  return AGENT_SKILLS;
}
function agentMentionUpdate() {
  const input = $('agent-input');
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const atMatch = /(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_-]*)$/.exec(before);
  const slashMatch = /^[/]([A-Za-z]*)$/.exec(before);
  let kind = null; let query = ''; let from = 0;
  if (atMatch) { kind = 'skill'; query = atMatch[1]; from = caret - atMatch[1].length - 1; }
  else if (slashMatch) { kind = 'cmd'; query = slashMatch[1]; from = 0; }
  if (!kind) { agentMentionClose(); return; }
  let items = [];
  if (kind === 'skill') {
    items = (AGENT_SKILLS || []).filter(function (s) { return s.name.startsWith(query); }).slice(0, 8)
      .map(function (s) { return { token: '@' + s.name, label: '@' + s.name + '  ' + String(s.description || '').slice(0, 46) }; });
  } else {
    items = AGENT_COMMANDS.filter(function (c) { return c.cmd.slice(1).startsWith(query); }).slice(0, 8)
      .map(function (c) { return { token: c.cmd, label: c.cmd + '  ' + c.desc }; });
  }
  if (items.length === 0) { agentMentionClose(); return; }
  AGENT_MENTION = { active: true, items: items, index: 0, kind: kind, from: from };
  agentMentionRender();
}
async function agentCommand(text) {
  const parts = text.slice(1).split(' ').filter((x) => x !== '');
  const cmd = parts[0];
  const args = parts.slice(1);
  const needBook = function () { if (!args[0]) { agentLocalLine('缺少 bookKey：' + cmd + ' <bookKey> …', 'bad'); return true; } return false; };
  if (cmd === 'help') {
    agentLocalLine('命令：' + AGENT_COMMANDS.map(function (c) { return c.cmd; }).join('  ') + '；消息里 @技能名 可点名技能');
  } else if (cmd === 'new') {
    try { const r = await post('/agent/session', { title: args.join(' ') || '新会话', bookKey: PROJECT || '' }); agentSetSession(r.sessionId); agentInit(); agentLocalLine('已新建会话 ' + r.sessionId.slice(0, 8) + (PROJECT ? '（项目 ' + PROJECT.slice(0, 20) + '）' : '')); }
    catch (e) { agentLocalLine('失败：' + e.message, 'bad'); }
  } else if (cmd === 'stop') {
    try { await post('/agent/stop', { session: AGENT.session }); agentLocalLine('已请求停止'); agentRefresh(); }
    catch (e) { agentLocalLine('失败：' + e.message, 'bad'); }
  } else if (cmd === 'auto') {
    const on = args[0] ? args[0] === 'on' : !$('agent-auto').checked;
    $('agent-auto').checked = on;
    try { await post('/agent/config', { approvalMode: on ? 'auto' : 'manual' }); agentLocalLine('审批模式：' + (on ? 'auto' : 'manual')); }
    catch (e) { agentLocalLine('失败：' + e.message, 'bad'); }
  } else if (cmd === 'tools') {
    try { const c = await api('/agent/config'); agentLocalLine('工具：' + (c.tools || []).join('、')); }
    catch (e) { agentLocalLine('失败：' + e.message, 'bad'); }
  } else if (cmd === 'skills') {
    try { const c = await api('/agent/skills'); agentLocalLine('技能：' + (c.skills || []).map(function (x) { return x.name; }).join('、')); }
    catch (e) { agentLocalLine('失败：' + e.message, 'bad'); }
  } else if (cmd === 'translate') {
    if (needBook()) return;
    try {
      const r = await post('/run', { bookKey: args[0], job: 'translate', options: { level: ['expire', 'normal', 'all'].indexOf(args[1]) >= 0 ? args[1] : 'expire', maxChapters: Number(args[2]) || 0 } });
      agentLocalLine('已入队 #' + r.id + '（translate ' + args[0] + '）；「任务」页看进度');
    } catch (e) { agentLocalLine('失败：' + e.message, 'bad'); }
  } else if (cmd === 'glossary') {
    if (needBook()) return;
    try { const r = await post('/run', { bookKey: args[0], job: 'glossary' }); agentLocalLine('已入队 #' + r.id + '（glossary ' + args[0] + '）'); }
    catch (e) { agentLocalLine('失败：' + e.message, 'bad'); }
  } else if (cmd === 'check') {
    if (needBook()) return;
    try { const r = await post('/run', { bookKey: args[0], job: 'check', options: { propose: args[1] === 'propose' } }); agentLocalLine('已入队 #' + r.id + '（check ' + args[0] + '）'); }
    catch (e) { agentLocalLine('失败：' + e.message, 'bad'); }
  } else {
    agentLocalLine('未知命令 /' + cmd + '；/help 查看命令表', 'bad');
  }
}
$('agent-sys').addEventListener('click', async function () {
  const panel = $('agent-syseditor');
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  if (!AGENT.session) { toast('先新建会话'); return; }
  try {
    const snap = await api('/agent/snapshot?session=' + encodeURIComponent(AGENT.session));
    $('agent-sys-text').value = (snap.session && snap.session.personality) || '';
    panel.style.display = 'block';
    $('agent-sys-text').focus();
  } catch (e) { toast(e.message, true); }
});
$('agent-sys-save').addEventListener('click', async function () {
  try {
    await post('/agent/personality', { session: AGENT.session, text: $('agent-sys-text').value });
    toast('系统指令已保存（下一轮生效）');
    $('agent-syseditor').style.display = 'none';
  } catch (e) { toast(e.message, true); }
});
$('agent-sys-close').addEventListener('click', function () { $('agent-syseditor').style.display = 'none'; });
$('agent-input').addEventListener('input', function () {
  agentSkillsCache().then(function () { agentMentionUpdate(); });
});
refresh(); loadSettings(); loadRules(); loadPrompts(); agentInit();
</script>
</body>
</html>`;
