// LG 导入 GUI e2e：项目页「导出 LG 源文」→「导入 LG 译文」校验 → 提交（lg-import 队列）
// 依赖：mock 8790；daemon 7356（--db daemon/.tmp-lggui.db，预置 mock-trans-lg4-<任意> 书）；CDP 车道 9335
// 跑法：
//   node -e "const {Store}=require(...)"（见 README/尾部备注 seeds）——预置书
//   node daemon/index.mjs serve --port 7356 --db daemon/.tmp-lggui.db （后台）
//   CDP_PORT=9335 node tools/cdp.mjs open http://127.0.0.1:7356/ui && node tools/cdp.mjs evalf tools/.e2e-lg-gui.js
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await pred(); if (v) return v; } catch (e) { out.errors.push(String((e && e.message) || e)); }
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
};

try {
  // 1) 项目页：卡片与两个 LG 动作
  document.querySelector('#side-nav button[data-tab=books]').click();
  const card = await waitFor(() => document.querySelector('#books-table .proj-card'));
  check('项目页渲染出项目卡片', !!card);
  const exportBtn = card && card.querySelector('[data-lgexport]');
  const importBtn = card && card.querySelector('[data-lgimport]');
  check('卡片有「导出 LG 源文」「导入 LG 译文」按钮', !!exportBtn && !!importBtn);

  // 2) 导出：详情区出现行数/章数与路径
  exportBtn.click();
  const exported = await waitFor(() => {
    const box = card.querySelector('.proj-detail');
    return box && box.textContent.includes('已导出 12 行 / 3 章') ? box.textContent : null;
  }, 30000);
  check('导出完成：12 行 / 3 章', !!exported, exported && exported.slice(0, 120));
  check('导出详情含清单路径', !!exported && exported.includes('.manifest.json'), exported && exported.slice(0, 200));

  // 3) 导入面板：上传翻译结果（mock 夹具 12 行：t1=6/t2=4/t3=2）+ 校验
  importBtn.click();
  const panel = await waitFor(() => card.querySelector('[data-lgimport]') && card.querySelector('.proj-detail input[type=file]') ? card.querySelector('.proj-detail') : null);
  check('导入面板出现（file 选择器）', !!panel);
  const sourceLines = [];
  for (let i = 1; i <= 6; i += 1) sourceLines.push('第' + i + '行：アリスが魔導書を読む。');
  for (let i = 1; i <= 4; i += 1) sourceLines.push('第' + i + '行：アリスが魔導書を読む。');
  for (let i = 1; i <= 2; i += 1) sourceLines.push('第' + i + '行：アリスが魔導書を読む。');
  const translated = sourceLines.map((l) => '【译】' + l).join('\n');
  const fileInputs = panel.querySelectorAll('input[type=file]');
  const dt = new DataTransfer();
  dt.items.add(new File([translated], 'lg-result.txt', { type: 'text/plain' }));
  fileInputs[0].files = dt.files;
  const verifyBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '校验');
  verifyBtn.click();
  const report = await waitFor(() => {
    const t = panel.textContent;
    return t.includes('校验：3/3') ? t : null;
  }, 30000);
  check('校验报告：3/3 章通过', !!report, report && report.slice(0, 160));
  check('校验报告含逐章 ✓ 行', !!report && (report.match(/✓/g) || []).length >= 3, report && (report.match(/✓/g) || []).length);
  check('校验报告无疑似未翻', !!report && report.includes('疑似未翻 0 行'), report && report.slice(0, 160));

  // 4) 提交（limit=1）→ 队列出现 lg-import 并跑完
  const limitInput = panel.querySelector('input[type=number]');
  limitInput.value = '1';
  const applyBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '提交通过章');
  check('提交按钮在校验后被启用', !!applyBtn && !applyBtn.disabled);
  applyBtn.click();
  const queued = await waitFor(async () => {
    const st = await fetch('/status').then((r) => r.json());
    const item = (st.queue || []).find((x) => x.job === 'lg-import');
    return item || null;
  }, 15000);
  check('队列出现 lg-import 任务', !!queued, queued && queued.state);
  const done = await waitFor(async () => {
    const st = await fetch('/status').then((r) => r.json());
    const item = (st.queue || []).find((x) => x.job === 'lg-import' && (x.state === 'done' || x.state === 'failed'));
    return item || null;
  }, 60000);
  check('lg-import 执行完成且上传 1 章', !!done && done.state === 'done' && done.stats && done.stats.uploaded === 1, done && JSON.stringify(done.stats));
  // 5) 面板内进度输出：完成摘要 + 逐章结果
  const summary = await waitFor(() => {
    const t = panel.textContent;
    return t.includes('上传 1 · 失败 0') ? t : null;
  }, 15000);
  check('面板内可见完成摘要（上传 1 · 失败 0）', !!summary, summary && summary.slice(-200));
  check('面板内有逐章结果行（✓）', !!summary && (summary.match(/✓/g) || []).length >= 1, summary && (summary.match(/✓/g) || []).length);
  out.notes.push('清理：任务与上传文件保留在临时 daemon/目录（由外部脚本删除）');
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
