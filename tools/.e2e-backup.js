// 队列备份导出/导入 + 清理 + 删除墓碑 回归测试（自检，会自己造数并清理）
// 跑法：cdp open http://127.0.0.1:8788/novel/mock/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-backup.js
// ⚠️ 用例会清空队列，只许在测试 profile / 离线 mock 页上跑
const out = { checks: [], steps: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const log = (k, v) => out.steps.push(k + ': ' + JSON.stringify(v));
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;

try {
  for (const j of await Q.list()) await Q.remove(j.id);

  // ---------- 造数：两条任务，其中一条带 entries 且状态是 running ----------
  const mk = async (title, extra) => {
    const c = await Q.addJobs([{ kind: 'wenku', novelId: 'mock-src', title }], { ...Q.extractSettings(), workerId: '' });
    const job = Object.assign(c[0], extra || {});
    await Q.put(job);
    return job;
  };
  const j1 = await mk('备份用例甲', { state: 'running', entries: [{ src: 'アリス', dst: '爱丽丝', count: 3 }], resultCount: 1 });
  const j2 = await mk('备份用例乙', { state: 'review' });
  log('created', (await Q.list()).map((j) => [j.title, j.state]));

  // ---------- 导出 ----------
  const backup = await Q.exportBackup();
  check('导出带上两条任务', backup.jobs.length === 2 && backup.version === 1, { count: backup.jobs.length, version: backup.version });
  const inBackup = backup.jobs.find((j) => j.id === j1.id);
  check('导出保留 entries', !!inBackup && Array.isArray(inBackup.entries) && inBackup.entries.length === 1, inBackup && inBackup.entries);
  check('导出把 running 归一成 pending', inBackup && inBackup.state === 'pending', inBackup && inBackup.state);

  // ---------- 删除 → 全空 ----------
  for (const j of await Q.list()) await Q.remove(j.id);
  check('删除后队列为空', (await Q.list()).length === 0);

  // ---------- 导入回来 ----------
  const added = await Q.importBackup(backup);
  const jobs1 = await Q.list();
  check('导入两条', added === 2 && jobs1.length === 2, { added, jobs: jobs1.map((j) => [j.title, j.state]) });
  check('导入后 running 归一成 pending，review 保持原样',
    (jobs1.find((j) => j.id === j1.id) || {}).state === 'pending' && (jobs1.find((j) => j.id === j2.id) || {}).state === 'review',
    jobs1.map((j) => [j.title, j.state]));
  check('导入保留 entries', (jobs1.find((j) => j.id === j1.id) || {}).entries.length === 1);
  check('重复导入同一份备份不会翻倍', (await Q.importBackup(backup)) === 0 && (await Q.list()).length === 2);

  // ---------- 删除墓碑：删过又导入的任务，put() 必须还能写进去 ----------
  const revived = await Q.get(j1.id);
  revived.state = 'done';
  await Q.put(revived);
  check('删除过又导入的任务，put() 仍能写状态（墓碑已清）', (await Q.get(j1.id)).state === 'done');
  const removed = await Q.cleanup(0);
  check('cleanup(0) 删掉那条 completed 任务', removed === 1 && (await Q.list()).length === 1, { removed, remaining: (await Q.list()).length });

  // ---------- cleanup 的保留数语义 ----------
  const one = (await Q.list())[0];
  one.state = 'done';
  await Q.put(one);
  check('cleanup(1) 保留 1 条不删', (await Q.cleanup(1)) === 0 && (await Q.list()).length === 1);
  check('cleanup(0) 再删干净', (await Q.cleanup(0)) === 1 && (await Q.list()).length === 0);

  // ---------- 删除任务要顺手清掉它的分块缓存 ----------
  await Q.importBackup(backup);
  const target = (await Q.list())[0];
  await D.GlossaryDB.put('chunks', { id: `job:${target.id}/r0/c0`, entries: [{ src: 'x', dst: 'y' }], lines: [] });
  const before = (await D.GlossaryDB.getAll('chunks')).filter((c) => String(c.id).startsWith('job:' + target.id)).length;
  await Q.remove(target.id);
  const after = (await D.GlossaryDB.getAll('chunks')).filter((c) => String(c.id).startsWith('job:' + target.id)).length;
  check('删除任务会清掉它的分块缓存', before === 1 && after === 0, { before, after });

  // ---------- 坏备份 ----------
  let badErr = '';
  try { await Q.importBackup({ nope: 1 }); } catch (e) { badErr = String(e && e.message); }
  check('坏备份给出明确报错', /备份格式不正确/.test(badErr), badErr);
  check('坏备份不改变队列', (await Q.list()).length === 1);
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  for (const j of await Q.list()) await Q.remove(j.id);
  out.steps.push('cleanup: 队列已清空');
}
return JSON.stringify(out, null, 1);
