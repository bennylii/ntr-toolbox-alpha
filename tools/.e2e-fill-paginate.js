// 填充术语表：自动翻页 / 翻页上限 / 末页停 / 单页不翻 / 点了没反应(stuck) / 旧 button 结构回落
// 分页组件默认按真站（naive-ui）结构造：div.n-pagination-item--button（首个=上一页、末个=下一页，
// 只有图标无文字，禁用=class --disabled，不是 disabled 属性）；另有 'button' 形态覆盖回落选择器。
// 跑法：cdp open http://127.0.0.1:8788/novel/mock/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-fill-paginate.js
// 依赖：mock 在 8788；本测试以 mock 页 + 注入 n-pagination + 拦截 PUT/GET 的方式跑
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = window._NTRGlossaryDev;
const E = D.GlossaryEngine;
const T = window._NTRToolBox;

// 取脚本里填充术语表模块的实例（实际生产是 cfg 模式；这里直接调 mod.run）
const fillMod = T && T.configuration && T.configuration.modules && T.configuration.modules.find((m) => m.name === '填充术语表');

// 让 mock/页面在 window 提供两个章节小说（注入 `<a>` + 容器），和翻页按钮。
// 翻页按钮 click 后，注入的 fillPatches 会再生成下一批
const fillPatches = (window.__fillPaginatePatches || (window.__fillPaginatePatches = {
    novels: [['mock', 'A1'], ['mock', 'A2']],
    page: 1,
    maxPage: 3,
    hideButton: false,   // true = 页面没有翻页结构（找不到按钮）
    paginStyle: 'div',   // 'div' = 真站结构（默认）；'button' = 旧 <button> 结构（回落路径）
    clickNoop: false,    // true = 下一页可点但点了没反应（stuck 用例）
    nextHandler: null,
}));

const renderCurrentPage = () => {
    const root = document.getElementById('ntr-test-root');
    root.innerHTML = '';
    fillPatches.novels.forEach(([p, id]) => {
        const item = document.createElement('div');
        item.className = 'n-list-item';
        const a = document.createElement('a');
        a.href = `/novel/${p}/${id}`;
        a.textContent = `${p}/${id}`;
        item.appendChild(a);
        root.appendChild(item);
    });
    if (fillPatches.hideButton) return;  // 模拟页面没有分页组件
    const pag = document.createElement('div');
    pag.className = 'n-pagination';
    const advance = () => {
        if (fillPatches.clickNoop) return;  // 模拟"点了没反应"
        fillPatches.page += 1;
        // 模拟加载下一页时返回一组新条目（第 2 页 B2/B2-2，第 3 页 B3/B3-2）
        fillPatches.novels = [['mock', `B${fillPatches.page}`], ['mock', `B${fillPatches.page}-2`]];
        if (fillPatches.nextHandler) fillPatches.nextHandler();
        renderCurrentPage();
    };
    if (fillPatches.paginStyle === 'button') {
        // 旧结构：真实 <button>，文案含「下」，用 disabled 属性
        const btn = document.createElement('button');
        btn.textContent = '下一页';
        btn.disabled = fillPatches.page >= fillPatches.maxPage;
        btn.addEventListener('click', () => { if (!btn.disabled) advance(); });
        pag.appendChild(btn);
    } else {
        // 真站结构（naive-ui）：div.n-pagination-item--button —— 首个=上一页、末个=下一页；
        // 只有图标（无文字/无 aria），禁用态是 class --disabled（不是 disabled 属性）
        const prev = document.createElement('div');
        prev.className = 'n-pagination-item n-pagination-item--button' + (fillPatches.page <= 1 ? ' n-pagination-item--disabled' : '');
        prev.innerHTML = '<i class="n-base-icon">‹</i>';
        const active = document.createElement('div');
        active.className = 'n-pagination-item n-pagination-item--active';
        active.textContent = String(fillPatches.page);
        const next = document.createElement('div');
        next.className = 'n-pagination-item n-pagination-item--button' + (fillPatches.page >= fillPatches.maxPage ? ' n-pagination-item--disabled' : '');
        next.innerHTML = '<i class="n-base-icon">›</i>';
        next.addEventListener('click', () => { if (!next.classList.contains('n-pagination-item--disabled')) advance(); });
        pag.appendChild(prev);
        pag.appendChild(active);
        pag.appendChild(next);
    }
    root.appendChild(pag);
};

