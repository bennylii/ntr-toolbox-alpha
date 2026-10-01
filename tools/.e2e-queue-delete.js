// 队列「删除」不能复活：跑着的任务删掉后，分块回写不许把它写回 IDB，循环也要停下
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-queue-delete.js
// （mock-src 的文库书带「一卷两章」假正文，队列能真的跑起来）
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const Q = window._NTRGlossaryDev.GlossaryQueue;
const dev = window._NTRGlossaryDev;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listJobs = async () => (await Q.list());
const clearAll = async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const names = ['jobs', 'chunks'].filter((n) => db.objectStoreNames.contains(n));
  const tx = db.transaction(names, 'readwrite');
  names.forEach((n) => tx.objectStore(n).clear());
  await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  db.close();
};

try {
  await clearAll();
  Q.stop();
  await sleep(300);

  const target = await dev.resolveGlossaryTarget();
  check('mock 页面能解析出目标', !!target, target && target.kind);
  const options = {
    ...Q.extractSettings(),
    sourceLanguage: 'JA',
    budgetChars: 300,
    maxRounds: 1,
    concurrency: 1,
    maxLines: 90,
    workerId: '',
    testEndpoint: 'http://127.0.0.1:8788?slow=1200&run=' + Date.now(),
    testModel: 'mock-glossary-1',
    testKey: 'x',
  };
  await Q.addJobs([target], options);
  const created = (await listJobs())[0];
  check('入队成功', !!created && created.state === 'pending', created && created.state);

  Q.runLoop();
  const t0 = Date.now();
  let sawRunning = false;
  while (Date.now() - t0 < 8000) {
    const j = (await listJobs())[0];
    if (j && j.state === 'running') { sawRunning = true; break; }
    if (!j) break;
    await sleep(120);
  }
  check('任务进入「提取中」（能删的是跑着的任务）', sawRunning, Q._state());

  await Q.remove(created.id);
  const afterRemove = await listJobs();
  check('删除后立刻没了', afterRemove.length === 0, afterRemove.map((j) => j.id));

  // 关键：等一个分块的时长，看它会不会被回写"复活"
  await sleep(3000);
  const afterWait = await listJobs();
  check('等待一个分块后仍然 0 条（没有被 put 复活）', afterWait.length === 0, afterWait.map((j) => ({ id: j.id, state: j.state })));
  check('删除同时请求了停止：循环已退出', Q._state().loopActive === false, Q._state());

  const chunks = await new Promise((res, rej) => {
    const r = indexedDB.open('ntr-glossary', 1);
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('chunks', 'readonly'); const g = tx.objectStore('chunks').getAll(); g.onsuccess = () => { res(g.result.map((c) => c.id)); db.close(); }; };
    r.onerror = () => rej(r.error);
  });
  check('该任务的分块缓存也被清掉了', chunks.filter((id) => String(id).includes(created.id)).length === 0, chunks);

  // 再看一眼：正常入队 + 跑完还是能跑（删除守卫不会误伤新任务）
  await clearAll();
  await Q.addJobs([target], { ...options, maxLines: 30, testEndpoint: 'http://127.0.0.1:8788?run=' + Date.now() });
  const fresh = (await listJobs())[0];
  Q.runLoop();
  const t1 = Date.now();
  let final = null;
  while (Date.now() - t1 < 30000) {
    final = (await listJobs())[0];
    if (final && (final.state === 'done' || final.state === 'confirm' || final.state === 'failed')) break;
    await sleep(300);
  }
  check('新任务照常跑完（守卫不影响正常流程）', !!final && final.state !== 'pending' && final.state !== 'running', final && { state: final.state, entries: final.resultCount, error: final.error });
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  await clearAll();
  out.notes.push('cleanup: 队列/分块已清空、循环已停');
}
return JSON.stringify(out, null, 1);
