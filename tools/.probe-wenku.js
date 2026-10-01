// 只读探测 v2：找有已上传日文卷的文库小说，验证 translate-v2 取文链路（全部 GET）
const token = (JSON.parse(localStorage.getItem('auth') || '{}').profile || {}).token;
const H = { Authorization: 'Bearer ' + token };
const j = async (u) => {
  const r = await fetch(u, { headers: H });
  const t = await r.text();
  let body;
  try { body = JSON.parse(t); } catch (e) { body = t.slice(0, 200); }
  return { status: r.status, body };
};

const list = await j('/api/wenku?page=1&pageSize=20');
const items = (list.body && list.body.items) || [];
const out = { novels: [] };

for (const it of items) {
  const dto = await j('/api/wenku/' + it.id);
  const b = dto.body || {};
  const vj = b.volumeJp || [];
  out.novels.push({
    id: it.id,
    title: b.titleZh || b.title,
    jp: vj.length,
    zh: (b.volumeZh || []).length,
    glossary: Object.keys(b.glossary || {}).length,
    first: vj[0] ? { volumeId: vj[0].volumeId, total: vj[0].total, gpt: vj[0].gpt } : null,
  });
}

const target = out.novels.find((n) => n.jp > 0);
if (target) {
  const vid = encodeURIComponent(target.first.volumeId);
  const task = await j(`/api/wenku/${target.id}/translate-v2/gpt/${vid}`);
  out.task = {
    status: task.status,
    tocLen: task.body && task.body.toc ? task.body.toc.length : task.body,
    glossaryId: task.body && task.body.glossaryId,
    firstToc: task.body && task.body.toc ? task.body.toc[0] : null,
  };
  const ch = task.body && task.body.toc && task.body.toc[0];
  if (ch) {
    const ct = await j(`/api/wenku/${target.id}/translate-v2/gpt/${vid}/chapter-task/${ch.chapterId}`);
    const cb = ct.body || {};
    out.chapter = {
      status: ct.status,
      keys: Object.keys(cb),
      paras: cb.paragraphJp ? cb.paragraphJp.length : null,
      sample: cb.paragraphJp ? cb.paragraphJp.slice(0, 2) : cb,
      oldZh: cb.oldParagraphZh ? cb.oldParagraphZh.length : null,
    };
  }
}
return out;
