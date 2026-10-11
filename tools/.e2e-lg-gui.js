// LG 导入 GUI e2e：项目页「导出 LG 源文」→「导入 LG 译文」→ 校验 → 提交（lg-import 队列）
//
// 两种跑法：
//  ① mock 车道（默认，一把跑完；顺带覆盖「站点导出格式( mode=jp )自动对齐」段）：
//       PORT=8790 node mock-llm/server.mjs
//       node daemon/index.mjs serve --port 7356 --db daemon/.tmp-lggui.db      # 预置 web:mock / mock-trans-lg4-<任意>
//       CDP_PORT=9335 node tools/cdp.mjs open http://127.0.0.1:7356/ui
//       CDP_PORT=9335 node tools/cdp.mjs evalf tools/.e2e-lg-gui.js
//  ② 真机车道（分阶段跑，避免单条 CDP 命令超时；文件用 cdp setfiles 塞真实路径，不经页面构造）：
//       # 先设好阶段参数（bookKey / expect / limit），再按 export → open → setfiles → verify → apply → await 依次执行
//       CDP_PORT=9333 CDP_TIMEOUT_MS=400000 node tools/cdp.mjs eval "window.__LG_GUI_TEST={bookKey:'web:syosetu/n7608cw',expect:{lines:34651,chapters:167},limit:5}"
//       CDP_PORT=9333 CDP_TIMEOUT_MS=400000 node tools/cdp.mjs evalf tools/.e2e-lg-gui.js      # phase=export
//       ... setfiles / verify / apply / await（见 README/AGENTS 的跑法备注）
//  阶段由 window.__LG_GUI_TEST.phase 决定：all（默认）/ export / open / verify / apply / await
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

