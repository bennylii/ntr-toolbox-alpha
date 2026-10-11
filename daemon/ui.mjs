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
  /* ---- 主题 token：Windows 经典灰 + 扁平直角（浅色体系；经典 Windows 没有深色） ---- */
  :root {
    color-scheme: light;
    --face: #c0c0c0;        /* 面板/按钮面（经典 ButtonFace） */
    --face-hi: #d4d4d4;     /* hover 提亮 */
    --face-lo: #a8a8a8;     /* 按下加深 */
    --window: #ffffff;      /* 字段与内容白底 */
    --text: #000000;
    --muted: #5a5a5a;       /* 次要文字（经典 GrayText 在正文里偏浅，折中取深一档） */
    --faint: #808080;       /* 禁用/最弱 */
    --line: #808080;        /* 边框（ButtonShadow） */
    --title: #000080;       /* 纯 navy（保留备用；高亮已统一走 --hl） */
    --title-a: #0a246a;     /* VB6 / Office97 经典蓝渐变（窗口标题栏 + 侧栏页眉）：上端深蓝 */
    --title-b: #a6caf0;     /* …下端浅蓝 */
    --title-fg: #ffffff;
    --desk: #3a6ea5;        /* 经典蓝（只做装饰性底/缝隙用，不做大面积底色） */
    --hl: #000080;          /* 悬停 / 选中高亮（经典 ActiveTitle 藏青，白字） */
    --hl-soft: #d6e2f5;     /* 浅蓝：浅底高亮（表格行 hover 等） */
    --link: #0000ff;
    --ok: #006400; --bad: #800000; --warn: #7a5c00;
    --info: #ffffe1;        /* 经典提示条 InfoWindow */
    --code: #f0f0f0;
    --radius: 0; --radius-lg: 0; --radius-xl: 0;
    --col: 58rem;
    --topbar-h: 30px;
    --font: Tahoma, "MS Sans Serif", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    --mono: Consolas, "Courier New", monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 12px/1.5 var(--font); background: var(--desk); color: var(--text); }
  .app { display: flex; height: 100vh; overflow: hidden; }
  a { color: var(--link); text-decoration: underline; }
  ::-webkit-scrollbar { width: 16px; height: 16px; }
  ::-webkit-scrollbar-track { background: #dfdfdf; }
  ::-webkit-scrollbar-thumb { background: var(--face); border: 1px solid var(--line); }
  ::-webkit-scrollbar-thumb:hover { background: var(--face-hi); }
  ::-webkit-scrollbar-corner { background: var(--face); }

  /* ---- 侧栏（灰底，跟经典 Windows 一样；只有选中/悬停用青蓝） ---- */
  .side { width: 240px; min-width: 240px; background: var(--face); color: var(--text); border-right: 1px solid var(--line); display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-weight: 700; font-size: 12.5px; background: linear-gradient(180deg, var(--title-a) 0%, var(--title-a) 62%, var(--title-b) 100%); color: var(--title-fg); text-shadow: 0 1px 1px rgba(0,0,0,.5); }
  .brand .logo { width: 18px; height: 18px; background: var(--face); color: var(--title-a); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; border: 1px solid var(--title-fg); flex: 0 0 auto; }
  .side nav { display: flex; flex-direction: column; padding: 4px; }
  .side nav button { all: unset; cursor: pointer; padding: 4px 8px; color: var(--text); font-size: 12.5px; display: flex; align-items: center; gap: 7px; }
  .side nav button:hover, .side nav button.active { background: var(--hl); color: #ffffff; }
  .side nav button:focus-visible { outline: 1px dotted var(--text); outline-offset: -3px; }
  .side nav button .ico { width: 16px; text-align: center; font-family: "Segoe MDL2 Assets"; font-size: 13px; flex: 0 0 auto; }
  .side .divider { height: 0; border-top: 1px solid var(--line); border-bottom: 1px solid #dcdcdc; margin: 6px 4px; }
  .side .side-title { padding: 2px 8px 4px; font-size: 11px; color: var(--muted); }
  #side-sessions { flex: 1; overflow-y: auto; padding: 0 4px 6px; }
  .sess-row { cursor: pointer; display: flex; align-items: center; gap: 4px; padding: 3px 6px; font-size: 12px; color: var(--text); }
  .sess-row:hover, .sess-row.active { background: var(--hl); color: #ffffff; }
  .sess-row .sess-when { color: var(--faint); font-size: 10.5px; flex: 0 0 auto; }
  .sess-row:hover .sess-when, .sess-row.active .sess-when { color: #c8d4f0; }
  .sess-row .sess-dot { width: 6px; height: 6px; background: #0000c8; flex: 0 0 auto; }
  .sess-row:hover .sess-dot, .sess-row.active .sess-dot { background: #9ad0ff; }
  .sess-row .sess-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sess-ops { display: none; gap: 1px; flex: 0 0 auto; }
  .sess-row:hover .sess-ops, .sess-row.active .sess-ops { display: flex; }
  .sess-ops .icon-btn { font-size: 11px; padding: 0 4px; color: var(--muted); }
  .sess-ops .icon-btn:hover { background: var(--face-hi); border-color: var(--line); color: var(--text); }
  .sess-row:hover .sess-ops .icon-btn, .sess-row.active .sess-ops .icon-btn { color: #ffffff; }
  .sess-group { padding: 6px 8px 2px; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .side-foot { padding: 3px 8px; border-top: 1px solid var(--line); font-size: 11px; color: var(--text); background: var(--face); }

  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .topbar { display: flex; align-items: center; gap: 12px; height: var(--topbar-h); padding: 0 8px; background: linear-gradient(180deg, var(--title-a) 0%, var(--title-a) 62%, var(--title-b) 100%); color: var(--title-fg); }
  .topbar h1 { font-size: 12.5px; margin: 0; font-weight: 700; text-shadow: 0 1px 1px rgba(0,0,0,.45); }
  .topbar .hdr { margin-left: auto; font-size: 11px; color: #f0f6ff; text-shadow: 0 1px 1px rgba(0,0,0,.45); }
  /* 页面滚动容器；注意限定 .main > —— 助手消息正文也用 class="content"，别串味。
     both-edges：滚动条两侧对称预留，980px 的页面列在有无滚动条时都相对窗口居中（否则右边多 16px 死区、页面左偏 8px） */
  .main > .content { flex: 1; overflow-y: auto; padding: 10px 12px 40px; background: var(--face); scrollbar-gutter: stable both-edges; }
  /* 助手页：内容区让开内边距、滚动条与滚动条占位，交给助手页自己填满 */
  .main > .content.agent-active { padding: 0; overflow: hidden; scrollbar-gutter: auto; }
  .page { max-width: 980px; margin: 0 auto; display: none; }
  .page.active { display: block; }
  /* 页面开头直接挂的说明行：工作区已是灰底，够读，不再加背板 */
  .page > .muted { padding: 0; margin: 0 0 8px; }

  /* ---- 表单与通用控件（1px 描边 + 白底字段；无圆角） ---- */
  .proj-card { border: 1px solid var(--line); background: var(--window); padding: 6px 8px; margin: 6px 0; cursor: pointer; }
  .proj-card:hover { background: #eef2fc; }
  .proj-card.current { border-color: var(--hl); }
  .proj-card.current > div:first-child { background: var(--hl); color: var(--title-fg); margin: -6px -8px 4px; padding: 2px 8px; }
  .proj-actions { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
  .proj-detail { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 6px; font-size: 12px; cursor: default; }
  .proj-detail table { font-size: 11.5px; }
  fieldset { border: 1px solid var(--line); background: var(--face); margin: 0 0 10px; padding: 8px 10px 10px; }
  legend { font-size: 11.5px; padding: 0 4px; background: var(--face); color: var(--text); font-weight: 700; }
  label { display: inline-flex; gap: 5px; align-items: center; margin: 3px 12px 3px 0; }
  input[type=text], input[type=number], input[type=password], textarea, select { background: var(--window); color: var(--text); border: 1px solid var(--line); padding: 2px 4px; font: inherit; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--hl); }
  input[type=number] { width: 84px; }
  textarea { width: 100%; min-height: 72px; }
  .btn { background: var(--face); border: 1px solid var(--line); color: var(--text); padding: 2px 10px; min-height: 22px; cursor: pointer; font: inherit; }
  .btn:hover { background: var(--face-hi); }
  .btn:active { background: var(--face-lo); }
  .btn:focus-visible { outline: 1px dotted var(--text); outline-offset: -3px; }
  .btn.danger { color: var(--bad); }
  .btn.primary { background: var(--hl); border-color: var(--hl); color: var(--title-fg); }
  .btn.primary:hover { background: #007a7a; }
  .btn:disabled { color: var(--faint); cursor: default; background: var(--face); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; background: var(--window); }
  th, td { text-align: left; border: 1px solid var(--line); padding: 3px 6px; vertical-align: top; }
  th { background: var(--face); font-weight: 700; }
  tr:hover > td { background: var(--hl-soft); }
  .muted { color: var(--muted); font-size: 11.5px; }
  .ico-mdl { font-family: "Segoe MDL2 Assets"; font-style: normal; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  code { background: var(--code); padding: 0 3px; font-family: var(--mono); font-size: 11.5px; }
  pre { font-family: var(--mono); }

  /* ---- 助手页（经典会话窗口：白底工作区 + 反色高亮） ---- */
  .agent-page { max-width: none; width: 100%; margin: 0; display: none; flex-direction: column; height: 100%; }
  .agent-page.active { display: flex; }
  .agent-top { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .agent-top .spacer { flex: 1; }
  .agent-title { font-size: 12px; font-weight: 700; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-wrap { position: relative; flex: 1; min-height: 0; display: flex; padding: 6px 8px 0; background: var(--face); }
  /* both-edges：聊天区滚动条两侧对称预留，消息列才与窗口外的输入框/进度/审批面板永久对齐
     （否则滚动条一出现，居中的 928px 消息列就左移半个滚动条宽，输入框相对它右凸 8px） */
  .chat { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; background: var(--window); border: 1px solid var(--line); scrollbar-gutter: stable both-edges; }
  .chat > * { width: 100%; max-width: var(--col); margin-left: auto; margin-right: auto; }
  .msg { display: flex; gap: 6px; }
  .msg.user { justify-content: flex-end; align-items: flex-start; }
  .msg.user .bubble { background: #dbe4f8; border: 1px solid var(--line); padding: 4px 8px; max-width: 78%; word-break: break-word; }
  .msg.assistant { flex-direction: column; gap: 4px; }
  .msg.assistant .content { word-break: break-word; }
  .msg.system { color: var(--muted); font-size: 11.5px; white-space: pre-wrap; }
  .edit-box { display: flex; flex-direction: column; gap: 4px; width: 100%; max-width: 100%; }
  .edit-box textarea { min-height: 52px; }
  .edit-bar { display: flex; gap: 4px; justify-content: flex-end; }
  .sess-op { font-size: 11px; padding: 1px 6px; background: var(--face); }
  .msg-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); min-height: 15px; }
  .msg-actions { display: flex; gap: 2px; opacity: 0; }
  .msg:hover .msg-actions, .msg.assistant:last-child .msg-actions { opacity: 1; }
  .icon-btn { all: unset; cursor: pointer; padding: 0 5px; font-size: 11px; color: var(--muted); border: 1px solid transparent; }
  .icon-btn:hover { color: var(--text); border-color: var(--line); background: var(--face); }
  .cursor { display: inline-block; width: 6px; height: 13px; margin-left: 2px; vertical-align: text-bottom; background: var(--text); animation: nta-blink 1s steps(1, end) infinite; }
  @keyframes nta-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }

  /* 消息内 markdown（.md 容器） */
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0 0 6px; }
  .md h1, .md h2, .md h3, .md h4 { margin: 10px 0 4px; font-weight: 700; line-height: 1.35; }
  .md h1 { font-size: 16px; } .md h2 { font-size: 14.5px; } .md h3 { font-size: 13.5px; } .md h4 { font-size: 12.5px; }
  .md ul, .md ol { margin: 4px 0; padding-left: 20px; }
  .md li { margin: 1px 0; }
  .md blockquote { margin: 6px 0; padding: 2px 0 2px 8px; border-left: 3px solid var(--face); color: var(--muted); }
  .md hr { border: 0; border-top: 1px solid var(--line); margin: 8px 0; }
  .md table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 6px 0; }
  .md th, .md td { border: 1px solid var(--line); padding: 2px 6px; text-align: left; }
  .md th { background: var(--face); font-weight: 700; }
  .md code { background: var(--code); padding: 0 3px; font-size: 11.5px; font-family: var(--mono); }
  .code-block { border: 1px solid var(--line); margin: 6px 0; background: var(--window); }
  .code-head { display: flex; align-items: center; gap: 6px; padding: 2px 6px; font-size: 11px; background: var(--face); border-bottom: 1px solid var(--line); }
  .code-head .cp { margin-left: auto; }
  .code-body { margin: 0; padding: 6px 8px; overflow: auto; font-size: 11.5px; line-height: 1.45; font-family: var(--mono); white-space: pre; }

  /* 工具调用卡（.tool 为 e2e 契约） */
  .tool { border: 1px solid var(--line); background: var(--window); overflow: hidden; }
  .tool + .tool { margin-top: 3px; }
  .tool summary { cursor: pointer; padding: 2px 6px; font-size: 12px; background: var(--face); list-style: none; display: flex; align-items: center; gap: 6px; }
  .tool[open] summary { border-bottom: 1px solid var(--line); }
  .tool summary::-webkit-details-marker { display: none; }
  .tool summary::before { content: '▸'; font-size: 10px; }
  .tool[open] summary::before { content: '▾'; }
  .tool .t-name { font-weight: 700; }
  .tool .st { font-size: 11px; color: var(--muted); }
  .tool .st.ok { color: var(--ok); } .tool .st.bad { color: var(--bad); } .tool .st.run { color: var(--warn); }
  .tool .tool-body { margin: 0; padding: 6px 8px; font-size: 11.5px; }
  .tool .tool-sec { margin-top: 4px; }
  .tool .tool-sec > b { font-size: 11px; color: var(--muted); font-weight: 700; }
  .tool .tool-pre { margin: 3px 0 0; padding: 5px 6px; background: var(--window); border: 1px solid var(--line); max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 11.5px; }
  .tool .tool-sec .cp { float: right; }

  /* 审批 / 追问（经典提示条配色） */
  .decision { border: 1px solid var(--line); background: var(--info); padding: 6px 8px; margin: 6px auto; max-width: var(--col); }
  .decision .d-title { font-weight: 700; margin-bottom: 2px; font-size: 12.5px; }
  .decision .d-sub { color: var(--muted); font-size: 11.5px; margin-bottom: 4px; }
  .decision pre { max-height: 220px; overflow: auto; background: var(--window); border: 1px solid var(--line); padding: 5px 6px; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; margin: 4px 0; }
  .decision .d-row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .decision input[type=text] { flex: 1; min-width: 160px; }
  .decision .raw { border: 1px solid var(--line); background: var(--window); padding: 4px 6px; margin-top: 4px; }
  .decision .raw summary { cursor: pointer; color: var(--muted); font-size: 11px; }
  .decision .raw pre { margin: 4px 0 0; max-height: 200px; }
  .doing { min-height: 15px; font-size: 11.5px; color: var(--warn); padding: 2px 10px; max-width: var(--col); margin: 0 auto; width: 100%; }

  /* 输入区（白底字段 + 灰色发送键） */
  .composer-wrap { position: relative; border-top: 1px solid var(--line); padding: 6px 8px 8px; }
  .composer { max-width: var(--col); margin: 0 auto; display: flex; gap: 6px; align-items: flex-end; background: var(--window); border: 1px solid var(--line); padding: 3px 3px 3px 6px; }
  .composer:focus-within { border-color: var(--hl); }
  .composer textarea { flex: 1; resize: none; border: 0; background: transparent; padding: 3px 0; min-height: 24px; max-height: 200px; overflow-y: auto; }
  .composer textarea:focus { border-color: transparent; }
  .composer .send { all: unset; cursor: pointer; flex: 0 0 auto; width: 26px; height: 24px; background: var(--face); border: 1px solid var(--line); color: var(--text); display: flex; align-items: center; justify-content: center; font-size: 12px; font-family: "Segoe MDL2 Assets"; }
  .composer .send:hover { background: var(--face-hi); }
  .composer .send:disabled { color: var(--faint); cursor: default; background: var(--face); }
  .scroll-bottom { position: absolute; left: 50%; transform: translateX(-50%); bottom: 8px; cursor: pointer; border: 1px solid var(--line); background: var(--face); color: var(--text); padding: 2px 10px; font: inherit; z-index: 6; }
  .scroll-bottom:hover { background: var(--face-hi); }

  /* 空态 */
  .empty-hero { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; margin-top: 6vh; }
  .empty-hero .eh-logo { width: 32px; height: 32px; background: var(--face); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; font-size: 16px; font-family: "Segoe MDL2 Assets"; }
  .empty-hero h2 { margin: 0; font-size: 15px; font-weight: 700; }
  .empty-hero p { margin: 0; color: var(--muted); font-size: 12px; }
  .suggest { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; max-width: 620px; margin-top: 4px; }
  .sug { cursor: pointer; border: 1px solid var(--line); background: var(--face); color: var(--text); padding: 2px 8px; font: inherit; font-size: 11.5px; }
  .sug:hover { background: var(--hl); color: var(--title-fg); }

  /* @技能 / /命令 候选（.mi/.sel 为 e2e 契约） */
  .mention { position: absolute; bottom: 100%; left: 8px; right: 8px; max-width: var(--col); margin: 0 auto 4px; max-height: 240px; overflow: auto; background: var(--window); border: 1px solid var(--line); z-index: 7; }
  .mention .mi { padding: 3px 6px; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mention .mi.sel, .mention .mi:hover { background: var(--hl); color: var(--title-fg); }
  .syseditor { border: 1px solid var(--line); background: var(--face); padding: 6px 8px; margin: 6px auto 0; max-width: var(--col); }
  .syseditor textarea { min-height: 60px; }
  /* 技能面板（只读）：列技能包 → 展开文件 chips → 看原文 */
  .skillspanel .skill-row { border: 1px solid var(--line); background: var(--window); padding: 4px 7px; margin: 4px 0; cursor: pointer; }
  .skillspanel .skill-row.sel { background: var(--hl); color: var(--title-fg); }
  .skillspanel .skill-row.sel .muted { color: var(--title-fg); opacity: .8; }
  .skillspanel .badge { border: 1px solid var(--line); padding: 0 4px; font-size: 10.5px; margin-left: 6px; }
  .skillspanel .skill-files { display: none; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .skillspanel .skill-row.open .skill-files { display: flex; }
  .skillspanel .skill-file { border: 1px solid var(--line); background: var(--face); padding: 1px 6px; font-size: 11.5px; cursor: pointer; }
  .skillspanel .skill-file.sel, .skillspanel .skill-file:hover { background: var(--hl); color: var(--title-fg); }
  .skillspanel pre { max-height: 240px; overflow: auto; background: var(--window); border: 1px solid var(--line); padding: 6px 8px; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; }
  #toast { position: fixed; right: 12px; bottom: 12px; background: var(--info); border: 1px solid var(--text); color: var(--text); padding: 4px 10px; opacity: 0; transition: opacity .15s; pointer-events: none; max-width: 60vw; z-index: 9; font-size: 12px; }
  #toast.show { opacity: 1; }
  #toast.bad { color: var(--bad); font-weight: 700; }

  /* ---- 窄窗口自适应（半屏/小窗；超窄时侧栏只留图标） ---- */
  @media (max-width: 900px) {
    .side { width: 190px; min-width: 190px; }
    .main > .content { padding: 8px 8px 30px; }
  }
  @media (max-width: 700px) {
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    .side { width: 54px; min-width: 54px; }
    .brand { justify-content: center; font-size: 0; }
    .brand .logo { font-size: 12px; }
    .side > div[style] { display: none; }
    .side nav button { justify-content: center; padding: 6px 0; font-size: 0; }
    .side nav button .ico { font-size: 14px; width: auto; }
    .side .divider, .side-title, #side-sessions, .side-foot { display: none; }
    .agent-top { padding: 4px 6px; }
    .agent-title { max-width: 100%; }
    .chat-wrap { padding: 4px 6px 0; }
    .chat { padding: 6px; }
    .composer-wrap { padding: 4px 6px 6px; }
    .mention { left: 6px; right: 6px; }
    .syseditor { margin-left: 6px; margin-right: 6px; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><span class="logo">N</span> NTR Daemon</div>
    <div style="padding:4px 6px 2px">
      <select id="project-select" style="width:100%" title="当前项目：任务/规则/助手/状态默认作用于它；通用 = 全局视角"></select>
    </div>
    <nav id="side-nav">
      <button data-tab="agent" data-title="助手" class="active"><span class="ico" data-icon="0xE8BD"></span>助手</button>
      <button data-tab="jobs" data-title="任务"><span class="ico" data-icon="0xE823"></span>任务</button>
      <button data-tab="settings" data-title="设置"><span class="ico" data-icon="0xE713"></span>设置</button>
      <button data-tab="rules" data-title="规则"><span class="ico" data-icon="0xE71C"></span>规则</button>
      <button data-tab="prompts" data-title="提示词"><span class="ico" data-icon="0xE8A5"></span>提示词</button>
      <button data-tab="books" data-title="项目"><span class="ico" data-icon="0xE8F1"></span>项目</button>
      <button data-tab="status" data-title="状态"><span class="ico" data-icon="0xE9D9"></span>状态</button>
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
      <button class="icon-btn sess-op" id="agent-rename" title="重命名当前会话">重命名</button>
      <button class="icon-btn sess-op" id="agent-delete" title="删除当前会话">删除</button>
      <span class="spacer"></span>
      <span class="muted" id="agent-status"></span>
      <button class="btn ghost" id="agent-skills-btn" title="技能目录（内置只读；用户技能可编辑，agent 沙箱可生成）">技能</button>
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
        <button class="send" id="agent-send" data-icon="0xE724" title="发送（Enter）"></button>
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
    <div id="agent-skillspanel" class="syseditor skillspanel" style="display: none">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px">
        <b>技能</b>
        <span class="muted">内置只读；用户技能（daemon/skills-user）可编辑，agent 沙箱也可在此生成；「隐藏」不进 agent 目录但仍可读取</span>
        <span class="spacer"></span>
        <button class="btn ghost" id="agent-skill-new">＋ 新建</button>
        <button class="btn ghost" id="agent-skills-close">关闭</button>
      </div>
      <div id="agent-skill-create" style="display: none; border: 1px solid var(--line); background: var(--window); padding: 5px 7px; margin: 4px 0">
        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap">
          <input type="text" id="agent-skill-new-name" placeholder="技能名（小写字母/数字/中划线，如 my-skill）" style="flex: 1; min-width: 200px">
          <input type="text" id="agent-skill-new-desc" placeholder="一句话描述（什么时候用）" style="flex: 2; min-width: 240px">
          <button class="btn" id="agent-skill-create-save">创建</button>
          <button class="btn ghost" id="agent-skill-create-cancel">取消</button>
        </div>
      </div>
      <div id="agent-skills-list"></div>
      <div id="agent-skill-viewbox" style="display: none">
        <div id="agent-skill-view-head" style="display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap"></div>
        <pre id="agent-skill-view"></pre>
        <div id="agent-skill-editor" style="display: none">
          <textarea id="agent-skill-edit-text" style="width: 100%; min-height: 180px"></textarea>
          <div style="display: flex; gap: 8px; margin-top: 4px">
            <button class="btn" id="agent-skill-edit-save">保存</button>
            <button class="btn ghost" id="agent-skill-edit-cancel">取消</button>
          </div>
        </div>
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
      <label>并发上限 maxInFlight <input type="number" id="llm-max" min="0"></label>
      <label>RPM <input type="number" id="llm-rpm" min="0"></label>
      <label>传输重试 <input type="number" id="llm-retries" min="0"></label>
      <label>提示词上限(字符) <input type="number" id="llm-prompt" min="1000"></label>
      <label><input type="checkbox" id="llm-strict"> 超限直接失败（strictPrompt）</label>
      <div><button class="btn" id="settings-save">保存</button></div>
      <div class="muted">单线程 Gemini：maxInFlight=1；填 0 = 自动伸缩（起步 4，连续成功逐步 +1，429/503 减半，上限 16）。</div>
    </fieldset>
    <fieldset><legend>助手池调度与限流</legend>
      <label>并发上限 maxInFlight <input type="number" id="ag-max" min="0"></label>
      <label>RPM <input type="number" id="ag-rpm" min="0"></label>
      <label>传输重试 <input type="number" id="ag-retries" min="0"></label>
      <label>提示词上限(字符) <input type="number" id="ag-prompt" min="1000"></label>
      <label><input type="checkbox" id="ag-strict"> 超限直接失败（strictPrompt）</label>
      <div><button class="btn" id="ag-llm-save">保存</button></div>
      <div class="muted">默认与翻译池默认值相同；多 key 池在此直接配置即可，不必经油猴。填 0 = 自动伸缩（起步 4，429/503 减半，上限 16）。</div>
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
        <button class="btn" id="token-sync">从站点同步</button>
        <span class="muted" id="token-sync-hint">从站点页面（油猴）取当前 token；需站点页面开着且已登录</span>
      </div>
      <div style="margin-top:6px">
        <label>token <input type="password" id="set-token" size="40" placeholder="或手工粘贴站点 token（只写不回显）"></label>
        <button class="btn ghost" id="token-save">保存 token</button>
        <span class="muted" id="cred"></span>
      </div>
      <div style="margin-top:6px">
        <label>站点请求重试 <input type="number" id="site-retries" min="0" max="8" size="3" style="width:56px"></label>
        <button class="btn ghost" id="site-retries-save">保存</button>
        <div class="muted" id="site-retries-info" style="margin-top:4px"></div>
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
  el.classList.toggle('bad', !!bad);   // 提示条样式走 CSS（经典 InfoWindow 配色）
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
};
// Segoe MDL2 Assets 字形：一律用 String.fromCodePoint 生成，避免在模板字面量里写反斜杠转义
const mdlCp = (code) => String.fromCodePoint(typeof code === 'string' && code.indexOf('0x') === 0 ? parseInt(code, 16) : code);
const mdlIcon = (code, cls) => {
  const span = document.createElement('span');
  span.className = 'ico-mdl' + (cls ? ' ' + cls : '');
  span.textContent = mdlCp(code);
  return span;
};
const paintIcons = (root) => {
  (root || document).querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.textContent) el.textContent = mdlCp(el.dataset.icon);
  });
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

document.querySelectorAll('#side-nav button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('#side-nav button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.page').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + btn.dataset.tab));
  $('page-title').textContent = btn.dataset.title || btn.textContent.trim();
  setContentMode(btn.dataset.tab);
  if (btn.dataset.tab === 'agent') { agentInit(); return; }
  refresh();
}));
// 助手页要精确填满内容区（自己管滚动），靠这个类把内容区的内边距与滚动条让开；
// 否则 100vh 硬算的高度会多出内边距那 50px → 冒竖直滚动条、右侧留白不对称、输入区被推到视口外
function setContentMode(tab) {
  const box = document.querySelector('.main > .content');
  if (box) box.classList.toggle('agent-active', tab === 'agent');
}

let STATE = { books: [], runs: [], queue: [] };
let LAST_SYNC_AT = 0;   // 最近一次凭据同步时间（「从站点同步」按钮的判据）
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
    if (PROJECT) hdrParts.push('项目 ' + String(((STATE.books || []).find((b) => b.key === PROJECT) || {}).title || PROJECT).slice(0, 18));
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
  const kv = (label, value) => '<tr><th style="width:180px">' + esc(label) + '</th><td>' + esc(value) + '</td></tr>';
  const pool = (name, s) => {
    if (!s) return kv(name, '未装配');
    const cooling = Object.values(s.byWorker || {}).filter((w) => (w.coolingMs || 0) > 0).length;
    return kv(name, (s.auto ? '并发自动（当前 ' + (s.maxInFlight == null ? '?' : s.maxInFlight) + '）' : '并发上限 ' + (s.maxInFlight == null ? '?' : s.maxInFlight)) + ' · 在途 ' + (s.inFlightNow || 0) +
      ' · workers ' + (s.workers || 0) + ' · 请求 ' + (s.requests || 0) + ' · 冷却 ' + cooling +
      ' · 传输重试 ' + (s.transportRetries || 0) +
      (s.maxObservedInFlight ? ' · 峰值 ' + s.maxObservedInFlight : '') +
      (s.lastError ? ' · 最近错误 ' + String(s.lastError).slice(0, 40) : ''));
  };
  let pj = '';
  if (PROJECT) {
    const b = (STATE.books || []).find((x) => x.key === PROJECT) || {};
    const runs = (STATE.runs || []).filter((r) => r.bookKey === PROJECT).slice(0, 3)
      .map((r) => r.job + '/' + r.state).join('、') || '—';
    pj = '<fieldset><legend>当前项目</legend><table>' +
      kv('项目', String(b.title || PROJECT).slice(0, 40) + '（' + PROJECT + '）') +
      kv('状态 / 已译', String(b.state || 'idle') + ' · ' + (b.progress || 0) + ' 章') +
      kv('最近 run', runs) +
      '</table></fieldset>';
  }
  const u = status.usage || {};
  $('status-box').innerHTML = pj +
    '<fieldset><legend>模型池</legend><table>' +
    pool('翻译池', status.llm) +
    pool('助手/术语池', status.llmAgent) +
    '</table></fieldset>' +
    '<fieldset><legend>用量与内存</legend><table>' +
    kv('用量', '请求 ' + (u.requests || 0) + ' · prompt ' + (u.promptTokens || 0) + ' · completion ' + (u.completionTokens || 0) + (u.rows ? ' · 轮次 ' + u.rows : '')) +
    kv('RSS 最近采样', m || '—') +
    '</table></fieldset>';
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
  mfHint.textContent = state.manifestPath
    ? ('默认用本会话导出时的清单：' + state.manifestPath + '（可另选覆盖）')
    : '未记住清单，请选择导出时生成的 .manifest.json（站点「下载原文」经 LG 翻译的 txt 也可直接选，会按站点格式自动对齐）';
  mfRow.append(mfLabel, mfInput, mfHint);
  // 操作行
  const opRow = mkRow();
  const verifyBtn = document.createElement('button'); verifyBtn.className = 'btn'; verifyBtn.textContent = '校验';
  const limitLabel = document.createElement('span'); limitLabel.textContent = '限章数';
  const limitInput = document.createElement('input'); limitInput.type = 'number'; limitInput.min = '0'; limitInput.value = '0';
  const applyBtn = document.createElement('button'); applyBtn.className = 'btn'; applyBtn.textContent = '提交通过章'; applyBtn.disabled = true;
  opRow.append(verifyBtn, limitLabel, limitInput, applyBtn);
  const report = document.createElement('div'); report.className = 'muted';
  report.textContent = '选好文件后点「校验」：逐章核对行数/空行模式/源 sha1，再决定提交。站点「下载原文」经 LG 翻译的整本 txt（含 # 标题行）会自动识别并对齐。';
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
          (v.convertError ? '<div class="muted">站点格式自动对齐失败：' + esc(v.convertError) + '（代理链路抖动时可稍后重试「校验」）</div>' : '') +
          '<div class="muted">结果 ' + v.linesIn + ' 行 / 清单 ' + v.linesTotal + ' 行</div>';
        return;
      }
      const rows = (v.chapters || []).map((c) =>
        '<div>' + (c.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') + ' ' +
        esc(c.title || c.chapterId) + '（' + c.count + ' 段）' + (c.ok ? '' : '：' + esc(c.reason)) + '</div>').join('');
      const convNote = v.converted ? ('<div class="muted">↻ ' + esc(v.convertNote || '已识别站点导出格式并自动对齐') + '</div>') : '';
      report.innerHTML = convNote + '<div><b>校验：' + v.okCount + '/' + v.total + ' 章通过 · 疑似未翻 ' + v.untranslated + ' 行</b>（' + esc(v.note) + '）</div>' + rows;
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
    const site = (s.settings && s.settings.site) || {};
    $('site-retries').value = site.retries == null ? 3 : site.retries;
    $('site-retries-info').textContent = '站点请求（抓原文/章节提交/术语表）传输层失败最多重试 ' + ($('site-retries').value) +
      ' 次——墙内走代理链路抖动大时可加档；整本抓取 167 章实测约 1/3 请求首发失败，3 次重试仍有零星章失败，8 次基本清零。';
    $('cred').textContent = 'token：' + (s.settings.tokenSet ? '已同步' : '未同步') +
      ' · 翻译池 ' + ((s.settings.workers || []).length) + ' 个 · 助手池 ' +
      ((agent.workers || []).length > 0 ? (agent.workers.length + ' 个（显式）') : '跟随翻译池') +
      (s.settings.authRequest ? ' · 等待站点推送' : '');
    LAST_SYNC_AT = (ls && ls.at) || 0;   // 「从站点同步」按钮用它判断推送是否到达
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
      maxInFlight: Math.max(0, Math.floor(Number($('ag-max').value) || 0)),
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
      maxInFlight: Math.max(0, Math.floor(Number($('llm-max').value) || 0)),
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
$('site-retries-save').addEventListener('click', async () => {
  try {
    const n = Math.max(0, Math.min(8, Math.floor(Number($('site-retries').value) || 0)));
    await post('/settings', { site: { retries: n } });
    toast('站点请求重试次数已保存（' + n + ' 次，立即生效）'); loadSettings();
  } catch (e) { toast(e.message, true); }
});
// 「从站点同步」：置同步请求 → 站点页面（油猴）在 ≤5s 探测里看到 pendingAuth 就推一次凭据 → 这里等 lastSync 变化
$('token-sync').addEventListener('click', async () => {
  const btn = $('token-sync');
  const hint = $('token-sync-hint');
  if (btn.disabled) return;
  const beforeAt = LAST_SYNC_AT;
  btn.disabled = true;
  btn.textContent = '等待站点推送…';
  hint.textContent = '已请求，站点页面会在几秒内推送（需页面开着且已登录）';
  try {
    await post('/auth/request', {});
  } catch (e) {
    btn.disabled = false; btn.textContent = '从站点同步';
    hint.textContent = '';
    toast(e.message, true);
    return;
  }
  const done = (okMsg, badMsg) => {
    btn.disabled = false;
    btn.textContent = '从站点同步';
    hint.textContent = badMsg || '从站点页面（油猴）取当前 token；需站点页面开着且已登录';
    if (okMsg) toast(okMsg); else toast(badMsg, true);
    loadSettings();
  };
  const deadline = Date.now() + 35000;
  const timer = setInterval(async () => {
    let s = null;
    try { s = await api('/settings'); } catch (e) { /* 瞬时错误继续等 */ }
    const ls = s && s.settings && s.settings.lastSync;
    if (ls && (ls.at || 0) > beforeAt) {
      clearInterval(timer);
      done('已同步（' + (ls.ua || '?') + ' · ' + (ls.workersCount == null ? '?' : ls.workersCount) + ' 个翻译器）');
      return;
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      done(null, '未收到推送：确认站点页面已打开并且已登录');
    }
  }, 1500);
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
  const logo = document.createElement('div'); logo.className = 'eh-logo'; logo.textContent = mdlCp('0xE8BD');
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
  const name = document.createElement('span'); name.className = 't-name';
  name.appendChild(mdlIcon('0xE90F'));
  name.appendChild(document.createTextNode(' ' + tc.name));
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
    const acts = document.createElement('div'); acts.className = 'msg-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-btn'; edit.textContent = '编辑';
    edit.addEventListener('click', function () { agentStartEdit(m, row); });
    acts.appendChild(edit);
    row.appendChild(acts);
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
    const lastAssistant = (AGENT.messages || []).filter(function (x) { return x.role === 'assistant'; }).pop();
    if (lastAssistant && lastAssistant.seq === m.seq) {
      const redo = document.createElement('button'); redo.type = 'button'; redo.className = 'icon-btn'; redo.textContent = '重新生成';
      redo.title = '丢弃这一轮的回答重跑（用户消息保留）';
      redo.addEventListener('click', agentRegenerate);
      acts.appendChild(redo);
    }
    meta.appendChild(acts);
    row.appendChild(meta);
    if (m.content) { const content = document.createElement('div'); content.className = 'content md'; content.innerHTML = renderMarkdown(m.content); row.appendChild(content); }
    (m.toolCalls || []).forEach(function (tc) { row.appendChild(agentToolCard(tc)); });
    return row;
  }
  return agentLine('msg system', '工具结果：' + String(m.content || '').slice(0, 200));
}
// 编辑用户消息：气泡换成内联编辑器，保存即截断重发
function agentStartEdit(m, row) {
  if (AGENT.running) { toast('该会话正在跑一轮，先停止再编辑', true); return; }
  row.innerHTML = '';
  const box = document.createElement('div'); box.className = 'edit-box';
  const ta = document.createElement('textarea'); ta.value = String(m.content || '');
  const bar = document.createElement('div'); bar.className = 'edit-bar';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn'; save.textContent = '保存并重发';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn ghost'; cancel.textContent = '取消';
  save.addEventListener('click', async function () {
    const text = ta.value.trim();
    if (text === '') { toast('内容不能为空', true); return; }
    try {
      await post('/agent/message/edit', { session: AGENT.session, seq: m.seq, message: text, approvalMode: $('agent-auto').checked ? 'auto' : 'manual' });
      renderAgentMessages(true);   // 截断会复用 seq：整表重建，避免节点 key 冲突
      agentRefresh();
    } catch (e) { toast(e.message, true); }
  });
  cancel.addEventListener('click', function () { renderAgentMessages(true); });
  bar.appendChild(save); bar.appendChild(cancel);
  box.appendChild(ta); box.appendChild(bar);
  row.appendChild(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
async function agentRegenerate() {
  if (!AGENT.session || AGENT.running) return;
  try {
    await post('/agent/message/regenerate', { session: AGENT.session, approvalMode: $('agent-auto').checked ? 'auto' : 'manual' });
    renderAgentMessages(true);
    toast('已重新生成');
    agentRefresh();
  } catch (e) { toast(e.message, true); }
}
async function agentRenameSession(sid) {
  const target = sid || AGENT.session;
  if (!target) { toast('先选择会话', true); return; }
  if (AGENT.running && target === AGENT.session) { toast('该会话正在跑一轮，先停止再重命名', true); return; }
  const cur = (lastSessions.find(function (x) { return x.id === target; }) || {}).title || '';
  const input = prompt('会话标题', cur);
  if (input == null) return;
  const title = input.trim();
  if (title === '') { toast('标题不能为空', true); return; }
  try { await post('/agent/session/rename', { session: target, title: title }); toast('已重命名'); await agentInit(); }
  catch (e) { toast(e.message, true); }
}
async function agentDeleteSession(sid) {
  const target = sid || AGENT.session;
  if (!target) { toast('先选择会话', true); return; }
  if (AGENT.running && target === AGENT.session) { toast('该会话正在跑一轮，先停止再删除', true); return; }
  const name = (lastSessions.find(function (x) { return x.id === target; }) || {}).title || target.slice(0, 8);
  if (!confirm('删除会话「' + name + '」？该会话的消息与审批记录都会从本地 daemon 删除（站点数据不动）。')) return;
  try {
    await post('/agent/session/delete', { session: target });
    if (AGENT.session === target) {
      AGENT.session = '';
      localStorage.removeItem('ntr-daemon-agent-session');
      AGENT.messages = []; AGENT.pending = null; AGENT.localCount = 0;
      agentSyncTitle();
      renderAgentMessages(true); renderAgentDecision();
    }
    toast('已删除会话');
    await agentInit();
  } catch (e) { toast(e.message, true); }
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
// 会话头部用量：轮数/tokens/tok/s 从消息表算（snapshot 已带每条 at+usage）；「请求 N」保留（e2e 契约）
function agentUsageStats() {
  let rounds = 0; let tokens = 0; let comp = 0; let firstAt = 0; let lastAt = 0;
  for (const m of (AGENT.messages || [])) {
    if (m.role !== 'assistant') continue;
    rounds += 1;
    const u = m.usage || {};
    tokens += (Number(u.promptTokens) || 0) + (Number(u.completionTokens) || 0);
    comp += Number(u.completionTokens) || 0;
    if (m.at) { if (!firstAt || m.at < firstAt) firstAt = m.at; if (m.at > lastAt) lastAt = m.at; }
  }
  const secs = firstAt && lastAt > firstAt ? (lastAt - firstAt) / 1000 : 0;
  return { rounds: rounds, tokens: tokens, tps: secs > 0 && comp > 0 ? Math.round(comp / secs) : 0 };
}
function renderAgentStatus() {
  const pj = AGENT.sessionBook ? ' · 项目 ' + String(((STATE.books || []).find((b) => b.key === AGENT.sessionBook) || {}).title || AGENT.sessionBook).slice(0, 16) : '';
  const us = agentUsageStats();
  const usageText = '请求 ' + (AGENT.usage ? AGENT.usage.requests : 0) +
    (us.rounds > 0
      ? ' · ' + us.rounds + ' 轮 / ' + us.tokens + ' tokens' + (us.tps > 0 ? ' / ~' + us.tps + ' tok/s' : '')
      : ' / ' + (AGENT.usage ? (AGENT.usage.promptTokens + AGENT.usage.completionTokens) : 0) + ' tokens');
  $('agent-status').textContent = (AGENT.running ? '进行中…' : '空闲') +
    (AGENT.running && AGENT.step ? '（第 ' + AGENT.step + ' 步）' : '') +
    ' · ' + usageText +
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
        '<span class="sess-name">' + esc(String(x.title || x.id).slice(0, 22)) + '</span>' +
        (when ? '<span class="sess-when">' + esc(when) + '</span>' : '') +
        (x.running ? '<span class="sess-dot"></span>' : '') +
        '<span class="sess-ops">' +
        '<button type="button" class="icon-btn" data-srename="' + esc(x.id) + '" title="重命名">改</button>' +
        '<button type="button" class="icon-btn" data-sdel="' + esc(x.id) + '" title="删除会话">删</button>' +
        '</span></div>';
    }).join('');
  });
  box.innerHTML = html || '<div class="muted" style="padding:4px 12px">无会话</div>';
  box.querySelectorAll('[data-sid]').forEach(function (rowEl) {
    rowEl.addEventListener('click', function () { agentSetSession(rowEl.dataset.sid); });
  });
  box.querySelectorAll('[data-srename]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.stopPropagation(); agentRenameSession(el.dataset.srename); });
  });
  box.querySelectorAll('[data-sdel]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.stopPropagation(); agentDeleteSession(el.dataset.sdel); });
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
$('agent-rename').addEventListener('click', function () { agentRenameSession(''); });
$('agent-delete').addEventListener('click', function () { agentDeleteSession(''); });
$('agent-sys').addEventListener('click', async function () {  const panel = $('agent-syseditor');
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
$('agent-skills-btn').addEventListener('click', async function () {
  const panel = $('agent-skillspanel');
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  $('agent-skill-viewbox').style.display = 'none';
  $('agent-skill-create').style.display = 'none';
  await renderSkillsPanel();
});
$('agent-skills-close').addEventListener('click', function () { $('agent-skillspanel').style.display = 'none'; });
let agentSkillEdit = null;   // 当前查看/编辑的文件 {name, path, content}
const skillWritable = (name) => ((AGENT_SKILLS || []).find((s) => s.name === name) || {}).writable === true;
function agentSkillViewHead(name, relPath) {
  const head = $('agent-skill-view-head');
  head.textContent = '';
  const label = document.createElement('b'); label.textContent = name + '/' + relPath; head.appendChild(label);
  if (!skillWritable(name)) {
    const ro = document.createElement('span'); ro.className = 'muted'; ro.textContent = '（内置，只读）'; head.appendChild(ro);
    return;
  }
  const editBtn = document.createElement('button'); editBtn.className = 'btn ghost'; editBtn.textContent = '编辑';
  editBtn.addEventListener('click', function () {
    $('agent-skill-view').style.display = 'none';
    $('agent-skill-editor').style.display = 'block';
    $('agent-skill-edit-text').value = agentSkillEdit ? agentSkillEdit.content : '';
    $('agent-skill-edit-text').focus();
  });
  head.appendChild(editBtn);
  if (relPath !== 'SKILL.md') {
    const delFile = document.createElement('button'); delFile.className = 'btn ghost'; delFile.textContent = '删除此文件';
    delFile.addEventListener('click', async function () {
      if (!confirm('删除 ' + name + '/' + relPath + '？')) return;
      try { await post('/agent/skill/delete', { name: name, path: relPath }); toast('文件已删除'); await renderSkillsPanel(); agentOpenSkillFile(name, 'SKILL.md'); }
      catch (e) { toast(e.message, true); }
    });
    head.appendChild(delFile);
  }
  const delSkill = document.createElement('button'); delSkill.className = 'btn danger'; delSkill.textContent = '删除技能';
  delSkill.addEventListener('click', async function () {
    if (!confirm('删除整个技能 ' + name + '（含全部文件）？')) return;
    try { await post('/agent/skill/delete', { name: name }); toast('技能已删除'); $('agent-skill-viewbox').style.display = 'none'; await renderSkillsPanel(); }
    catch (e) { toast(e.message, true); }
  });
  head.appendChild(delSkill);
}
async function agentOpenSkillFile(name, relPath) {
  const box = $('agent-skill-viewbox');
  const view = $('agent-skill-view');
  $('agent-skill-editor').style.display = 'none';
  view.style.display = 'block';
  box.style.display = 'block';
  view.textContent = '加载中…';
  try {
    const r = await api('/agent/skill/file?name=' + encodeURIComponent(name) + '&path=' + encodeURIComponent(relPath));
    agentSkillEdit = { name: name, path: r.path, content: r.content };
    agentSkillViewHead(name, r.path);
    view.textContent = (r.truncated ? '（内容过长，已截断到前 100000 字）' : '') + r.content;
  } catch (e) { view.textContent = '读取失败：' + e.message; }
}
async function renderSkillsPanel() {
  const list = $('agent-skills-list');
  list.innerHTML = '<div class="muted">加载中…</div>';
  let skills = [];
  try { skills = (await api('/agent/skills')).skills || []; } catch (e) { list.textContent = '读取失败：' + e.message; return; }
  AGENT_SKILLS = skills;   // 面板打开即目录最新态，顺带刷新 @候选缓存
  if (skills.length === 0) { list.textContent = '技能目录为空'; return; }
  list.textContent = '';
  for (const s of skills) {
    const row = document.createElement('div'); row.className = 'skill-row';
    const head = document.createElement('div');
    const name = document.createElement('b'); name.textContent = s.name; head.appendChild(name);
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = s.source === 'user' ? '用户' : '内置';
    if (s.source === 'user') badge.style.fontWeight = '700';
    head.appendChild(badge);
    if (s.hidden) { const h = document.createElement('span'); h.className = 'badge'; h.textContent = '隐藏'; head.appendChild(h); }
    row.appendChild(head);
    if (s.description) { const d = document.createElement('div'); d.className = 'muted'; d.textContent = s.description; row.appendChild(d); }
    const files = document.createElement('div'); files.className = 'skill-files';
    for (const f of (s.files || [])) {
      const chip = document.createElement('span'); chip.className = 'skill-file'; chip.textContent = f;
      chip.addEventListener('click', function (ev) { ev.stopPropagation(); agentOpenSkillFile(s.name, f); });
      files.appendChild(chip);
    }
    row.appendChild(files);
    row.addEventListener('click', function () {
      const open = row.classList.contains('open');
      list.querySelectorAll('.skill-row').forEach(function (r) { r.classList.remove('open', 'sel'); });
      if (!open) row.classList.add('open', 'sel');
      $('agent-skill-viewbox').style.display = 'none';
    });
    list.appendChild(row);
  }
}
$('agent-skill-new').addEventListener('click', function () {
  const form = $('agent-skill-create');
  form.style.display = form.style.display === 'block' ? 'none' : 'block';
  $('agent-skill-new-name').focus();
});
$('agent-skill-create-cancel').addEventListener('click', function () { $('agent-skill-create').style.display = 'none'; });
$('agent-skill-create-save').addEventListener('click', async function () {
  try {
    await post('/agent/skill/create', { name: $('agent-skill-new-name').value.trim(), description: $('agent-skill-new-desc').value.trim() });
    toast('技能已创建（用户技能，可编辑）');
    $('agent-skill-create').style.display = 'none';
    $('agent-skill-new-name').value = ''; $('agent-skill-new-desc').value = '';
    await renderSkillsPanel();
  } catch (e) { toast(e.message, true); }
});
$('agent-skill-edit-save').addEventListener('click', async function () {
  if (!agentSkillEdit) return;
  try {
    await post('/agent/skill/save', { name: agentSkillEdit.name, path: agentSkillEdit.path, content: $('agent-skill-edit-text').value });
    toast('已保存（无需重启，下轮对话即生效）');
    agentSkillEdit.content = $('agent-skill-edit-text').value;
    $('agent-skill-editor').style.display = 'none';
    $('agent-skill-view').style.display = 'block';
    $('agent-skill-view').textContent = agentSkillEdit.content;
  } catch (e) { toast(e.message, true); }
});
$('agent-skill-edit-cancel').addEventListener('click', function () {
  $('agent-skill-editor').style.display = 'none';
  $('agent-skill-view').style.display = 'block';
});
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
paintIcons();
setContentMode('agent');
refresh(); loadSettings(); loadRules(); loadPrompts(); agentInit();
</script>
</body>
</html>`;
