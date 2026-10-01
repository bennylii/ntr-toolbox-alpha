// 真站侦察 4（只读）：候选查询词的页数（给"末页停/单页/零结果"边界选词）
// 注意：列表接口要带 token（纯页面 fetch 会 401）→ 走注入实例的 _NTRToolBox.fetch
const out = { notes: [], data: {} };
try {
  const T = window._NTRToolBox;
  const prov = 'kakuyomu,novelup,hameln,pixiv,alphapolis,syosetu';
  const cands = ['ロセッティ', 'スカルファロット', 'ぬいぐるみ', '魔導書', 'ハムスター', 'ラノベ', 'zzzqqq不存在不存在'];
  out.data.list = [];
  for (const q of cands) {
    try {
      const r = await T.fetch(`/api/novel?page=1&pageSize=20&query=${encodeURIComponent(q)}&provider=${prov}&type=0&level=0&translate=0&sort=0`, true, {});
      const j = r.ok ? await r.json() : null;
      out.data.list.push({ q, status: r.status, pageNumber: j && j.pageNumber, items: j && j.items && j.items.length, first: j && j.items && j.items[0] && (j.items[0].titleZh || j.items[0].titleJp) });
    } catch (e) { out.data.list.push({ q, err: String(e).slice(0, 80) }); }
  }
} catch (e) {
  (out.errors = out.errors || []).push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
