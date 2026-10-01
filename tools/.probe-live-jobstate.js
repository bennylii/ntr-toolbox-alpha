const out = {};
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
try {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const jtx = db.transaction('jobs', 'readonly');
  const jobs = await reqP(jtx.objectStore('jobs').getAll());
  out.jobs = jobs.map((j) => ({
    id: j.id, state: j.state, round: j.round, done: j.doneChunks, fail: j.failChunks, total: j.totalChunks,
    maxLines: j.options && j.options.maxLines, workerId: j.options && j.options.workerId,
    created: j.createdAt, updated: j.updatedAt, error: j.error ? String(j.error).slice(0, 120) : null,
    target: j.target && (j.target.title || j.target.novelId),
  }));
  const ctx = db.transaction('chunks', 'readonly');
  const chunks = await reqP(ctx.objectStore('chunks').getAll());
  out.chunkCount = chunks.length;
  out.chunkSample = chunks.slice(0, 6).map((c) => ({ id: c.id, state: c.state, round: c.round, error: c.error ? String(c.error).slice(0, 160) : null, entries: c.entries ? c.entries.length : undefined }));
  db.close();
  const now = performance.now();
  out.llm = performance.getEntriesByType('resource').filter((e) => /deepseek|chat\/completions/i.test(e.name))
    .map((e) => ({ ago: Math.round((now - e.startTime) / 1000) + 's', dur: Math.round(e.duration / 1000) + 's' })).slice(-10);
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
