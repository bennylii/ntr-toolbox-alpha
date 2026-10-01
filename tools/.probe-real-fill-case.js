// 真站边界：填充术语表自动翻页（所有 PUT ~ /glossary 全拦截；用唯一测试词条证明零写入）
// 前置：cdp open "<list URL>" + cdp inject + cdp eval "window.__realFillCase='cap|last|zero|append'" 后 evalf 本文件
// 用例：
//   cap    query=魔法   （500 页）上限 2 → 填 2 页停（达到翻页上限），URL 停在 page=2
//   last   query=魔導書 （5 页）上限 20 → 填到底，下一页按钮变 --disabled 停（下一页按钮不可用），URL 停在 page=5
//   zero   query=ロセッティ（0 结果）→ 提示"未在当前页面找到小说条目"，0 次 PUT
//   append query=魔法  上级 1（追加模式）→ 每题一本 GET（真读）+ 拦截 PUT；停（达到翻页上限）
const out = { checks: [], notes: [], errors: [] };
const check = (l, c, e) => out.checks.push({ ok: !!c, label: l, extra: e === undefined ? undefined : e });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = window._NTRToolBox;
const CASE = window.__realFillCase || '';
const CASES = {
  cap: { q: '魔法', maxPages: 2, append: false, visual: false, minPut: 40, maxPut: 40, expPage: 2, toast: /翻页 2 页.*达到翻页上限/ },
  last: { q: '魔導書', maxPages: 20, append: false, visual: true, minPut: 81, maxPut: 100, expPage: 5, toast: /翻页 5 页.*下一页按钮不可用/ },
  zero: { q: 'ロセッティ', maxPages: 20, append: false, visual: false, minPut: 0, maxPut: 0, expPage: 1, toast: /未在当前页面找到小说条目/ },
  append: { q: '魔法', maxPages: 1, append: true, visual: false, minPut: 20, maxPut: 20, expPage: 1, toast: /翻页 1 页.*达到翻页上限/ },
};
try {
  const c = CASES[CASE];
  if (!c) throw new Error('未知用例: ' + CASE);
  out.notes.push('url=' + location.href);
  const fillMod = T.configuration.modules.find((m) => m.name === '填充术语表');

  // 等列表渲染好（列表页是异步加载；零结果用例给个固定等待）
  const countItems = () => [...document.querySelectorAll('a')].filter((a) => /^\/novel\/[^/]+\/[^/]+$/.test(a.getAttribute('href') || '')).length;
  if (c.minPut > 0) {
    for (let i = 0; i < 60; i++) { if (countItems() > 0) break; await sleep(250); }
    out.notes.push('页上条目数=' + countItems());
  } else {
    await sleep(1500);
    out.notes.push('零结果页上条目数=' + countItems());
  }

  // 拦截：/glossary 的 PUT 一律拦截（零写入保证）；GET /api/novel/{p}/{id}（追加模式）记录后放行（纯读）
  const origFetch = T.fetch.bind(T);
  const putKeys = {}, getKeys = {}, otherPuts = [];
  T.fetch = async (url, bypass, options = {}) => {
    const u = String(url);
    if (options.method === 'PUT' && /\/glossary(\?|$)/.test(u)) {
      const m = u.match(/\/api\/novel\/([^/]+)\/([^/]+)\/glossary/);
      if (m) putKeys[m[1] + '/' + m[2]] = (putKeys[m[1] + '/' + m[2]] || 0) + 1;
      else otherPuts.push(u);
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!options.method || options.method === 'GET') {
      const m = u.match(/\/api\/novel\/([^/]+)\/([^/]+)$/);
      if (m) getKeys[m[1] + '/' + m[2]] = (getKeys[m[1] + '/' + m[2]] || 0) + 1;
    }
    return origFetch(url, bypass, options);
  };

  // 通知捕获（1 秒寿命，必须边出边抓）
  const toasts = [];
  const obs = new MutationObserver((muts) => {
    for (const mu of muts) for (const n of mu.addedNodes) {
      if (n && n.classList && n.classList.contains('ntr-notification-message')) toasts.push((n.textContent || '').trim());
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  const origConfirm = window.confirm;
  window.confirm = () => true;

  const origSet = fillMod.settings;
  fillMod.settings = [
    { name: '术语表', value: 'zzテスト用語 => 测试词条' },
    { name: '追加模式', value: c.append },
    { name: '页面可视化反馈', value: c.visual },
    { name: '自动翻页至末页', value: true },
    { name: '翻页上限', value: c.maxPages },
    { name: 'bind', value: 'none' },
  ];
  const t0 = Date.now();
  await fillMod.run({ settings: fillMod.settings });
  const dt = Date.now() - t0;
  await sleep(400);

  fillMod.settings = origSet;
  window.confirm = origConfirm;
  T.fetch = origFetch;

  const keys = Object.keys(putKeys);
  const dup = keys.filter((k) => putKeys[k] > 1);
  const putTotal = keys.reduce((s, k) => s + putKeys[k], 0);
  const pageParam = new URL(location.href).searchParams.get('page');
  out.notes.push(`dt=${dt}ms putTotal=${putTotal} getTotal=${Object.keys(getKeys).length} toasts=${JSON.stringify(toasts.slice(-2))}`);

  check(`PUT 本数在 ${c.minPut}~${c.maxPut}（实际 ${putTotal}）`, putTotal >= c.minPut && putTotal <= c.maxPut && keys.length === putTotal, { keys: keys.length, putTotal });
  check('没有重复填充同一本（逐 key 计数=1）', dup.length === 0, dup.slice(0, 5));
  check('没有漏网的 glossary PUT（形状不符）', otherPuts.length === 0, otherPuts.slice(0, 3));
  check(`页面停在预期页码（page=${pageParam === null ? '(无)' : pageParam}，期望 ${c.expPage}）`, c.expPage === 1 ? (pageParam === null || pageParam === '1') : pageParam === String(c.expPage), { url: location.href });
  check('提示文案含预期信息', toasts.some((t) => c.toast.test(t)), toasts.slice(-3));
  if (c.append) check('追加模式逐本 GET（真读）', Object.keys(getKeys).length === putTotal, { get: Object.keys(getKeys).length, put: putTotal });

  // 零写入抽检：拿前 3 本被 PUT 过的书，真读 glossary，应不含唯一测试词条
  const spot = keys.slice(0, 3);
  let leaked = 0; const spotInfo = [];
  for (const k of spot) {
    const [p, id] = k.split('/');
    try {
      const r = await origFetch(`${location.origin}/api/novel/${p}/${id}`, true, {});
      const j = await r.json();
      const hit = !!(j.glossary && j.glossary['zzテスト用語']);
      if (hit) leaked++;
      spotInfo.push({ k, status: r.status, has: hit, n: j.glossary ? Object.keys(j.glossary).length : null });
    } catch (e) { spotInfo.push({ k, err: String(e).slice(0, 60) }); }
  }
  check('零写入：抽检 3 本均无测试词条', leaked === 0 && (spot.length > 0 || c.minPut === 0), spotInfo);
  obs.disconnect();
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