const T = (typeof window !== 'undefined' && window.__LG_GUI_TEST) || null;
const CFG = {
  phase: (T && T.phase) || 'all',
  bookKey: (T && T.bookKey) || '',
  expect: (T && T.expect) || null,
  limit: T && T.limit !== undefined ? Math.max(0, Number(T.limit) || 0) : 1,
  limitSiteFmt: T && T.limitSiteFmt !== undefined ? Math.max(0, Number(T.limitSiteFmt) || 0) : 0,
  noClick: !!(T && T.noClick),              // 真机分阶段：校验已由 verify-start 点过，这里只等报告 + 断言
  reportWaitMs: T && T.reportWaitMs ? Math.max(5000, Number(T.reportWaitMs)) : 400000,
};
const cardOf = () => document.querySelector('#books-table .proj-card' + (CFG.bookKey ? '[data-pk="' + CFG.bookKey.replace(/"/g, '\\"') + '"]' : ''));
const boxOf = (card) => card && card.querySelector('.proj-detail');
const btnByText = (root, text) => [...(root || document).querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const openBooksTab = () => { const b = document.querySelector('#side-nav button[data-tab=books]'); if (b && !b.classList.contains('active')) b.click(); };
const queueItem = async (id) => {
  const st = await fetch('/status').then((r) => r.json());
  return (st.queue || []).find((x) => x.id === id) || null;
};
const exportSummary = (text) => {
  const m = /已导出 (\d+) 行 \/ (\d+) 章/.exec(text || '');
  return m ? { lines: Number(m[1]), chapters: Number(m[2]) } : null;
};

// 站点「下载原文」格式夹具（mock 车道用；真机车道用磁盘上的真实文件，见文件头跑法②）
const siteFormatFixture = (prefix) => {
  const transCount = (id) => (id.endsWith('1') ? 6 : id.endsWith('2') ? 4 : 2);
  const lines = ['书名 mock', '', '作者[mock]', '', '标签 / 测试 / ', '总计: 3 / GPT: 3', '', '############', '简介：夹具。', '', '', ''];
  for (const id of ['t1', 't2', 't3']) {
    lines.push('# 章 ' + id, '');
    for (let i = 1; i <= transCount(id); i += 1) lines.push(prefix + '第' + i + '行：アリスが魔導書を読む。');
    lines.push('', '', '');
  }
  return lines.join('\n');
};
const contractFixture = () => {
  const lines = [];
  for (const [id, n] of [['t1', 6], ['t2', 4], ['t3', 2]]) for (let i = 1; i <= n; i += 1) lines.push('第' + i + '行：アリスが魔導書を読む。');
  return lines.map((l) => '【译】' + l).join('\n');
};

// 段落：导出 / 打开导入面板 / 校验 / 提交 / 等队列
const doExport = async () => {
  openBooksTab();
  const card = await waitFor(() => cardOf(), 15000);
  check('项目页渲染出目标项目卡片', !!card, CFG.bookKey || '(第一张卡片)');
  if (!card) return null;
  const exportBtn = card.querySelector('[data-lgexport]');
  check('卡片有「导出 LG 源文」按钮', !!exportBtn);
  exportBtn.click();
  const text = await waitFor(() => {
    const box = boxOf(card);
    return box && exportSummary(box.textContent) ? box.textContent : null;
  }, 400000);
  const sum = exportSummary(text || '');
  check('导出完成（详情区出现行数/章数）', !!sum, text && text.slice(0, 120));
  if (sum) {
    const want = CFG.expect || { lines: 12, chapters: 3 };
    check('导出行数/章数符合预期（' + want.lines + ' 行 / ' + want.chapters + ' 章）', sum.lines === want.lines && sum.chapters === want.chapters, JSON.stringify(sum));
  }
  check('导出详情含清单路径（.manifest.json）', !!(text || '').includes('.manifest.json'), text && text.slice(0, 240));
  return text;
};
const doOpenPanel = async () => {
  const card = await waitFor(() => cardOf(), 15000);
  if (!card) { check('找到项目卡片（打开导入面板）', false); return null; }
  const importBtn = card.querySelector('[data-lgimport]');
  check('卡片有「导入 LG 译文」按钮', !!importBtn);
  importBtn.click();
  const panel = await waitFor(() => {
    const box = boxOf(card);
    return box && box.querySelectorAll('input[type=file]').length >= 2 && btnByText(box, '校验') ? box : null;
  }, 15000);
  check('导入面板出现（两个 file 选择器 + 校验按钮）', !!panel);
  if (panel) {
    const inputs = panel.querySelectorAll('input[type=file]');
    check('结果 txt 选择器已就绪（选择器[0]）', inputs[0].type === 'file' && inputs[0].accept.includes('.txt'));
    check('面板提示清单来源（本会话导出记住 / 可另选）', /清单/.test(panel.textContent));
  }
  return panel;
};
const doVerify = async (panel, opts = {}) => {
  const input = panel.querySelectorAll('input[type=file]')[0];
  const txtFile = input.files && input.files[0];
  check('结果 txt 已选中（files[0] 存在）', !!txtFile, txtFile && (txtFile.name + ' · ' + txtFile.size + 'B'));
  if (opts.clickFirst !== false) btnByText(panel, '校验').click();
  const want = CFG.expect || { lines: 12, chapters: 3 };
  const report = await waitFor(() => {
    const t = panel.textContent;
    return t.includes('校验：') && t.includes('章通过') ? t : null;
  }, CFG.reportWaitMs);
  check('校验报告出现（校验：N/M 章通过）', !!report, report && report.slice(0, 160));
  check('校验结果：' + want.chapters + '/' + want.chapters + ' 章通过', !!report && report.includes('校验：' + want.chapters + '/' + want.chapters + ' 章通过'), report && report.slice(0, 160));
  check('逐章 ✓ 行数 ≥ 3', !!report && (report.match(/✓/g) || []).length >= 3, report && (report.match(/✓/g) || []).length);
  if (opts.expectConverted) {
    check('报告带「已识别站点导出格式」提示（站点模式=jp 输入）', !!report && /已识别站点导出格式/.test(report), report && report.slice(0, 200));
  } else {
    check('契约格式不该出现「自动对齐」提示', !!report && !/已识别站点导出格式/.test(report), report && report.slice(0, 160));
  }
  const applyBtn = btnByText(panel, '提交通过章');
  check('提交按钮已启用', !!applyBtn && !applyBtn.disabled);
  return report;
};
const doApply = async (panel, limit) => {
  if (!panel || !panel.querySelector('input[type=number]')) {
    // 队列跑完会 refresh() 重建项目卡片 → 面板被销毁；这时得重跑 open → setfiles → verify 再提交
    check('提交阶段：导入面板仍在（未被 refresh 重建销毁）', false, '重跑 phase=open → setfiles → verify-start → apply');
    return 0;
  }
  const limitInput = panel.querySelector('input[type=number]');
  limitInput.value = String(limit);
  const applyBtn = btnByText(panel, '提交通过章');
  applyBtn.click();
  const queuedText = await waitFor(() => {
    const t = panel.textContent;
    return /已入队 lg-import #\d+/.test(t) ? t : null;
  }, 15000);
  const m = /已入队 lg-import #(\d+)/.exec(queuedText || '');
  const id = m ? Number(m[1]) : 0;
  check('点「提交通过章」后入队（面板出现队列号）', id > 0, queuedText && queuedText.slice(-160));
  if (id) window.__LG_GUI_LAST = { queueId: id, limit };
  return id;
};
const doAwait = async (id, limit, opts = {}) => {
  const done = await waitFor(async () => {
    const item = await queueItem(id);
    return item && (item.state === 'done' || item.state === 'failed') ? item : null;
  }, opts.timeoutMs || 600000);
  check('lg-import 队列跑完（state=done）', !!done && done.state === 'done', done && JSON.stringify({ state: done.state, stats: done.stats, progress: done.progress }));
  const wantUploaded = limit > 0 ? limit : ((CFG.expect && CFG.expect.chapters) || 3);
  check('上传章数 = ' + wantUploaded + '，失败 0', !!done && done.stats && done.stats.uploaded === wantUploaded && done.stats.failed === 0, done && JSON.stringify(done.stats));
  if (opts.expectConverted) check('队列统计标注「自动对齐（converted）」', !!done && done.stats && done.stats.converted === true, done && JSON.stringify(done.stats));
  const runs = await fetch('/runs').then((r) => r.json()).catch(() => ({ runs: [] }));
  const found = (runs.runs || []).find((r) => r.job === 'lg-import' && r.state === 'done');
  check('任务记录里有 lg-import/done（runs 表）', !!found, found && JSON.stringify(found.stats));
  return done;
};

try {
  if (CFG.phase === 'export') {
    await doExport();
  } else if (CFG.phase === 'open') {
    const panel = await doOpenPanel();
    out.notes.push('接着用 cdp setfiles 选文件：CDP_PORT=… node tools/cdp.mjs setfiles "#books-table .proj-card .proj-detail input[type=file]" "<结果 txt>"');
    check('面板就绪（等待外部 setfiles）', !!panel);
  } else if (CFG.phase === 'verify-start') {
    // 真机车道：只点「校验」后立刻返回（校验要跑几分钟：逐章抓站点原文；长等待交给轮询 + 后续断言阶段）
    const card = await waitFor(() => cardOf(), 15000);
    const panel = boxOf(card);
    check('找到导入面板', !!panel && !!panel.querySelector('input[type=file]'));
    if (panel) {
      const input = panel.querySelectorAll('input[type=file]')[0];
      check('结果 txt 已选中（setfiles 之后）', !!(input.files && input.files[0]), input.files && input.files[0] && (input.files[0].name + ' · ' + input.files[0].size + 'B'));
      btnByText(panel, '校验').click();
      out.notes.push('已点「校验」，接着用短 eval 轮询面板文案，报告出现后再跑 phase=verify（noClick=true）做断言');
      check('已点击「校验」（不等待报告）', true);
    }
  } else if (CFG.phase === 'verify') {
    const card = await waitFor(() => cardOf(), 15000);
    const panel = boxOf(card);
    check('复用已打开的导入面板', !!panel && !!panel.querySelector('input[type=file]'));
    if (panel) await doVerify(panel, { expectConverted: true, clickFirst: !CFG.noClick });
  } else if (CFG.phase === 'probe') {
    const card = await waitFor(() => cardOf(), 8000);
    const panel = boxOf(card);
    const text = panel ? panel.textContent : '';
    const m = /校验：[0-9]+\/[0-9]+ 章通过[^（]*（[^）]*）/.exec(text);
    check('面板已出现校验报告', !!m, m && m[0]);
    check('报告为「全部章节通过」', !!m && /全部章节通过/.test(m[0]), m && m[0]);
  } else if (CFG.phase === 'apply') {
    const card = await waitFor(() => cardOf(), 15000);
    const panel = boxOf(card);
    if (panel) await doApply(panel, CFG.limit);
  } else if (CFG.phase === 'await') {
    const last = (typeof window !== 'undefined' && window.__LG_GUI_LAST) || null;
    check('拿到上一阶段入队的队列号', !!(last && last.queueId), JSON.stringify(last));
    if (last && last.queueId) await doAwait(last.queueId, last.limit, { expectConverted: true });
  } else {
    // ===== 默认（mock 车道）：一把跑完，两段：契约格式 + 站点导出格式 =====
    const exported = await doExport();
    check('导出详情行数（12 行 / 3 章）', !!exported && exported.includes('已导出 12 行 / 3 章'), exported && exported.slice(0, 120));

    // —— 第一段：契约格式（一行一段，无标题行）——
    const card = await waitFor(() => cardOf(), 15000);
    let panel = await doOpenPanel();
    if (panel) {
      const dt = new DataTransfer();
      dt.items.add(new File([contractFixture()], 'lg-result.txt', { type: 'text/plain' }));
      panel.querySelectorAll('input[type=file]')[0].files = dt.files;
      await doVerify(panel);
      const id = await doApply(panel, 1);
      if (id) {
        await doAwait(id, 1);
        const summary = await waitFor(() => {
          const t = boxOf(card) ? boxOf(card).textContent : '';
          return t.includes('上传 1 · 失败 0') ? t : null;
        }, 30000);
        check('面板内可见完成摘要（上传 1 · 失败 0）', !!summary, summary && summary.slice(-200));
      }
    }

    // —— 第二段：站点「下载原文」格式（mode=jp，带 # 标题行）→ 自动识别并对齐 ——
    const card2 = await waitFor(() => cardOf(), 15000);
    await doExport();                                    // 重新导出会清空详情区，拿到全新的导入面板
    panel = await doOpenPanel();
    if (panel) {
      const dt2 = new DataTransfer();
      dt2.items.add(new File([siteFormatFixture('【译】')], 'lg-result-sitefmt.txt', { type: 'text/plain' }));
      panel.querySelectorAll('input[type=file]')[0].files = dt2.files;
      const report2 = await doVerify(panel, { expectConverted: true });
      check('站点格式：校验 3/3 章通过', !!report2 && report2.includes('校验：3/3 章通过'), report2 && report2.slice(0, 160));
      const id2 = await doApply(panel, 0);
      if (id2) {
        await doAwait(id2, 0, { expectConverted: true });
        const st = await fetch('/status').then((r) => r.json());
        const item = (st.queue || []).find((x) => x.id === id2);
        check('站点格式：队列 progress 终态为 done', !!item && item.progress && item.progress.phase === 'done', item && JSON.stringify(item.progress));
      }
    }
    void card2;
    out.notes.push('清理：任务与上传文件保留在临时 daemon/目录（由外部脚本删除）');
  }
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
}
return JSON.stringify(out, null, 1);
