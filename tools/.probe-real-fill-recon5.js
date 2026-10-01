// 真站侦察 5（只读）：找"只有 1 页但有结果"的查询（单页边界用）
const out = { notes: [], data: {} };
try {
  const T = window._NTRToolBox;
  const all = 'kakuyomu,novelup,hameln,pixiv,alphapolis,syosetu';
  const cases = [
    { q: 'エリルキア', prov: all },
    { q: 'ニトラ・ステラの魔導書', prov: all },
    { q: 'ざまぁ', prov: all },
    { q: '魔法', prov: 'hameln' },
    { q: '魔法', prov: 'novelup' },
    { q: '魔法', prov: 'pixiv' },
    { q: '魔法', prov: 'alphapolis' },
  ];
  out.data.list = [];
  for (const c of cases) {
    try {
      const r = await T.fetch(`/api/novel?page=1&pageSize=20&query=${encodeURIComponent(c.q)}&provider=${c.prov}&type=0&level=0&translate=0&sort=0`, true, {});
      const j = r.ok ? await r.json() : null;
      out.data.list.push({ q: c.q, prov: c.prov, status: r.status, pageNumber: j && j.pageNumber, items: j && j.items && j.items.length, first: j && j.items && j.items[0] && (j.items[0].titleZh || j.items[0].titleJp) });
    } catch (e) { out.data.list.push({ q: c.q, prov: c.prov, err: String(e).slice(0, 80) }); }
  }
} catch (e) {
  (out.errors = out.errors || []).push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
