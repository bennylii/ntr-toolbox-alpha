// 端到端（干跑）：网页小说写入路径。拦截 PUT /glossary，只校验请求体，不真正写线上数据
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

// 拦截器：只拦 PUT /glossary
const origFetch = window.fetch;
window.fetch = async (url, opts) => {
  const u = String(url);
  if (opts && opts.method === 'PUT' && u.includes('/glossary')) {
    out.captured.push({ url: u, method: opts.method, body: opts.body });
    return new Response('', { status: 200 });
  }
  return origFetch(url, opts);
};

try {
  mark('import-run');
  const importText = 'アリス => 爱丽丝\n新詞ホゲ => 新译词';
  const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === '导入术语表(KWG)');
  mod.settings.find((s) => s.name === '术语表').value = importText;
  mod.settings.find((s) => s.name === '读取剪贴板').value = false;
  window._NTRToolBox.runModule('导入术语表(KWG)');

  let overlay = null;
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    collect();
    const o = document.getElementById('ntr-glossary-overlay');
    if (o && o.querySelector('.ntr-g-stats')) {
      overlay = { title: o.querySelector('.ntr-g-title').textContent, stats: o.querySelector('.ntr-g-stats').textContent, checked: [...o.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length };
      break;
    }
  }
  out.overlay = overlay;
  mark('overlay-ready');

  out.clickedWrite = clickText('合并写入');
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    collect();
    if (!document.getElementById('ntr-glossary-overlay')) break;
  }
  mark('write-finished');
  out.snapshot = await window._NTRGlossaryDev.GlossaryDB.get('snapshots', 'web:syosetu/n0284mu').then((s) => (s ? { entries: Object.keys(s.glossary || {}).length, at: new Date(s.createAt).toISOString() } : null));
  mark('done');
} catch (e) {
  out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
}
window.fetch = origFetch;
collect();
mark('end');
return JSON.stringify(out, null, 2);
