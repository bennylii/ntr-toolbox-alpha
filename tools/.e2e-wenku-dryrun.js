// 端到端（干跑）：文库小说 提取→写入路径。拦截 PUT /api/wenku/.../glossary，只校验请求体，不真正写线上数据
const out = { stage: 'init', notifications: [], errors: [], captured: [] };
window.__e2e = out;
window.confirm = () => true;
window.alert = () => { };
const mark = (l) => { out.stage = l; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = () => [...document.querySelectorAll('.ntr-notification-message')].forEach((n) => {
  const t = n.textContent.trim();
  if (!out.notifications.includes(t)) out.notifications.push(t);
});
const clickText = (want) => {
  const els = [...document.querySelectorAll('button, .ntr-g-btn, .ntr-g-tab, .ntr-module-header')];
  const el = els.find((e) => e.textContent.trim() === want) || els.find((e) => e.textContent.includes(want));
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
};

// 拦截器：只拦 PUT /glossary（文库写入口）
const origFetch = window.fetch;
window.fetch = async (url, opts) => {
  const u = String(url);
  if (opts && opts.method === 'PUT' && u.includes('/glossary')) {
    out.captured.push({ url: u, method: opts.method, body: opts.body });
    return new Response('', { status: 200 });
  }
  return origFetch(url, opts);
};

const NOVEL_ID = '6aad7f8e697f727137ebc7f6';

try {
  // 关掉上一次跑残留的弹层
  const old = document.getElementById('ntr-glossary-overlay');
  if (old) old.remove();

  mark('configure-extract');
  const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === 'AI提取术语表');
  const set = (name, value) => { const s = mod.settings.find((it) => it.name === name); if (!s) throw new Error('缺少设置 ' + name); s.value = value; };
  // 显式自给自足：不依赖 localStorage 里残留的工作区翻译器/旧配置（顺序无关）
  set('任务方式', '直接提取');
  set('使用临时端点', true);
  set('临时端点', 'http://127.0.0.1:8788');
  set('临时模型', 'mock-glossary-1');
  set('临时Key', 'no_key_required');
  set('行数上限', 60);
  set('模式', '写入');
  set('并发', 2);
  set('最大轮数', 2);
  set('逾时(秒)', 30);
  out.target = await window._NTRGlossaryDev.resolveGlossaryTarget();
  out.describe = window._NTRGlossaryDev.GlossaryTargets.describe(out.target);

  mark('extract-run');
  window._NTRToolBox.runModule('AI提取术语表');

  // 等 diff 弹层出现（提取期间会经历 抓取正文 -> 多轮提取）；上限 60s，避免窗口遮挡节流下拖爆 CDP 超时
  let overlay = null;
  for (let i = 0; i < 300; i++) {
    await sleep(200);
    if (i % 10 === 0) collect();
    const o = document.getElementById('ntr-glossary-overlay');
    if (o && o.querySelector('.ntr-g-stats')) {
      overlay = {
        title: o.querySelector('.ntr-g-title').textContent,
        stats: o.querySelector('.ntr-g-stats').textContent,
        rows: o.querySelectorAll('tbody tr').length,
        checked: [...o.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length,
      };
      break;
    }
  }
  out.overlay = overlay;
  mark('overlay-ready');

  out.clickedWrite = clickText('合并写入');
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    collect();
    if (!document.getElementById('ntr-glossary-overlay')) break;
  }
  mark('write-finished');

  // 校验拦截到的 PUT 请求体
  const cap = out.captured[0];
  if (cap) {
    let body = null;
    try { body = JSON.parse(cap.body); } catch (e) { }
    out.write = body ? { url: cap.url, entries: Object.keys(body).length, sample: Object.entries(body).slice(0, 5) } : { url: cap.url, raw: String(cap.body).slice(0, 200) };
  } else {
    out.write = null;
  }

  out.snapshot = await window._NTRGlossaryDev.GlossaryDB.get('snapshots', 'wenku:' + NOVEL_ID)
    .then((s) => (s ? { entries: Object.keys(s.glossary || {}).length, at: new Date(s.createAt).toISOString() } : null));
  mark('done');
} catch (e) {
  out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
}
window.fetch = origFetch;
collect();
mark('end');
return JSON.stringify(out, null, 2);
