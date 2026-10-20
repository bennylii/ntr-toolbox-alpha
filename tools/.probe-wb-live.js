// 真机验收（n.novelia.cc /workspace/gpt-pipeline，测试 profile）：工作区备份的导出/导入在真站点上是通的，
// 且写入能被站点自己的 Vue 列表即时看到；全程只动本机 localStorage，不向站点发任何写请求。
// 上游已删除旧 GPT 工作区：翻译器在 workspace-gpt-pipeline，任务队列仍在 workspace-gpt（备份对后者 jobOnly）。
// 证据都不回显 key 明文（只报 keyPresent）。用合成条目（假 key / 不存在的书 id），跑完还原为原值。
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(120); return fn(); };

const PIPE_KEY = 'workspace-gpt-pipeline';
const GPT_KEY = 'workspace-gpt';
const origPipeRaw = localStorage.getItem(PIPE_KEY);
const origGptRaw = localStorage.getItem(GPT_KEY);
const origConfirm = window.confirm;
const $ = (sel, root = document) => (root || document).querySelector(sel);

// 记录本页所有 fetch：用于证明「本功能不向站点发写请求」
const fetchLog = [];
const origFetch = window.fetch;
window.fetch = function (input, init) {
    try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        fetchLog.push({ url: String(url), method: String((init && init.method) || 'GET').toUpperCase() });
    } catch (e) { }
    return origFetch.apply(this, arguments);
};

const pageHas = (text) => {
    // 只看站点自己的应用容器（脚本面板/覆盖层挂在 body 上，读 body 会把脚本自己的文案算进来）
    const app = document.getElementById('app');
    return !!app && (app.textContent || '').includes(text);
};
const clickModule = () => {
    const headers = [...document.querySelectorAll('#ntr-panel .ntr-module-header')];
    const hdr = headers.find((h) => (h.textContent || '').includes('工作区备份'));
    if (!hdr) return false;
    hdr.click();
    return true;
};
const writeStore = (key, obj) => {
    const text = JSON.stringify(obj);
    localStorage.setItem(key, text);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: text, url: location.href, storageArea: localStorage }));
};

