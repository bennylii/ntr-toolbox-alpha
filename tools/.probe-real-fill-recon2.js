// 真站侦察 2（只读）：n-pagination 的真实 DOM 结构 + /api/novel 各参数变体的原始返回 + 列表首条标题
const out = { notes: [], data: {} };
try {
  const T = window._NTRToolBox;

  // 1) n-pagination 真实结构：整棵子树的关键元素
  const pags = [...document.querySelectorAll('.n-pagination')];
  out.data.pagination = pags.map((p) => ({
    visible: !!(p.offsetWidth || p.offsetHeight),
    cls: p.className,
    html: p.outerHTML.slice(0, 700),
    kids: [...p.querySelectorAll('*')].slice(0, 30).map((e) => ({
      tag: e.tagName.toLowerCase(),
      cls: (e.className || '').toString().slice(0, 60),
      role: e.getAttribute('role'),
      aria: e.getAttribute('aria-label'),
      disabled: e.getAttribute('disabled') !== null || e.disabled === true,
      text: (e.textContent || '').trim().slice(0, 12),
    })),
  }));

  // 2) 列表首条标题（看搜索是否真的过滤了）
  const firstA = [...document.querySelectorAll('a')].find((x) => /^\/novel\/[^/]+\/[^/]+$/.test(x.getAttribute('href') || ''));
  out.data.firstItemText = firstA ? firstA.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : null;
  out.data.firstItemHref = firstA ? firstA.getAttribute('href') : null;

  // 3) /api/novel 参数变体（只读）
  const variants = [
    'page=1&pageSize=20&query=' + encodeURIComponent('魔法') + '&provider=&type=0&level=0&translate=0&sort=0',
    'page=1&pageSize=20&query=' + encodeURIComponent('魔法'),
    'page=1&pageSize=20&query=',
    'page=1&pageSize=20&query=' + encodeURIComponent('魔法') + '&provider=&type=0&level=0&translate=0&sort=1',
  ];
  out.data.novelList = [];
  for (const v of variants) {
    try {
      const r = await T.fetch('/api/novel?' + v, true, {});
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch (e) { }
      out.data.novelList.push({
        q: v.slice(0, 90),
        status: r.status,
        keys: j ? Object.keys(j) : null,
        pageNumber: j && j.pageNumber,
        items: j && j.items ? j.items.length : null,
        first: j && j.items && j.items[0] ? (j.items[0].titleZh || j.items[0].titleJp || Object.keys(j.items[0]).slice(0, 6)) : null,
        rawHead: !j ? text.slice(0, 120) : null,
      });
    } catch (e) { out.data.novelList.push({ q: v.slice(0, 90), err: String(e).slice(0, 100) }); }
  }
} catch (e) {
  (out.errors = out.errors || []).push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
