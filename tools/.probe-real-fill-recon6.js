// 真站侦察 6（只读）：继续找"单页有结果"（含 type=3 短篇过滤）与更短的"末页"用词
const out = { notes: [], data: {} };
try {
  const T = window._NTRToolBox;
  const all = 'kakuyomu,novelup,hameln,pixiv,alphapolis,syosetu';
  const cases = [
    { q: 'ぬいぐるみ', prov: 'hameln' },
    { q: 'ぬいぐるみ', prov: 'novelup' },
    { q: '魔導書', prov: 'hameln' },
    { q: '魔導書', prov: 'novelup' },
    { q: 'ラノベ', prov: 'hameln' },
    { q: '魔法', prov: all, type: 3 },
    { q: '魔法', prov: 'novelup', type: 3 },
    { q: 'ざまぁ', prov: 'hameln' },
  ];
  out.data.list = [];
  for (const c of cases) {
    try {
      const r = await T.fetch(`/api/novel?page=1&pageSize=20&query=${encodeURIComponent(c.q)}&provider=${c.prov}&type=${c.type || 0}&level=0&translate=0&sort=0`, true, {});
      const j = r.ok ? await r.json() : null;
      out.data.list.push({ q: c.q, prov: c.prov, type: c.type || 0, status: r.status, pageNumber: j && j.pageNumber, items: j && j.items && j.items.length, first: j && j.items && j.items[0] && (j.items[0].titleZh || j.items[0].titleJp) });
    } catch (e) { out.data.list.push({ q: c.q, prov: c.prov, err: String(e).slice(0, 80) }); }
  }
} catch (e) {
  (out.errors = out.errors || []).push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
