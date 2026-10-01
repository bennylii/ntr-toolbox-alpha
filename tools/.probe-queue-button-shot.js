// 截图用：队列面板按钮态。先 cdp eval "window.__qbShot='empty'|'rows'" 再 evalf 本文件，再 cdp shot
//   empty → 空队列：工具栏四键全禁用
//   rows  → 三行任务：曾有失败=真「重跑」/ 干净完成=置灰「重跑」/ 有未处理行=「重试」
const D = window._NTRGlossaryDev, Q = D.GlossaryQueue;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = window.__qbShot || 'empty';
Q.stop();
for (const j of await Q.list()) await Q.remove(j.id);
const old = document.getElementById('ntr-queue-overlay');
if (old) old.remove();
await Q.openPanel();
await sleep(400);
if (mode === 'rows') {
  const mk = async (title, patch) => {
    const created = await Q.addJobs([{ kind: 'wenku', novelId: 'mock-src', title }], {
      ...Q.extractSettings(), sourceLanguage: 'JA', maxLines: 0, workerId: '',
      testModel: 'mock-glossary-1', testKey: 'x', testEndpoint: 'http://127.0.0.1:8788?run=' + Date.now(),
    });
    Object.assign(created[0], patch);
    await Q.put(created[0]);
  };
  await mk('曾有失败但有救回（重跑=真按钮）', {
    state: 'review', entries: [{ src: 'アリス', dst: '爱丽丝' }], resultCount: 1,
    progress: { round: 3, maxRounds: 3, chunksDone: 5, chunksFailed: 9, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 4, chunksBase: 1, timerBase: 1, roundStartedAt: Date.now() },
  });
  await mk('干净完成（重跑置灰=点了不会空跑）', {
    state: 'review', entries: [{ src: 'アリス', dst: '爱丽丝' }], resultCount: 1,
    progress: { round: 1, maxRounds: 3, chunksDone: 3, chunksFailed: 0, pendingLines: 0, totalLines: 37, covered: 37, uncovered: 0, totalChunks: 3, chunksBase: 0, timerBase: 0, roundStartedAt: Date.now() },
  });
  await mk('还有没跑到的行（只给重试）', {
    state: 'review', entries: [{ src: 'アリス', dst: '爱丽丝' }], resultCount: 1,
    progress: { round: 3, maxRounds: 3, chunksDone: 7, chunksFailed: 3, pendingLines: 59, totalLines: 200, covered: 141, uncovered: 59, totalChunks: 5, chunksBase: 3, timerBase: 3, roundStartedAt: Date.now() },
  });
  await sleep(1800);
}
const rows = Array.from(document.querySelectorAll('#ntr-queue-overlay tbody tr'));
return JSON.stringify({
  mode,
  toolbar: Array.from(document.querySelectorAll('#ntr-queue-overlay .ntr-g-toolbar button')).map((b) => ({ t: b.textContent, dis: b.disabled })),
  rows: rows.map((r) => ({ title: (r.children[0] || {}).textContent, prog: (r.children[2] || {}).textContent, ops: Array.from(r.querySelectorAll('button')).map((b) => ({ t: b.textContent, dim: b.style.opacity === '0.65' })) })),
});