let root = document.getElementById('ntr-test-root');
if (!root) { root = document.createElement('div'); root.id = 'ntr-test-root'; document.body.appendChild(root); }
renderCurrentPage();

// 拦截 script.fetch：mock PUT/GET glossary 返回 200 OK；记录每个 (providerId, novelId) 被填过几次
const fetched = window.__fillPaginateFetched || (window.__fillPaginateFetched = {});
const origFetch = T.fetch.bind(T);
T.fetch = async (url, bypass, options = {}) => {
    if (typeof url === 'string') {
        // 真实 URL 形如 http://host/api/novel/{p}/{id}[/glossary]（模块里拼的是 location.origin + /api/novel/...）
        const m = url.match(/^https?:\/\/[^\/]+\/api\/novel\/([^/]+)\/([^/]+)(\/glossary)?$/);
        if (m) {
            const p = m[1];
            const id = m[2];
            const tail = m[3];
            const isGet = (!options.method || options.method === 'GET') && !tail;
            const isPut = (options.method === 'PUT') && !!tail;
            if (isGet || isPut) {
                const key = `${p}/${id}`;
                fetched[key] = (fetched[key] || 0) + 1;
                return new Response('{"glossary":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
        }
    }
    return origFetch(url, bypass, options);
};

// stub confirm
let confirmAnswer = true;
const origConfirm = window.confirm;
window.confirm = () => confirmAnswer;

// reset(maxPage, hideButton, extra)：重建第 1 页 DOM、清空记录；把 maxPage/hideButton/结构一起设好再渲染，
// 避免"先渲染后改 maxPage"导致按钮 disabled 状态与预期不符。extra: {paginStyle:'div'|'button', clickNoop}
const reset = (maxPage = 3, hideButton = false, extra = {}) => {
    fillPatches.page = 1;
    fillPatches.novels = [['mock', 'A1'], ['mock', 'A2']];
    fillPatches.maxPage = maxPage;
    fillPatches.hideButton = hideButton;
    fillPatches.paginStyle = extra.paginStyle || 'div';
    fillPatches.clickNoop = !!extra.clickNoop;
    fillPatches.nextHandler = null;
    for (const k of Object.keys(fetched)) delete fetched[k];
    renderCurrentPage();
};

// 在 fill 模块 settings 里塞自动翻页配置（reset 由各用例自己做，这里不再重置，避免覆盖用例的 maxPage）
const runWithOpts = async (autoPaginate, maxPages = 3) => {
    if (!fillMod) throw new Error('未找到填充术语表模块');
    const origSet = fillMod.settings;
    fillMod.settings = [
        { name: '术语表', value: 'アリス => 爱丽丝' },
        { name: '追加模式', value: true },
        { name: '页面可视化反馈', value: false },
        { name: 'bind', value: 'none' },
        ...(autoPaginate ? [
            { name: '自动翻页至末页', value: true },
            { name: '翻页上限', value: maxPages },
        ] : []),
    ];
    fillPatches.nextHandler = () => { /* 翻页触发 */ };
    // processCurrentPage 是闭包，监控 fillPatches.page 即可知翻了哪几页
    const t0 = Date.now();
    await fillMod.run({ settings: fillMod.settings });
    const dt = Date.now() - t0;
    fillMod.settings = origSet;
    return { finalPage: fillPatches.page, fetchedKeys: Object.keys(fetched), fetchedCount: Object.keys(fetched).length, dt };
};

try {
  // ---------- A. 默认（不勾翻页）：只填当前页 ----------
  reset(3);  // 即使有 3 页，关闭翻页应只填第 1 页
  confirmAnswer = true;
  let r = await runWithOpts(false);
  check('关闭自动翻页 → 只填第 1 页', r.finalPage === 1);
  check('关闭自动翻页 → 只填当前页 novels（2 本）', r.fetchedCount === 2, r.fetchedKeys);
  check('关闭自动翻页 → 没点下一页按钮', r.fetchedKeys.includes('mock/A1') && r.fetchedKeys.includes('mock/A2') && !r.fetchedKeys.some(p => p.includes('B')));

  // ---------- B. 开启自动翻页：第 1 页 → 点下一页 → 第 2 页（B2）→ 第 3 页（B3，最后一页）----------
  reset(3);
  confirmAnswer = true;
  r = await runWithOpts(true, 3);
  check('开启自动翻页 → 翻到了下一页', r.finalPage >= 2, { finalPage: r.finalPage });
  check('开启自动翻页 → 填了第 1 页 A1/A2', r.fetchedKeys.includes('mock/A1') && r.fetchedKeys.includes('mock/A2'));
  check('开启自动翻页 → 第 2 页 B2 也填了', r.fetchedKeys.some(k => k.includes('B2')));
  check('开启自动翻页 → 第 3 页 B3（最后一页）也填了', r.fetchedKeys.some(k => k.includes('B3')));
  check('开启自动翻页 → 填了 ≥ 6 本（3 页 × 2）', r.fetchedCount >= 6, { fetchedCount: r.fetchedCount });

  // ---------- C. 末页（按钮 disabled）停止翻页 ----------
  reset(2);  // 只设 2 页：第 1 页填完后点"下一页"到第 2 页，按钮变 disabled
  confirmAnswer = true;
  r = await runWithOpts(true, 5);  // 翻页上限设大点，确保不会因上限停
  check('到末页（按钮 disabled）时停止', r.finalPage === 2, { finalPage: r.finalPage });
  check('到末页停止后没继续填第 3 页', !r.fetchedKeys.some(k => k.includes('B3')));

  // ---------- D. 翻页上限生效 ----------
  reset(10);  // 实际有 10 页可翻，但翻页上限设小
  confirmAnswer = true;
  r = await runWithOpts(true, 2);  // 翻页上限 2
  check('翻页上限生效：只填满 2 页（4 本）', r.fetchedCount === 4 && r.finalPage === 2, { fetchedCount: r.fetchedCount, finalPage: r.finalPage });
  check('翻页上限生效：没填第 3 页', !r.fetchedKeys.some(k => k.includes('B3')));

  // ---------- E. confirm 取消：什么都不做 ----------
  reset(3);
  confirmAnswer = false;
  r = await runWithOpts(true, 3);
  check('confirm 取消 → 没发任何 PUT', r.fetchedCount === 0, { fetchedKeys: r.fetchedKeys });

  // ---------- F. 第一页就是末页（按钮一开始 disabled）→ 只填当前页 ----------
  reset(1);  // 只有 1 页，按钮从一开始就是 disabled
  confirmAnswer = true;
  r = await runWithOpts(true, 5);
  check('第 1 页即末页（按钮 disabled）→ 最终停在第 1 页', r.finalPage === 1, { finalPage: r.finalPage });
  check('第 1 页即末页 → 只填当前页 2 本', r.fetchedCount === 2, { fetchedCount: r.fetchedCount });

  // ---------- G. 页面没有翻页结构（找不到按钮）→ 只填当前页 ----------
  reset(3, true);  // 3 页且没有分页组件
  confirmAnswer = true;
  r = await runWithOpts(true, 5);
  check('没有下一页按钮（no-next）→ 最终停在第 1 页', r.finalPage === 1, { finalPage: r.finalPage });
  check('没有下一页按钮 → 只填当前页 2 本', r.fetchedCount === 2, { fetchedCount: r.fetchedCount });

  // ---------- H. 旧 <button> 结构：回落选择器仍能翻页 ----------
  reset(3, false, { paginStyle: 'button' });
  confirmAnswer = true;
  r = await runWithOpts(true, 3);
  check('旧 button 结构（回落）→ 翻到第 2/3 页', r.finalPage === 3 && r.fetchedKeys.some(k => k.includes('B3')), { finalPage: r.finalPage, fetchedKeys: r.fetchedKeys });

  // ---------- I. 下一页可点但点了没反应（列表不翻动）→ 停住且不重复填同一页 ----------
  reset(5, false, { clickNoop: true });
  confirmAnswer = true;
  r = await runWithOpts(true, 5);
  check('点了没反应（stuck）→ 最终仍停在第 1 页', r.finalPage === 1, { finalPage: r.finalPage });
  check('点了没反应 → 没有把第 1 页重复填一遍（仍 2 本）', r.fetchedCount === 2, { fetchedKeys: r.fetchedKeys });
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
} finally {
  window.confirm = origConfirm;
  // 清理注入的 DOM 与 fetch 拦截
  const r = document.getElementById('ntr-test-root');
  if (r) r.remove();
  delete window.__fillPaginatePatches;
  delete window.__fillPaginateFetched;
  out.notes.push('cleanup: 测试 DOM 已移除、fetch 拦截已还原、confirm 已还原');
}
return JSON.stringify(out, null, 1);