try {
    check('页面 = 真站点新 GPT 工作区页', location.hostname === 'n.novelia.cc' && location.pathname === '/workspace/gpt-pipeline', location.href);
    check('panel 与「工作区备份」模块行存在', !!$('#ntr-panel') && clickModule());
    await waitFor(() => $('#ntr-workspace-backup-overlay'));

    const ov = $('#ntr-workspace-backup-overlay');
    check('点击模块行 → 覆盖层面板打开', !!ov);
    // 第 4 行（脚本术语队列）在 GlossaryQueue.list()（IndexedDB）之后才追加，等它到位
    await waitFor(() => ov.querySelectorAll('#wb-summary tbody tr').length === 4, 6000);
    const summaryRows = [...ov.querySelectorAll('#wb-summary tbody tr')];
    const summaryText = ov.querySelector('#wb-summary').textContent;
    const gptRow = summaryRows.map((tr) => [...tr.children].map((td) => td.textContent)).find((cells) => cells[0].includes('GPT 共享任务队列'));
    check('概览：3 个工作区行 + 术语队列行，且写的是真站点键名',
        summaryRows.length === 4 && summaryText.includes('workspace-gpt') && summaryText.includes('workspace-gpt-pipeline') && summaryText.includes('workspace-sakura'),
        summaryText.replace(/\s+/g, ' ').slice(0, 220));
    check('概览：旧 GPT 分区翻译器列标「—（不备份）」', !!gptRow && gptRow[2].includes('—'), gptRow);

    // ---- 1) 空工作区导出：pipeline 逐字段一致；旧 GPT 分区 workers 恒为空 ----
    ov.querySelector('#wb-copy').click();
    await waitFor(() => (ov.querySelector('#wb-export-json').value || '').length > 10);
    let bundle = null;
    try { bundle = JSON.parse(ov.querySelector('#wb-export-json').value); } catch (e) { }
    const livePipe = JSON.parse(localStorage.getItem(PIPE_KEY) || '{}');
    const liveGpt = JSON.parse(localStorage.getItem(GPT_KEY) || '{}');
    check('导出（复制 JSON）：kind/version/sourceKeys 正确',
        !!bundle && bundle.kind === 'ntr-workspace-backup' && bundle.version === 1
        && bundle.sourceKeys.gpt === 'workspace-gpt' && bundle.sourceKeys.gptPipeline === 'workspace-gpt-pipeline'
        && bundle.sourceKeys.sakura === 'workspace-sakura',
        bundle && bundle.sourceKeys);
    check('导出：pipeline 分区与 localStorage 逐字段一致；旧 GPT 分区只带队列、workers 恒空',
        !!bundle
        && JSON.stringify(bundle.stores.gptPipeline.workers) === JSON.stringify(livePipe.workers || [])
        && JSON.stringify(bundle.stores.gptPipeline.jobs) === JSON.stringify(livePipe.jobs || [])
        && bundle.stores.gpt.workers.length === 0
        && JSON.stringify(bundle.stores.gpt.jobs) === JSON.stringify(liveGpt.jobs || []),
        bundle && { pipeWorkers: bundle.stores.gptPipeline.workers.length, gptJobs: bundle.stores.gpt.jobs.length });
    check('导出：面板勾选项包含术语队列（scriptQueue 复用既有队列备份格式）',
        !!bundle && (bundle.scriptQueue === undefined || Array.isArray(bundle.scriptQueue.jobs)),
        bundle && bundle.scriptQueue && bundle.scriptQueue.jobs && bundle.scriptQueue.jobs.length);

    // ---- 2) 合成条目写进站点工作区 + 派发 StorageEvent → 站点自己的列表可感知 ----
    const fakeId = '备份自检-' + Date.now();
    const fakeTask = `web/syosetu/wb-fake-${Date.now()}?level=expire&forceMetadata=false&useBrowserCrawler=false&startIndex=0&endIndex=1`;
    const synthPipe = {
        workers: [{ id: fakeId, endpoint: 'http://127.0.0.1:8788/v1', model: 'wb-test-model', key: 'sk-fake-wb-test' }],
        jobs: [], uncompletedJobs: [],
    };
    const synthGpt = {
        workers: [],
        jobs: [{ task: fakeTask, description: '备份自检任务', createAt: 1700000000000 }],
        uncompletedJobs: [{ task: fakeTask, description: '备份自检任务', createAt: 1700000000000, finishAt: 1700000001000, progress: { finished: 1, error: 0, total: 1 } }],
    };
    writeStore(PIPE_KEY, synthPipe);
    writeStore(GPT_KEY, synthGpt);
    const siteSawIt = await waitFor(() => pageHas(fakeId), 6000);
    check('合成条目 + 合成 StorageEvent → 站点页面列表即时出现该翻译器（站点 useLocalStorage 兼容）', siteSawIt, { pageHasFakeId: pageHas(fakeId) });
    check('站点页面同时认得队列任务（描述文案出现）', pageHas('备份自检任务'), { pageHasTask: pageHas('备份自检任务') });

    // ---- 3) 导出合成数据：逐字段还原（含 key） ----
    ov.querySelector('#wb-copy').click();
    await sleep(300);
    let bundle2 = null;
    try { bundle2 = JSON.parse(ov.querySelector('#wb-export-json').value); } catch (e) { }
    const roundTrippedShape = !!bundle2
        && JSON.stringify(bundle2.stores.gptPipeline.workers) === JSON.stringify(synthPipe.workers)
        && JSON.stringify(bundle2.stores.gpt.jobs) === JSON.stringify(synthGpt.jobs)
        && JSON.stringify(bundle2.stores.gpt.uncompletedJobs) === JSON.stringify(synthGpt.uncompletedJobs);
    check('导出合成数据：pipeline 翻译器 + 共享队列/记录逐字段等于现场值（含 key 与附加字段原样性）', roundTrippedShape,
        bundle2 && { workers: bundle2.stores.gptPipeline.workers.length, jobs: bundle2.stores.gpt.jobs.length, keyPresent: !!(bundle2.stores.gptPipeline.workers[0] || {}).key });

    // ---- 4) 篡改（删掉翻译器与队列任务）→ 导入刚才的备份 → 还原 ----
    writeStore(PIPE_KEY, { workers: [], jobs: [], uncompletedJobs: [] });
    writeStore(GPT_KEY, { workers: [], jobs: [], uncompletedJobs: [] });
    check('已清空翻译器与队列任务（现场 = 两个仓都空）',
        JSON.parse(localStorage.getItem(PIPE_KEY)).workers.length === 0
        && JSON.parse(localStorage.getItem(GPT_KEY)).jobs.length === 0);

    const text = JSON.stringify(bundle2);
    const ta = ov.querySelector('#wb-import-json');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ov.querySelector('#wb-preview').click();
    const previewReady = await waitFor(() => ov.querySelector('#wb-apply').disabled === false, 5000);
    const previewText = ov.querySelector('#wb-preview-box').textContent.replace(/\s+/g, ' ');
    check('预览：算得出翻译器新增 1 与队列新增 1，并给出任务明细',
        previewReady && previewText.includes('翻译器：新增 1') && previewText.includes('队列：新增 1') && previewText.includes('备份自检任务'), previewText.slice(0, 260));
    check('预览：任务渲染成可点书链接（/novel/syosetu/wb-fake-…）',
        !!ov.querySelector('#wb-preview-box a[href^="/novel/syosetu/wb-fake-"]'), null);
    window.confirm = () => true;
    ov.querySelector('#wb-apply').click();
    const restored = await waitFor(() => {
        try {
            return JSON.stringify(JSON.parse(localStorage.getItem(PIPE_KEY))) === JSON.stringify(synthPipe)
                && JSON.stringify(JSON.parse(localStorage.getItem(GPT_KEY))) === JSON.stringify(synthGpt);
        } catch (e) { return false; }
    }, 6000);
    check('应用导入 → 两个键逐字段还原为导出时的现场（含 key 与 progress）', restored, null);
    check('还原后站点列表仍然显示该翻译器（导入走 StorageEvent，站点即时同步）', pageHas(fakeId));
    window.confirm = origConfirm;

    // ---- 5) 红线：本功能不向站点发任何写请求 ----
    const writes = fetchLog.filter((f) => f.method !== 'GET' && f.url.startsWith(location.origin));
    check('全程没有任何指向站点 origin 的非 GET 请求', writes.length === 0, writes.slice(0, 5));

    ov.querySelector('#wb-close').click();
    check('关闭面板后覆盖层移除', !$('#ntr-workspace-backup-overlay'));
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    if (origPipeRaw === null) localStorage.removeItem(PIPE_KEY); else localStorage.setItem(PIPE_KEY, origPipeRaw);
    if (origGptRaw === null) localStorage.removeItem(GPT_KEY); else localStorage.setItem(GPT_KEY, origGptRaw);
    for (const k of [PIPE_KEY, GPT_KEY]) {
        const text = localStorage.getItem(k);
        if (text !== null) window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: text, url: location.href, storageArea: localStorage }));
    }
    window.confirm = origConfirm;
    window.fetch = origFetch;
    const ov = $('#ntr-workspace-backup-overlay');
    if (ov) ov.remove();
    out.notes.push('cleanup: workspace-gpt-pipeline / workspace-gpt 还原为原值（' + [origPipeRaw === null ? 'null' : origPipeRaw.length + ' 字节', origGptRaw === null ? 'null' : origGptRaw.length + ' 字节'].join(' / ') + '）、fetch 还原、覆盖层移除');
    out.notes.push('静态 JSON 落盘：应用导入时页面会下载一份 pre-import 快照（含合成假 key）—— 需手动清理下载目录');
}
return JSON.stringify(out, null, 1);
