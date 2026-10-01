// 真站侦察（只读）：/novel 列表页的分页 DOM、条目链接、面板模块可见性、auth-v2 与端点状态、工作区翻译器存储、下一页刷新耗时
// 跑法：cdp open "https://n.novelia.cc/novel?query=%E9%AD%94%E6%B3%95" + inject 后 evalf 本文件
const out = { notes: [], data: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const T = window._NTRToolBox;
  out.data.url = location.href;
  out.data.hasToolbox = !!T;
  out.data.panelCount = document.querySelectorAll('#ntr-panel').length;

  // 1) 面板里可见的模块
  if (T) {
    out.data.modules = [...document.querySelectorAll('#ntr-panel .ntr-module-header')]
      .map((h) => ({ name: h.textContent.replace(/\s+/g, ' ').trim().slice(0, 24), visible: h.parentElement.style.display !== 'none' }));
  }

  // 2) 分页 DOM
  const pags = [...document.querySelectorAll('.n-pagination')];
  out.data.pagination = {
    count: pags.length,
    buttons: pags.map((p) => [...p.querySelectorAll('button')].map((b) => ({
      t: (b.textContent || '').trim(),
      aria: b.getAttribute('aria-label'),
      disabled: b.disabled,
    }))),
  };

  // 3) 条目链接
  const links = [...document.querySelectorAll('a')]
    .map((a) => a.getAttribute('href') || '')
    .filter((h) => /^\/novel\/[^/]+\/[^/]+$/.test(h));
  out.data.items = { count: links.length, first: links.slice(0, 5) };

  // 4) workspace 翻译器存储（只报 id，不打印 endpoint/key）
  const rd = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } };
  const w1 = rd('workspace-gpt'), w2 = rd('workspace-gpt-pipeline');
  out.data.workspace = {
    gpt: (w1.workers || []).map((w) => w && w.id),
    pipeline: (w2.workers || []).map((w) => w && w.id),
  };

  // 5) auth-v2 与端点（不打印 token 本体）
  const v2 = rd('auth-v2');
  const t = T && T.initToken();
  out.data.auth = { hasAuthV2: !!v2.token, tokenFromV2: !!(t && v2.token && t === v2.token), tokenLen: t ? t.length : 0 };
  const q = 'page=1&pageSize=20&query=' + encodeURIComponent('魔法') + '&provider=&type=0&level=0&translate=0&sort=0';
  const stat = async (u) => { try { const r = await T.fetch(u, true, {}); return { status: r.status }; } catch (e) { return { err: String(e).slice(0, 100) }; } };
  out.data.endpoints = { favored: await stat('/api/user/favored'), novelList: await stat('/api/novel?' + q) };
  try {
    const r = await T.fetch('/api/novel?' + q, true, {});
    if (r.ok) {
      const j = await r.json();
      out.data.endpoints.novelListJson = {
        pageNumber: j.pageNumber,
        items: (j.items || []).length,
        firstTitle: j.items && j.items[0] && (j.items[0].titleZh || j.items[0].titleJp),
      };
    }
  } catch (e) { }

  // 6) 下一页点击实测：点"下一页"→ 测列表刷新耗时 → 点回第 1 页
  const firstItem = () => { const a = [...document.querySelectorAll('a')].find((x) => /^\/novel\/[^/]+\/[^/]+$/.test(x.getAttribute('href') || '')); return a ? a.getAttribute('href') : ''; };
  const nextBtn = [...document.querySelectorAll('.n-pagination button')].find((b) => (b.textContent || '').includes('下') || (b.getAttribute('aria-label') || '').toLowerCase().includes('next'));
  out.data.nextBtnFound = !!nextBtn;
  if (nextBtn) {
    const before = firstItem();
    const t0 = Date.now();
    nextBtn.click();
    let swapMs = null;
    for (let i = 0; i < 120; i++) {
      await sleep(100);
      if (firstItem() !== before) { swapMs = Date.now() - t0; break; }
    }
    out.data.swapMs = swapMs;
    out.data.urlAfterNext = location.href;
    const prevBtn = [...document.querySelectorAll('.n-pagination button')].find((b) => (b.textContent || '').includes('上') || (b.getAttribute('aria-label') || '').toLowerCase().includes('prev'));
    if (prevBtn) { prevBtn.click(); await sleep(800); }
    out.data.urlRestored = location.href;
  }
} catch (e) {
  (out.errors = out.errors || []).push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
