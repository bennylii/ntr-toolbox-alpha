// 冒烟：队列「筛选」（auditJob）真跑一轮，标记是否回写 job.entries
const D = window._NTRGlossaryDev;
const Q = D.GlossaryQueue;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: [], errors: [] };
try {
  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);
  const options = {
    ...Q.extractSettings(),
    testEndpoint: 'http://127.0.0.1:8788?audit=2&run=' + Date.now(),
    testModel: 'mock-glossary-1',
    testKey: 'x',
    timeoutMs: 20000,
  };
  const created = await Q.addJobs([{ kind: 'wenku', novelId: 'mock-1', title: '审计探针' }], options);
  const job = created[0];
  job.state = 'review';
  job.resultCount = 4;
  job.entries = [
    { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 871 },
    { src: '代々木駅', dst: '代代木站', type: '地名', count: 1 },
    { src: '教室', dst: '教室', type: '地名', count: 9 },
    { src: 'ボブ', dst: '鲍勃', type: '男性人名', count: 30 },
  ];
  await Q.put(job);
  out.beforeMarks = job.entries.filter((e) => e.audit).length;
  const res = await Q.auditJob(job.id);
  out.res = { size: res.marks.size, unmatched: res.unmatched, batches: res.batches, failed: res.failed };
  const after = await Q.get(job.id);
  out.entries = after.entries.map((e) => [e.src, e.audit ? `${e.audit.why}/${e.audit.note}` : null]);
  out.auditAt = !!after.auditAt;

  // 预览弹层：标记是否带出来 + 页签 + 统计
  await Q.openPanel();
  await sleep(400);
  const panel = document.getElementById('ntr-queue-overlay');
  const previewBtn = panel && Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === '预览');
  out.panelHasFilterBtn = !!(panel && Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === '筛选'));
  if (previewBtn) previewBtn.click();
  let ov = null;
  for (let i = 0; i < 40 && !ov; i++) {
    const el = document.getElementById('ntr-glossary-overlay');
    if (el && el.querySelector('thead th')) ov = el; else await sleep(100);
  }
  out.stats = ov && ov.querySelector('.ntr-g-stats').textContent;
  out.tab = ov && ov.querySelector('#ntr-g-audit-tab').textContent;
  out.tabVisible = ov && ov.querySelector('#ntr-g-audit-tab').style.display !== 'none';
  out.badges = ov ? Array.from(ov.querySelectorAll('tbody tr')).map((tr) => tr.textContent.includes('建议删') ? 'audit' : '') .filter(Boolean).length : -1;
  const filterBtn = ov && ov.querySelector('#ntr-g-filter-btn');
  if (filterBtn) filterBtn.click();
  await sleep(120);
  const pop = ov && ov.querySelector('#ntr-g-filter-popover');
  out.auditBtnText = pop && pop.querySelector('#ntr-g-audit-btn').textContent;
  out.auditActions = pop && pop.querySelector('#ntr-g-audit-actions') ? pop.querySelector('#ntr-g-audit-actions').textContent : Array.from(pop.querySelectorAll('button')).map((b) => b.textContent).slice(0, 6);
  out.note = pop && pop.querySelector('#ntr-g-audit-note').textContent;
  out.warn = ov && ov.querySelector('.ntr-g-warn').textContent;
  if (ov) { const c = Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭'); if (c) c.click(); }
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  try { Q.stop(); } catch (e) { }
  await sleep(300);
  for (const j of await Q.list()) await Q.remove(j.id);
  out.cleanup = '队列已清空';
}
return JSON.stringify(out, null, 1);
