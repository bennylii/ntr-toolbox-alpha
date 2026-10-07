// daemon/ui.mjs —— 本地控制台（零依赖单页：左侧栏 + 居中对话 + 底部输入，OpenWebUI 观感）
// server.mjs 在 GET /ui 提供本页；页面只调 daemon 的 HTTP 接口。
//
// 下面这组 markdown 函数刻意定义在模板字面量之外：模板内的内嵌脚本会被吃掉未双写的 \s/\n 转义，
// 而这里可以正常写正则；再由 ${MD_SOURCE} 把同一份实现（toString）内联进页面，不维护两份代码，
// 且 daemon-test 可以直接 import 它们做纯函数单测。

// 文本转义（只保留安全实体；所有进 HTML 的原文都要过这里）
export function mdEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 行内语法：代码 span（先摘出）→ 显式链接 → 裸 URL → 粗体 → 斜体；全部只对已转义文本操作
export function mdInline(text) {
  const stash = [];
  const keep = (html) => '\u0001' + (stash.push(html) - 1) + '\u0001';
  let s = mdEsc(text);
  s = s.replace(/`([^`]+)`/g, (m, code) => keep('<code>' + code + '</code>'));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, href) => keep('<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>'));
  s = s.replace(/\[([^\]]+)\]\([^)\s]*\)/g, (m, label) => label);   // 非 http(s) 目标：只留文字，不给链接
  s = s.replace(/(^|[\s(（【])(https?:\/\/[^\s<)】）]+)/g, (m, pre, href) => {
    const tail = /([。，、；：！？）】”"'.。,;:!?)\]]+)$/.exec(href);
    const url = tail ? href.slice(0, href.length - tail[1].length) : href;
    return pre + keep('<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>') + (tail ? tail[1] : '');
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s.replace(/\u0001(\d+)\u0001/g, (m, i) => stash[Number(i)]);
}

// 围栏代码块（语言标签 + 复制按钮；页面里有 [data-copy] 委派监听）
export function mdCodeBlock(lang, code) {
  const label = String(lang || '').replace(/[^\w+#.-]/g, '').slice(0, 20) || 'text';
  return '<div class="code-block"><div class="code-head"><span>' + label + '</span>' +
    '<button class="icon-btn cp" type="button" data-copy>复制</button></div>' +
    '<pre class="code-body">' + mdEsc(code) + '</pre></div>';
}

export function mdCells(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// 极简 markdown → 安全 HTML（块级：围栏/标题/分割线/引用/列表/表格/段落；未闭合围栏按已解析部分渲染）
export function renderMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const blank = (s) => s.trim() === '';
  const notPara = (s) => /^\s*(?:```|~~~)/.test(s) || /^\s*#{1,6}\s+/.test(s) || /^\s*>\s?/.test(s)
    || /^\s*[-*+]\s+/.test(s) || /^\s*\d+[.)]\s+/.test(s) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(s);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(?:```|~~~)(.*)$/.exec(line);
    if (fence) {
      const lang = String(fence[1] || '').trim().split(/\s+/)[0] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1;
      out.push(mdCodeBlock(lang, buf.join('\n')));
      continue;
    }
    if (blank(line)) { i += 1; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }
    const head = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const lv = Math.min(4, head[1].length);
      out.push('<h' + lv + '>' + mdInline(head[2].trim()) + '</h' + lv + '>');
      i += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push('<blockquote>' + renderMarkdown(buf.join('\n')) + '</blockquote>');
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (ordered || /^\s*[-*+]\s+/.test(line)) {
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (i < lines.length && re.test(lines[i])) { items.push(lines[i].replace(re, '')); i += 1; }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + items.map((t) => '<li>' + mdInline(t) + '</li>').join('') + '</' + tag + '>');
      continue;
    }
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && lines[i + 1].indexOf('-') >= 0 && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const cells = mdCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].indexOf('|') >= 0 && !blank(lines[i])) { rows.push(mdCells(lines[i])); i += 1; }
      out.push('<table><thead><tr>' + cells.map((c) => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const para = [];
    while (i < lines.length && !blank(lines[i]) && !notPara(lines[i])) { para.push(lines[i]); i += 1; }
    if (para.length === 0) { para.push(line); i += 1; }   // 兜底：保证推进
    out.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
  }
  return out.join('');
}

const MD_SOURCE = [mdEsc, mdInline, mdCodeBlock, mdCells, renderMarkdown].map((f) => f.toString()).join('\n');

export const UI_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NTR Daemon 控制台</title>
<style>
  /* ---- 主题 token（暗色，纯灰体系；亮色后续可加） ---- */
  :root {
    color-scheme: dark;
    --bg: #171717; --bg2: #0d0d0d; --panel: #1f1f1f; --panel2: #2b2b2b;
    --border: #2e2e2e; --border2: #3d3d3d;
    --text: #ececec; --muted: #a3a3a3; --faint: #7c7c7c;
    --accent: #3b82f6; --accent2: #2563eb;
    --bubble: #333333;
    --ok: #6ee7a8; --bad: #f87171; --warn: #fbbf24;
    --radius: 14px; --radius-lg: 16px; --radius-xl: 24px;
    --col: 58rem;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 15px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); }
  .app { display: flex; height: 100vh; overflow: hidden; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  ::-webkit-scrollbar { width: .45rem; height: .45rem; }
  ::-webkit-scrollbar-thumb { background: rgba(130,130,130,.5); border-radius: 999px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(170,170,170,.7); }
  ::-webkit-scrollbar-track { background: transparent; }

  /* ---- 侧栏 ---- */
  .side { width: 260px; min-width: 260px; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px; font-weight: 600; font-size: 14px; letter-spacing: .2px; }
  .brand .logo { width: 26px; height: 26px; border-radius: 9px; background: linear-gradient(135deg, var(--accent), #8b5cf6); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; color: #fff; }
  .side nav { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; }
  .side nav button { all: unset; cursor: pointer; padding: 7px 10px; border-radius: 10px; color: var(--muted); font-size: 13.5px; display: flex; align-items: center; gap: 9px; }
  .side nav button:hover { background: #1c1c1c; color: var(--text); }
  .side nav button.active { background: var(--panel2); color: var(--text); }
  .side nav button .ico { width: 18px; text-align: center; opacity: .9; }
  .side .divider { height: 1px; background: var(--border); margin: 8px 12px; }
  .side .side-title { padding: 2px 14px 6px; font-size: 11px; color: var(--faint); letter-spacing: .8px; }
  #side-sessions { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
  .sess-row { all: unset; cursor: pointer; display: block; padding: 6px 10px; border-radius: 10px; font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sess-row:hover { background: #1c1c1c; color: var(--text); }
  .sess-row.active { background: var(--panel2); color: var(--text); }
  .sess-row .sess-when { color: var(--faint); font-size: 11px; }
  .sess-row .sess-dot { display: inline-block; width: 6px; height: 6px; border-radius: 999px; background: var(--accent); margin-left: 6px; vertical-align: middle; }
  .sess-group { padding: 10px 10px 3px; font-size: 11px; color: var(--faint); letter-spacing: .4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .side-foot { padding: 9px 14px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--faint); }

  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .topbar { display: flex; align-items: center; gap: 14px; padding: 9px 18px; border-bottom: 1px solid var(--border); background: var(--bg2); }
  .topbar h1 { font-size: 14.5px; margin: 0; font-weight: 600; }
  .topbar .hdr { margin-left: auto; font-size: 12px; color: var(--faint); }
  .content { flex: 1; overflow-y: auto; padding: 18px 22px 60px; }
  .page { max-width: 920px; margin: 0 auto; display: none; }
  .page.active { display: block; }

  /* ---- 表单与通用控件（其它页共用） ---- */
  .proj-card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); padding: 10px 14px; margin: 8px 0; cursor: pointer; }
  .proj-card:hover { border-color: var(--border2); }
  .proj-card.current { border-color: var(--accent); background: #1c1c1c; }
  .proj-actions { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
  .proj-detail { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 8px; font-size: 12.5px; cursor: default; }
  .proj-detail table { font-size: 12px; }
  fieldset { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); margin: 0 0 14px; padding: 12px 16px 16px; }
  legend { color: var(--muted); font-size: 12px; padding: 0 6px; }
  label { display: inline-flex; gap: 6px; align-items: center; margin: 4px 14px 4px 0; color: var(--text); }
  input[type=text], input[type=number], input[type=password], textarea, select { background: #131313; color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; font: inherit; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #4a4a4a; box-shadow: 0 0 0 2px rgba(59,130,246,.22); }
  input[type=number] { width: 96px; }
  textarea { width: 100%; min-height: 90px; box-sizing: border-box; }
  .btn { background: var(--accent2); border: 1px solid var(--accent); color: #fff; border-radius: 10px; padding: 6px 14px; cursor: pointer; font: inherit; }
  .btn:hover { filter: brightness(1.12); }
  .btn.ghost { background: #1c1c1c; border-color: var(--border); color: var(--text); }
  .btn.ghost:hover { background: #242424; filter: none; }
  .btn.danger { background: #3a1d1d; border-color: #7f3a3a; color: #ffb4b4; }
  .btn:disabled { opacity: .45; cursor: default; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; border-bottom: 1px solid var(--border); padding: 6px 8px; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  .muted { color: var(--muted); font-size: 12px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  code { background: #232323; padding: 1px 5px; border-radius: 6px; }
  pre { font-family: ui-monospace, Consolas, monospace; }

  /* ---- 助手页（会话） ---- */
  .agent-page { max-width: none; width: 100%; margin: 0; display: none; flex-direction: column; height: calc(100vh - 51px); }
  .agent-page.active { display: flex; }
  .agent-top { display: flex; align-items: center; gap: 8px; padding: 9px 18px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .agent-top .spacer { flex: 1; }
  .agent-title { font-size: 13.5px; color: var(--text); max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
  .chat { flex: 1; overflow-y: auto; padding: 20px 14px 10px; display: flex; flex-direction: column; gap: 12px; }
  .chat > * { width: 100%; max-width: var(--col); margin-left: auto; margin-right: auto; }
  .msg { display: flex; animation: nta-fade .18s ease-out; }
  .msg.user { justify-content: flex-end; }
  .msg.user .bubble { background: var(--bubble); border-radius: var(--radius-xl) var(--radius-xl) 8px var(--radius-xl); padding: 9px 15px; max-width: 78%; word-break: break-word; }
  .msg.assistant { flex-direction: column; gap: 6px; }
  .msg.assistant .content { word-break: break-word; }
  .msg.system { color: var(--muted); font-size: 12.5px; white-space: pre-wrap; }
  .msg-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--faint); min-height: 16px; }
  .msg-actions { display: flex; gap: 2px; opacity: 0; transition: opacity .15s; }
  .msg:hover .msg-actions, .msg.assistant:last-child .msg-actions { opacity: 1; }
  .icon-btn { all: unset; cursor: pointer; padding: 2px 7px; border-radius: 8px; font-size: 11.5px; color: var(--faint); }
  .icon-btn:hover { background: #262626; color: var(--text); }
  .cursor { display: inline-block; width: 2px; height: 15px; margin-left: 3px; vertical-align: text-bottom; background: #9a9a9a; animation: nta-pulse 1.1s ease-in-out infinite; }
  @keyframes nta-pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
  @keyframes nta-fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }

  /* 消息内 markdown（.md 容器） */
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0 0 8px; }
  .md h1, .md h2, .md h3, .md h4 { margin: 12px 0 6px; font-weight: 600; line-height: 1.35; }
  .md h1 { font-size: 19px; } .md h2 { font-size: 17px; } .md h3 { font-size: 15.5px; } .md h4 { font-size: 15px; }
  .md ul, .md ol { margin: 6px 0; padding-left: 22px; }
  .md li { margin: 2px 0; }
  .md blockquote { margin: 8px 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--border2); color: var(--muted); }
  .md hr { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
  .md table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin: 8px 0; }
  .md th, .md td { border: 1px solid var(--border); padding: 5px 9px; text-align: left; }
  .md th { background: #1c1c1c; color: var(--muted); font-weight: 500; }
  .md code { background: #2a2a2a; padding: 1px 5px; border-radius: 6px; font-size: .88em; font-family: ui-monospace, Consolas, monospace; }
  .code-block { border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; margin: 8px 0; background: #131313; }
  .code-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 11.5px; color: var(--faint); border-bottom: 1px solid var(--border); }
  .code-head .cp { margin-left: auto; }
  .code-body { margin: 0; padding: 10px 12px; overflow: auto; font-size: 12.8px; line-height: 1.55; font-family: ui-monospace, Consolas, monospace; white-space: pre; }

  /* 工具调用卡（.tool 为 e2e 契约） */
  .tool { border: 1px solid var(--border); border-radius: var(--radius-lg); background: #1a1a1a; overflow: hidden; }
  .tool + .tool { margin-top: 3px; }
  .tool summary { cursor: pointer; padding: 7px 12px; font-size: 12.5px; color: var(--muted); list-style: none; display: flex; align-items: center; gap: 8px; }
  .tool summary::-webkit-details-marker { display: none; }
  .tool summary::before { content: '▸'; color: var(--faint); font-size: 10px; }
  .tool[open] summary::before { content: '▾'; }
  .tool .t-name { color: var(--text); }
  .tool .st { font-size: 11px; } .tool .st.ok { color: var(--ok); } .tool .st.bad { color: var(--warn); } .tool .st.run { color: var(--faint); }
  .tool .tool-body { margin: 0; padding: 0 12px 10px; font-size: 12.3px; color: var(--muted); }
  .tool .tool-sec { margin-top: 6px; }
  .tool .tool-sec > b { color: var(--faint); font-weight: 500; font-size: 11px; letter-spacing: .4px; }
  .tool .tool-pre { margin: 4px 0 0; padding: 8px 10px; background: #131313; border: 1px solid var(--border); border-radius: 10px; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .tool .tool-sec .cp { float: right; }

  /* 审批 / 追问 */
  .decision { border: 1px solid #4a4126; border-radius: var(--radius-lg); background: #1c1913; padding: 12px 14px; margin: 8px 0; max-width: var(--col); margin-left: auto; margin-right: auto; }
  .decision .d-title { font-weight: 600; margin-bottom: 4px; font-size: 14px; }
  .decision .d-sub { color: var(--faint); font-size: 12px; margin-bottom: 6px; }
  .decision pre { max-height: 220px; overflow: auto; background: #131313; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--muted); margin: 6px 0; }
  .decision .d-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .decision input[type=text] { flex: 1; min-width: 160px; }
  .decision .raw { border: 1px solid var(--border); border-radius: 12px; background: #131313; padding: 6px 10px; margin-top: 6px; }
  .decision .raw summary { cursor: pointer; color: var(--faint); font-size: 11.5px; }
  .decision .raw pre { margin: 6px 0 0; max-height: 200px; }
  .doing { min-height: 16px; font-size: 12px; color: var(--warn); padding: 0 16px; max-width: var(--col); margin: 0 auto; width: 100%; }

  /* 输入区 */
  .composer-wrap { position: relative; border-top: 1px solid var(--border); padding: 10px 14px 14px; }
  .composer { max-width: var(--col); margin: 0 auto; display: flex; gap: 8px; align-items: flex-end; background: #1c1c1c; border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 8px 8px 8px 14px; }
  .composer:focus-within { border-color: #4a4a4a; box-shadow: 0 0 0 2px rgba(59,130,246,.2); }
  .composer textarea { flex: 1; resize: none; border: 0; background: transparent; padding: 6px 0; min-height: 26px; max-height: 200px; overflow-y: auto; }
  .composer textarea:focus { box-shadow: none; }
  .composer .send { all: unset; cursor: pointer; flex: 0 0 auto; width: 34px; height: 34px; border-radius: 999px; background: #fff; color: #111; display: flex; align-items: center; justify-content: center; font-size: 15px; }
  .composer .send:hover { background: #e2e2e2; }
  .composer .send:disabled { background: #2f2f2f; color: #777; cursor: default; }
  .scroll-bottom { position: absolute; left: 50%; transform: translateX(-50%); bottom: 10px; cursor: pointer; border: 1px solid var(--border2); background: rgba(32,32,32,.94); color: var(--text); border-radius: 999px; padding: 5px 12px; font-size: 12px; z-index: 6; }
  .scroll-bottom:hover { background: #2e2e2e; }

  /* 空态 */
  .empty-hero { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; margin-top: 7vh; animation: nta-fade .25s ease-out; }
  .empty-hero .eh-logo { width: 46px; height: 46px; border-radius: 15px; background: linear-gradient(135deg, var(--accent), #8b5cf6); display: flex; align-items: center; justify-content: center; font-size: 20px; color: #fff; }
  .empty-hero h2 { margin: 0; font-size: 21px; font-weight: 600; }
  .empty-hero p { margin: 0; color: var(--muted); font-size: 13px; }
  .suggest { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 620px; margin-top: 6px; }
  .sug { cursor: pointer; border: 1px solid var(--border); background: #1a1a1a; color: var(--muted); border-radius: 999px; padding: 6px 12px; font-size: 12.5px; }
  .sug:hover { color: var(--text); border-color: var(--border2); background: #222; }

  /* @技能 / /命令 候选（.mi/.sel 为 e2e 契约） */
  .mention { position: absolute; bottom: 100%; left: 14px; right: 14px; max-width: var(--col); margin: 0 auto 6px; max-height: 240px; overflow: auto; background: #202020; border: 1px solid var(--border2); border-radius: var(--radius); box-shadow: 0 10px 30px rgba(0,0,0,.45); z-index: 7; }
  .mention .mi { padding: 7px 12px; font-size: 12.5px; cursor: pointer; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mention .mi.sel, .mention .mi:hover { background: #2f2f2f; color: var(--text); }
  .syseditor { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); padding: 10px 12px; margin: 8px 14px 0; max-width: var(--col); margin-left: auto; margin-right: auto; }
  .syseditor textarea { min-height: 70px; }
  #toast { position: fixed; right: 16px; bottom: 16px; background: #262626; border: 1px solid var(--border2); color: var(--text); padding: 8px 14px; border-radius: 12px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 60vw; z-index: 9; font-size: 13px; }
  #toast.show { opacity: 1; }

  /* ---- 窄窗口自适应（半屏/小窗；超窄时侧栏只留图标） ---- */
  @media (max-width: 900px) {
    .side { width: 200px; min-width: 200px; }
    .side nav button { font-size: 13px; padding: 6px 9px; }
    .content { padding: 14px 14px 40px; }
  }
  @media (max-width: 700px) {
    .side { width: 62px; min-width: 62px; }
    .brand { font-size: 0; justify-content: center; padding: 12px 6px; }
    .brand .logo { font-size: 14px; }
    .side > div[style] { display: none; }
    .side nav button { font-size: 0; gap: 0; justify-content: center; padding: 9px 0; }
    .side nav button .ico { font-size: 16px; width: auto; }
    .side .divider, .side-title, #side-sessions, .side-foot { display: none; }
    .agent-page { height: calc(100vh - 47px); }
    .agent-top { padding: 8px 10px; }
    .agent-title { max-width: 100%; }
    .chat { padding: 14px 10px 8px; }
    .composer-wrap { padding: 8px 10px 10px; }
    .mention { left: 10px; right: 10px; }
    .syseditor { margin-left: 10px; margin-right: 10px; }
  }
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
      <span class="agent-title" id="agent-title"></span>
      <span class="spacer"></span>
      <span class="muted" id="agent-status"></span>
      <button class="btn ghost" id="agent-sys">系统指令</button>
      <button class="btn danger" id="agent-stop" disabled>停止</button>
    </div>
    <div class="chat-wrap">
      <div id="agent-log" class="chat"></div>
      <button class="scroll-bottom" id="agent-bottom" style="display: none">↓ 回到底部</button>
    </div>
    <div id="agent-decision" class="decision" style="display: none"></div>
    <div id="agent-doing" class="doing"></div>
    <div class="composer-wrap">
      <div id="agent-mention" class="mention" style="display: none"></div>
      <div class="composer">
        <textarea id="agent-input" rows="1" placeholder="给助手发消息（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="send" id="agent-send" title="发送（Enter）">↑</button>
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
    <fieldset><legend>网络代理（出网 · 站点与模型接口统一走代理；保存后立即生效）</legend>
      <label><input type="checkbox" id="proxy-enable"> 启用代理</label>
      <label>代理地址 <input type="text" id="proxy-url" size="40" placeholder="http://127.0.0.1:6789"></label>
      <label>直连列表 <input type="text" id="proxy-noproxy" size="44" placeholder="127.0.0.1,localhost,::1"></label>
      <div><button class="btn" id="proxy-save">保存代理设置</button> <button class="btn ghost" id="proxy-test">测试（对比直连 / 代理）</button></div>
      <div class="muted" style="margin-top:6px">站点被墙时填本机代理（只支持 http/https，不支持 SOCKS5）；直连列表内的主机不经代理（默认含回环，本机 mock / 测试不受影响）。工作区脚本出网同样走此代理。</div>
      <div class="muted" id="proxy-info" style="margin-top:6px"></div>
    </fieldset>
  </div>

  <div class="page" id="tab-rules" data-title="规则">
    <fieldset><legend>内置保护预设（text_preserve · 对齐 LG 预设库；base 恒用，其余按需叠加）</legend>
      <label>预设层 <select id="preset-select"><option value="base">base</option></select></label>
      <button class="btn ghost" id="preset-save">保存预设</button>
      <div class="muted" id="preset-hint" style="margin-top:4px"></div>
    </fieldset>
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
${MD_SOURCE}
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
  const warnings = await api('/warnings?book=' + encodeURIComponent(key) + '&limit=20').catch(() => null);
  const rows = (prog && prog.progress) || [];
  const byState = {};
  rows.forEach((p) => { byState[p.state] = (byState[p.state] || 0) + 1; });
  const ruleCount = ((rules && rules.rules) || []).filter((r) => (r.bookKey || '') === key).length;
  const sessList = ((sessions && sessions.sessions) || []).filter((x) => (x.bookKey || '') === key);
  const recent = (STATE.runs || []).filter((r) => r.bookKey === key).slice(0, 3)
    .map((r) => esc(r.job + '/' + r.state)).join('、') || '—';
  const warnSummary = (warnings && warnings.summary) || null;
  const warnRows = (warnings && warnings.warnings) || [];
  const warnLine = warnSummary && warnSummary.total > 0
    ? '<div>质检警告 ' + warnSummary.total + ' 条（' + Object.entries(warnSummary.counts).map(([c, n]) => esc(c) + ' ' + n).join(' / ') + '）'
      + (warnSummary.at ? ' · ' + new Date(warnSummary.at).toLocaleString() : '') + '</div>'
    : '<div class="muted">质检警告：暂无（跑一次「派发任务 → 质检 check」后更新）</div>';
  box.innerHTML =
    '<div>进度：' + rows.length + ' 章' + (Object.keys(byState).length ? '（' + Object.keys(byState).map((s) => esc(s) + ' ' + byState[s]).join(' / ') + '）' : '') + ' · 最近 run：' + recent + '</div>' +
    '<div>本项目规则覆盖 ' + ruleCount + ' 条 · 助手会话 ' + sessList.length + ' 个</div>' +
    warnLine +
    (warnRows.length ? '<table><tr><th>章节</th><th>行</th><th>码</th><th>细节</th></tr>' +
      warnRows.slice(0, 20).map((w) => '<tr><td>' + esc(w.chapterId) + '</td><td>' + w.lineNo + '</td><td>' + esc(w.code) + '</td><td class="muted">' + esc(w.detail || '') + '</td></tr>').join('') + '</table>' : '') +
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
        ' · ' + (ls.workersCount == null ? '?' : ls.workersCount) + ' 个翻译器' + (ls.mode ? ' · ' + (ls.mode === 'auto' ? '自动' : '手动') : '')
        : '从未同步（站点页面点「Daemon 连接」，或开着页面等自动同步）');
    const px = (s.settings && s.settings.proxy) || {};
    $('proxy-enable').checked = px.enabled === true;
    $('proxy-url').value = px.url || '';
    $('proxy-noproxy').value = px.noProxy || '127.0.0.1,localhost,::1';
    $('proxy-info').textContent = px.enabled && px.url
      ? ('当前：经 ' + px.url + ' 出网 · 直连 ' + (px.noProxy || '—'))
      : '当前：全部直连（代理未启用）';
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
$('proxy-save').addEventListener('click', async () => {
  try {
    await post('/settings', { proxy: {
      enabled: $('proxy-enable').checked,
      url: $('proxy-url').value.trim(),
      noProxy: $('proxy-noproxy').value.trim(),
    } });
    toast('代理设置已保存并生效'); loadSettings();
  } catch (e) { toast(e.message, true); }
});
$('proxy-test').addEventListener('click', async () => {
  try {
    $('proxy-info').textContent = '测试中…（直连 / 代理，各 8s 超时）';
    const r = await post('/proxy/test', { proxy: {
      enabled: true,
      url: $('proxy-url').value.trim(),
      noProxy: $('proxy-noproxy').value.trim(),
    } });
    const fmt = (x) => (x && x.ok) ? ('HTTP ' + x.status + ' · ' + x.ms + 'ms') : ('失败：' + ((x && x.error) || '未知'));
    $('proxy-info').textContent = '目标 ' + r.target + ' → 直连：' + fmt(r.direct) + ' ／ 代理：' + fmt(r.proxied);
  } catch (e) { toast(e.message, true); }
});

async function loadRules() {
  try {
    const data = await api('/rules?book=' + encodeURIComponent(PROJECT));
    const tp = data.textPreserve || {};
    const counts = {};
    (tp.presets || []).forEach((p) => { counts[p.name] = p.count; });
    const sel = $('preset-select');
    if (sel) {
      sel.innerHTML = ['base', 'kag', 'renpy', 'rpgmaker', 'wolf', 'none'].map((n) =>
        '<option value="' + n + '"' + (n === (tp.preset || 'base') ? ' selected' : '') + '>' + n + (counts[n] ? '（' + counts[n] + ' 条）' : '') + '</option>').join('');
      $('preset-hint').textContent = '当前生效：' + (tp.preset || 'base') + '。预设条目为内置只读（不占规则表）；base 恒用，none = 完全关闭预设。';
    }
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
$('preset-save').addEventListener('click', async () => {
  try {
    await post('/settings', { textPreserve: { preset: $('preset-select').value } });
    toast('保护预设已保存并生效');
    loadRules();
  } catch (e) { toast(e.message, true); }
});
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
let AGENT = { session: localStorage.getItem('ntr-daemon-agent-session') || '', es: null, polling: null, messages: [], pending: null, running: false, usage: null, transport: '', sessionBook: '', sessionTitle: '', step: 0, nodes: new Map(), localCount: 0, pinned: true, lockScroll: false };
let lastSessions = [];
function agentLine(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }
function agentRelTime(at) {
  if (!at) return '';
  const diff = Date.now() - at;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}
function agentClock(at) {
  if (!at) return '';
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
function agentToolResult(tc) {
  return (AGENT.messages || []).find(function (x) { return x.role === 'tool' && x.toolCallId === tc.id; }) || null;
}
function agentCopyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
  ta.remove();
}
function agentCopy(text, btn) {
  const done = function () {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(function () { btn.textContent = old; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { agentCopyFallback(text); done(); });
    return;
  }
  agentCopyFallback(text); done();
}
document.addEventListener('click', function (e) {
  const t = e.target;
  const btn = t && t.closest ? t.closest('[data-copy]') : null;
  if (!btn) return;
  const host = btn.closest('.code-block') || btn.closest('.tool-sec') || btn.closest('.msg');
  const pre = host ? host.querySelector('pre') : null;
  agentCopy(pre ? pre.textContent : (btn.dataset.copy || ''), btn);
});
const AGENT_SUGGESTIONS = [
  '盘点这本书的术语落地情况，列出未落地清单',
  '跑一次质检，汇总七码分布',
  '整理术语表（先给提案，不要直接写）',
  '看看最近一次翻译 run 的失败章节',
];
function agentEmptyHero() {
  const wrap = document.createElement('div'); wrap.className = 'empty-hero';
  const logo = document.createElement('div'); logo.className = 'eh-logo'; logo.textContent = '◆';
  const h = document.createElement('h2'); h.textContent = '要做什么？';
  const p = document.createElement('p'); p.textContent = '让助手查书、跑质检、整理术语表，或改规则与提示词；@技能名 可点名技能，/help 看命令。';
  const sug = document.createElement('div'); sug.className = 'suggest';
  AGENT_SUGGESTIONS.forEach(function (text) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sug'; b.textContent = text;
    b.addEventListener('click', function () { const input = $('agent-input'); input.value = text; input.focus(); agentGrowInput(); });
    sug.appendChild(b);
  });
  wrap.appendChild(logo); wrap.appendChild(h); wrap.appendChild(p); wrap.appendChild(sug);
  return wrap;
}
function agentEnsureHero(show) {
  const box = $('agent-log');
  const hero = AGENT.nodes.get('hero');
  if (show && !hero) { const node = agentEmptyHero(); AGENT.nodes.set('hero', node); box.appendChild(node); return; }
  if (!show && hero) { hero.remove(); AGENT.nodes.delete('hero'); }
}
function agentToolSec(title, text) {
  const sec = document.createElement('div'); sec.className = 'tool-sec';
  const label = document.createElement('b'); label.textContent = title;
  const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'icon-btn cp'; cp.textContent = '复制'; cp.dataset.copy = text;
  const pre = document.createElement('pre'); pre.className = 'tool-pre'; pre.textContent = String(text).slice(0, 4000);
  sec.appendChild(label); sec.appendChild(cp); sec.appendChild(pre);
  return sec;
}
function agentToolCard(tc) {
  const result = agentToolResult(tc);
  const okFlag = result ? /"ok"[\s]*:[\s]*true/.test(String(result.content || '')) : false;
  const card = document.createElement('details'); card.className = 'tool';
  const summary = document.createElement('summary');
  const name = document.createElement('span'); name.className = 't-name'; name.textContent = '🛠 ' + tc.name;
  const state = document.createElement('span'); state.className = 'st ' + (result ? (okFlag ? 'ok' : 'bad') : 'run');
  state.textContent = result ? (okFlag ? '● 完成' : '● 有异常') : '● 执行中';
  summary.appendChild(name); summary.appendChild(state);
  card.appendChild(summary);
  const body = document.createElement('div'); body.className = 'tool-body';
  body.appendChild(agentToolSec('参数', String(tc.argsRaw || JSON.stringify(tc.args || {}, null, 2))));
  if (result) body.appendChild(agentToolSec('结果', String(result.content || '')));
  card.appendChild(body);
  return card;
}
function agentMsgSig(m) {
  if (m.role === 'assistant') {
    const tools = (m.toolCalls || []).map(function (tc) {
      const r = agentToolResult(tc);
      return tc.name + ':' + String(tc.argsRaw || '').length + ':' + (r ? String(r.content || '').length : -1);
    }).join(',');
    return 'a|' + String(m.content || '').length + '|' + tools;
  }
  return m.role + '|' + String(m.content || '').length;
}
function agentBuildMsg(m) {
  if (m.role === 'user') {
    const row = document.createElement('div'); row.className = 'msg user';
    const bubble = document.createElement('div'); bubble.className = 'bubble md';
    bubble.innerHTML = renderMarkdown(m.content || '');
    row.appendChild(bubble);
    return row;
  }
  if (m.role === 'assistant') {
    const row = document.createElement('div'); row.className = 'msg assistant';
    const meta = document.createElement('div'); meta.className = 'msg-meta';
    const toks = m.usage ? ((m.usage.promptTokens || 0) + (m.usage.completionTokens || 0)) : 0;
    const label = document.createElement('span');
    label.textContent = '助手' + (m.at ? ' · ' + agentClock(m.at) : '') + (toks ? ' · ' + toks + ' tok' : '');
    meta.appendChild(label);
    const acts = document.createElement('div'); acts.className = 'msg-actions';
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'icon-btn'; cp.textContent = '复制';
    cp.dataset.copy = String(m.content || '');
    acts.appendChild(cp);
    meta.appendChild(acts);
    row.appendChild(meta);
    if (m.content) { const content = document.createElement('div'); content.className = 'content md'; content.innerHTML = renderMarkdown(m.content); row.appendChild(content); }
    (m.toolCalls || []).forEach(function (tc) { row.appendChild(agentToolCard(tc)); });
    return row;
  }
  return agentLine('msg system', '工具结果：' + String(m.content || '').slice(0, 200));
}
// 按 seq 做增量 diff：只重建内容变化的消息（保住滚动位置、<details> 展开态与悬停按钮）
function renderAgentMessages(reset) {
  const box = $('agent-log');
  if (reset) { box.innerHTML = ''; AGENT.nodes = new Map(); AGENT.localCount = 0; }
  const seen = {};
  (AGENT.messages || []).forEach(function (m) {
    const key = String(m.seq);
    seen[key] = true;
    const sig = agentMsgSig(m);
    const node = AGENT.nodes.get(key);
    if (!node) {
      const fresh = agentBuildMsg(m); fresh.dataset.sig = sig;
      AGENT.nodes.set(key, fresh); box.appendChild(fresh);
    } else if (node.dataset.sig !== sig) {
      const fresh = agentBuildMsg(m); fresh.dataset.sig = sig;
      node.replaceWith(fresh); AGENT.nodes.set(key, fresh);
    }
  });
  AGENT.nodes.forEach(function (node, key) {
    const k = String(key);
    if (k === 'hero' || k.charAt(0) === 'l') return;   // 空态与本地行各自管理
    if (!seen[k]) { node.remove(); AGENT.nodes.delete(key); }
  });
  agentEnsureHero((AGENT.messages || []).length === 0 && AGENT.localCount === 0);
  agentSyncCursor();
  agentMaybeScroll();
}
function agentSyncCursor() {
  const box = $('agent-log');
  const old = box.querySelector('.cursor');
  if (old) old.remove();
  if (!AGENT.running) return;
  const rows = box.querySelectorAll('.msg.assistant');
  const last = rows[rows.length - 1];
  if (!last) return;
  const cursor = document.createElement('span'); cursor.className = 'cursor';
  (last.querySelector('.content') || last).appendChild(cursor);
}
function agentAtBottom() { const box = $('agent-log'); return box.scrollHeight - box.scrollTop - box.clientHeight < 80; }
function agentShowBottom(show) { const b = $('agent-bottom'); if (b) b.style.display = show ? 'block' : 'none'; }
// 程序化滚动后内容可能继续撑高（代码块/字体落位），下一帧再对齐一次；期间忽略 scroll 事件，避免误判成"用户上翻"
function agentScrollBottom() {
  const box = $('agent-log');
  AGENT.pinned = true; agentShowBottom(false);
  AGENT.lockScroll = true;
  box.scrollTop = box.scrollHeight;
  requestAnimationFrame(function () {
    if (AGENT.pinned) box.scrollTop = box.scrollHeight;   // 期间用户上翻/被冻结则不再回拉
    setTimeout(function () { AGENT.lockScroll = false; }, 80);
  });
}
function agentMaybeScroll() { if (AGENT.pinned) agentScrollBottom(); else agentShowBottom(true); }
function agentGrowInput() {
  const t = $('agent-input');
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.min(200, Math.max(26, t.scrollHeight)) + 'px';
}
function renderAgentDecision() {
  const panel = $('agent-decision');
  const d = AGENT.pending;
  if (!d) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
  panel.style.display = 'block';
  panel.innerHTML = '';
  const payload = d.payload || {};
  const preview = payload.preview || {};
  panel.appendChild(agentLine('d-title', d.kind === 'write' ? '需要审批' : '需要回答'));
  const subText = [payload.tool ? '工具 ' + payload.tool : '', String(preview.action || '')].filter(function (x) { return x !== ''; }).join(' · ');
  if (subText) panel.appendChild(agentLine('d-sub', subText));
  const previewText = typeof preview === 'string' ? preview : String(preview.diff || preview.text || preview.summary || '');
  if (previewText) { const pre = document.createElement('pre'); pre.textContent = previewText.slice(0, 4000); panel.appendChild(pre); }
  const raw = document.createElement('details'); raw.className = 'raw';
  const rawHead = document.createElement('summary'); rawHead.textContent = '原始 payload';
  raw.appendChild(rawHead);
  const rawBody = document.createElement('pre'); rawBody.textContent = JSON.stringify(payload, null, 2);
  raw.appendChild(rawBody);
  panel.appendChild(raw);
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
    (AGENT.running && AGENT.step ? '（第 ' + AGENT.step + ' 步）' : '') +
    ' · 请求 ' + (AGENT.usage ? AGENT.usage.requests : 0) +
    ' · tokens ' + (AGENT.usage ? (AGENT.usage.promptTokens + AGENT.usage.completionTokens) : 0) +
    pj +
    (AGENT.transport ? ' · ' + AGENT.transport : '');
}
function agentSyncTitle() {
  const el = $('agent-title');
  if (!el) return;
  el.textContent = AGENT.session ? (AGENT.sessionTitle || '未命名会话') : '未选择会话';
  el.title = AGENT.sessionBook ? ('项目 ' + AGENT.sessionBook) : '';
}
async function agentSnapshot() {
  if (!AGENT.session) return;
  const data = await api('/agent/snapshot?session=' + encodeURIComponent(AGENT.session));
  AGENT.messages = data.messages || [];
  AGENT.pending = data.pendingDecision || null;
  AGENT.running = !!data.running;
  AGENT.usage = data.usage || null;
  AGENT.sessionBook = (data.session && data.session.bookKey) || '';
  AGENT.sessionTitle = (data.session && data.session.title) || AGENT.sessionTitle;
  if (!AGENT.running) AGENT.step = 0;
  AGENT.transport = '在线';
  agentSyncTitle();
  renderAgentMessages(); renderAgentDecision(); renderAgentStatus();
  $('agent-send').disabled = AGENT.running;
  $('agent-stop').disabled = !AGENT.running;
}
async function agentRefresh() { try { await agentSnapshot(); } catch (e) { AGENT.transport = '离线：' + e.message; renderAgentStatus(); } }
function agentSetSession(id) {
  AGENT.session = id || '';
  if (id) localStorage.setItem('ntr-daemon-agent-session', id); else localStorage.removeItem('ntr-daemon-agent-session');
  AGENT.messages = []; AGENT.pending = null; AGENT.step = 0; AGENT.pinned = true;
  if (AGENT.es) { AGENT.es.close(); AGENT.es = null; }
  if (AGENT.polling) { clearInterval(AGENT.polling); AGENT.polling = null; }
  agentSyncTitle();
  renderAgentMessages(true);   // 换会话：整体重建，避免上一会话的节点残留
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
      if (ev.type === 'doing') { $('agent-doing').textContent = '进度：' + (ev.text || ''); return; }
      if (ev.type === 'step') { AGENT.step = Number(ev.step) || 0; renderAgentStatus(); return; }
      if (ev.type === 'turn_end') { AGENT.step = 0; }
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
      const when = agentRelTime(x.updatedAt);
      return '<div class="sess-row' + (x.id === AGENT.session ? ' active' : '') + '" data-sid="' + esc(x.id) + '" title="' + esc(String(x.title || x.id)) + '">' +
        esc(String(x.title || x.id).slice(0, 22)) +
        (when ? ' <span class="sess-when">' + esc(when) + '</span>' : '') +
        (x.running ? '<span class="sess-dot"></span>' : '') + '</div>';
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
    agentSyncTitle();
    if (AGENT.session) agentRefresh(); else { AGENT.localCount = 0; renderAgentMessages(true); }
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
  agentGrowInput();
  agentMentionClose();
  if (text.startsWith('/')) { agentCommand(text); return; }
  try {
    if (!AGENT.session) { const r = await post('/agent/session', { title: text.slice(0, 30), bookKey: PROJECT || '' }); agentSetSession(r.sessionId); }
    await post('/agent/message', { session: AGENT.session, message: text, approvalMode: $('agent-auto').checked ? 'auto' : 'manual' });
    $('agent-doing').textContent = '';
    AGENT.pinned = true;
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
  const key = 'l' + (AGENT.localCount += 1);
  const node = agentLine('msg system' + (cls ? ' ' + cls : ''), text);
  AGENT.nodes.set(key, node);
  agentEnsureHero(false);
  box.appendChild(node);
  agentScrollBottom();
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
$('agent-input').addEventListener('input', agentGrowInput);
window.addEventListener('resize', agentGrowInput);
$('agent-log').addEventListener('scroll', function () {
  if (AGENT.lockScroll) return;
  AGENT.pinned = agentAtBottom();
  agentShowBottom(!AGENT.pinned);
});
$('agent-bottom').addEventListener('click', agentScrollBottom);
agentGrowInput();
refresh(); loadSettings(); loadRules(); loadPrompts(); agentInit();
</script>
</body>
</html>`;
