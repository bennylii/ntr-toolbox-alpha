// 真站侦察 3（只读 + 纯点击浏览）：div 结构分页的点击可行性、翻页耗时、站点自身 /api/novel 请求的真实 URL/返回
const out = { notes: [], data: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const firstItem = () => { const a = [...document.querySelectorAll('a')].find((x) => /^\/novel\/[^/]+\/[^/]+$/.test(x.getAttribute('href') || '')); return a ? a.getAttribute('href') : ''; };
  const pag1 = document.querySelector('.n-pagination');
  const btns = [...pag1.querySelectorAll('.n-pagination-item--button')];
  out.data.buttonItems = btns.map((b) => ({
    cls: b.className,
    pos: b === btns[0] ? 'first' : 'last',
    child: b.firstElementChild && b.firstElementChild.tagName,
    hasDisabledAttr: b.getAttribute('disabled') !== null,
    aria: b.getAttribute('aria-label'),
  }));
  out.data.item2 = [...pag1.querySelectorAll('.n-pagination-item--clickable')].find((d) => d.textContent.trim() === '2') ? 'found' : 'missing';

  // 记录站点自身发起的 fetch（含 URL 与响应摘要），点击「2」后还原
  const origFetch = window.fetch;
  const seen = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const res = await origFetch(input, init);
    if (/\/api\/novel(\?|$)/.test(url)) {
      const clone = res.clone();
      clone.text().then((t) => {
        let head = t.slice(0, 200);
        let sum = null;
        try { const j = JSON.parse(t); sum = { pageNumber: j.pageNumber, items: j.items ? j.items.length : null, first: j.items && j.items[0] && (j.items[0].titleZh || j.items[0].titleJp) }; } catch (e) { }
        seen.push({ url, status: res.status, sum: sum || head });
      }).catch(() => { });
    }
    return res;
  };

  const before = firstItem();
  const t0 = Date.now();
  const item2 = [...pag1.querySelectorAll('.n-pagination-item--clickable')].find((d) => d.textContent.trim() === '2');
  item2.click();
  let swapMs = null;
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    if (firstItem() !== before) { swapMs = Date.now() - t0; break; }
  }
  await sleep(300);
  window.fetch = origFetch;
  out.data.swapMs = swapMs;
  out.data.urlAfter = location.href;
  out.data.firstAfter = firstItem();
  out.data.siteRequests = seen.slice(0, 4);

  // 回第 1 页（点「1」），等换回
  const item1 = [...document.querySelectorAll('.n-pagination .n-pagination-item--clickable')].find((d) => d.textContent.trim() === '1');
  if (item1) { const b2 = firstItem(); item1.click(); for (let i = 0; i < 100; i++) { await sleep(100); if (firstItem() !== b2) break; } }
  out.data.urlBack = location.href;
} catch (e) {
  (out.errors = out.errors || []).push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
