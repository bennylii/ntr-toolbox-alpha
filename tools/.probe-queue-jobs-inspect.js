// 只读检查：真站 origin 上队列任务的失败形态 + 面板将渲染的按钮（重试/重跑/置灰）
const out = { notes: [], jobs: [] };
try {
  const D = window._NTRGlossaryDev;
  const Q = D.GlossaryQueue;
  out.loop = Q._state();
  const jobs = await Q.list();
  for (const job of jobs) {
    const totalLinesN = job.progress && Number(job.progress.totalLines) > 0 ? Number(job.progress.totalLines) : 0;
    const coveredN = job.progress ? Number(job.progress.covered) : NaN;
    const leftLines = (totalLinesN > 0 && Number.isFinite(coveredN))
      ? Math.max(0, totalLinesN - coveredN)
      : (job.progress ? Number(job.progress.pendingLines) || 0 : 0);
    const running = job.state === 'running';
    const partial = leftLines > 0;
    const anyFail = job.everFailed === true || Number(job.progress && job.progress.chunksFailed) > 0;
    const cacheComplete = !!job.progress && totalLinesN > 0 && Number.isFinite(coveredN) && coveredN >= totalLinesN && !anyFail;
    const willRenderRetry = !running && (partial || (job.state === 'pending' && job.progress));
    const willRenderRerun = !running && job.state !== 'pending' && ['failed', 'review', 'done'].includes(job.state) && (!partial || job.state === 'failed');
    out.jobs.push({
      title: job.title, state: job.state, error: job.error,
      everFailed: job.everFailed, chunksFailed: job.progress && job.progress.chunksFailed,
      totalLines: totalLinesN, covered: Number.isFinite(coveredN) ? coveredN : null, leftLines, partial, anyFail, cacheComplete,
      retry: willRenderRetry ? '渲染' : '不渲染',
      rerun: willRenderRerun ? (cacheComplete ? '置灰(不能跑)' : '真按钮') : '不渲染',
    });
  }
  out.notes.push('jobs=' + jobs.length);
} catch (e) { out.errors = [String((e && e.stack) || e)]; }
return JSON.stringify(out, null, 1);
