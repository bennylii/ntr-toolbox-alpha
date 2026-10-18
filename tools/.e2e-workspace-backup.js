// 工作区备份（导出/导入站点工作区的翻译器与队列 + 可选术语队列）的 e2e 定格：
// 文件格式 / 忠实性 / 掩码与 key 保留 / 合并与替换语义 / 站点加载期迁移镜像 / 跨域键映射 /
// StorageEvent 派发 / 异常不写数据 / 面板可开且按钮通。
// 语义直接打 _NTRGlossaryDev.StorageUtils（同一份实现，避免 DOM 驱动语义断言）；
// 面板部分用 runModule('工作区备份') + 稳定 id（#wb-*）驱动，只验「能开、能导出、能预览、能应用」。
// 跑法：node tools/.run-suite.mjs tools/.e2e-workspace-backup.js "http://127.0.0.1:8788/wenku/mock-src"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(80); return fn(); };

const KEYS = ['workspace-gpt', 'workspace-gpt-pipeline', 'workspace-sakura', 'sakura-workspace'];
const saved = {};
KEYS.forEach((k) => { saved[k] = localStorage.getItem(k); });
const setKey = (k, obj) => localStorage.setItem(k, typeof obj === 'string' ? obj : JSON.stringify(obj));
const readKey = (k) => { const raw = localStorage.getItem(k); return raw === null ? null : JSON.parse(raw); };
const origConfirm = window.confirm;
window.confirm = () => true;

const toasts = [];
const toastObs = new MutationObserver(() => {
    [...document.querySelectorAll('.ntr-notification-message')].forEach((n) => {
        const t = n.textContent.trim();
        if (!toasts.includes(t)) toasts.push(t);
    });
});
toastObs.observe(document.body, { childList: true, subtree: true });

const S = window._NTRGlossaryDev.StorageUtils;
const run = (name) => window._NTRToolBox.runModule(name);

try {
    check('StorageUtils 已暴露 workspaceStoreKey/exportWorkspace/importWorkspace/planWorkspaceImport',
        typeof S.workspaceStoreKey === 'function' && typeof S.exportWorkspace === 'function'
        && typeof S.importWorkspace === 'function' && typeof S.planWorkspaceImport === 'function');

    // 本域（127.0.0.1）没有这几个键时的解析：Sakura 落到脚本既有域分支 sakura-workspace
    KEYS.forEach((k) => localStorage.removeItem(k));
    check('键解析：都不存在时 gpt=workspace-gpt、gptPipeline=workspace-gpt-pipeline、sakura=sakura-workspace',
        S.workspaceStoreKey('gpt') === 'workspace-gpt'
        && S.workspaceStoreKey('gptPipeline') === 'workspace-gpt-pipeline'
        && S.workspaceStoreKey('sakura') === 'sakura-workspace');

    // ---------- A. 导出结构与忠实性 ----------
    const gptStore = {
        workers: [
            { id: '甲1', type: 'api', model: 'deepseek-chat', endpoint: 'http://127.0.0.1:8788/v1', key: 'sk-fake-1' },
            { id: '甲2', endpoint: 'http://127.0.0.1:8788/v1', model: 'm2', key: 'sk-fake-2', concurrency: 3 },
        ],
        jobs: [
            { task: 'web/mock/tb-1?level=expire&forceMetadata=false&useBrowserCrawler=false&startIndex=0&endIndex=65535', description: '测试书一', createAt: 111 },
            { task: 'web/mock/tb-done?level=normal', description: '本地已完成任务', createAt: 1, finishAt: 2 },
        ],
        uncompletedJobs: [{ task: 'web/mock/tb-0?level=normal', description: '已完成书', createAt: 1, finishAt: 2, progress: { finished: 3, error: 0, total: 3 } }],
    };
    const betaStore = {
        workers: [{ id: 'B1', endpoint: 'http://127.0.0.1:8788/v1', model: 'm3', key: 'sk-beta', concurrency: 5, profile: { id: 'deepseek', values: { thinking: 'enabled' } } }],
        jobs: [], uncompletedJobs: [],
    };
    const sakuraStore = {
        workers: [{ id: '共享', endpoint: 'https://sakura-share.one' }, { id: '乙1', endpoint: 'http://sakura.example', segLength: 500, prevSegLength: 500 }],
        jobs: [{ task: 'wenku/abc/vol%20one.txt?level=expire', description: 'vol one.txt', createAt: 222 }],
        uncompletedJobs: [],
    };
    setKey('workspace-gpt', gptStore);
    setKey('workspace-gpt-pipeline', betaStore);
    setKey('sakura-workspace', sakuraStore);

    const bundle = await S.exportWorkspace({ sections: ['gpt', 'gptPipeline', 'sakura'], includeKeys: true });
    check('导出：kind/version/origin/hostname/sourceKeys 齐全',
        bundle.kind === 'ntr-workspace-backup' && bundle.version === 1
        && bundle.origin === location.origin && bundle.hostname === location.hostname
        && bundle.sourceKeys.gpt === 'workspace-gpt'
        && bundle.sourceKeys.gptPipeline === 'workspace-gpt-pipeline'
        && bundle.sourceKeys.sakura === 'sakura-workspace', bundle.sourceKeys);
    check('导出：keysOmitted=false（含 key 导出）', bundle.keysOmitted === false);
    check('导出：GPT 分区逐字段忠实（含 legacy type/concurrency）',
        JSON.stringify(bundle.stores.gpt) === JSON.stringify(gptStore), bundle.stores.gpt);
    check('导出：BETA 分区逐字段忠实（含 profile/concurrency）',
        JSON.stringify(bundle.stores.gptPipeline) === JSON.stringify(betaStore), bundle.stores.gptPipeline);
    check('导出：Sakura 分区逐字段忠实（含 segLength/prevSegLength）',
        JSON.stringify(bundle.stores.sakura) === JSON.stringify(sakuraStore), bundle.stores.sakura);

    // 分区勾选：只导 gpt
    const onlyGpt = await S.exportWorkspace({ sections: ['gpt'], includeKeys: true });
    check('导出：只含被勾选分区', Object.keys(onlyGpt.stores).length === 1 && Object.keys(onlyGpt.stores)[0] === 'gpt', Object.keys(onlyGpt.stores));

    // 掩码导出
    const masked = await S.exportWorkspace({ sections: ['gpt', 'gptPipeline'], includeKeys: false });
    check('掩码导出：keysOmitted=true 且 key 置空、其余字段不变',
        masked.keysOmitted === true
        && masked.stores.gpt.workers.every((w) => w.key === '')
        && masked.stores.gpt.workers[0].endpoint === 'http://127.0.0.1:8788/v1'
        && masked.stores.gptPipeline.workers[0].key === '', masked.stores.gpt.workers);

    // ---------- B. 合并导入 + 掩码不吃 key ----------
    const mergeBundle = {
        kind: 'ntr-workspace-backup', version: 1, exportedAt: Date.now(),
        origin: location.origin, hostname: location.hostname,
        sourceKeys: { gpt: 'workspace-gpt' }, keysOmitted: true,
        stores: {
            gpt: {
                workers: [
                    { id: '甲1', type: 'api', endpoint: 'http://127.0.0.1:8788/v1', model: 'deepseek-chat', key: '' },  // 同 id 同内容 + 空 key → 保留本地 key（不变）
                    { id: '甲2', endpoint: 'http://127.0.0.1:8788/v1', model: 'm2-changed', key: '' },                 // 同 id 有变化 → 覆盖，key 保留
                    { id: '丙1', endpoint: 'http://127.0.0.1:8788/v1', model: 'm9', key: '' },                         // 新增 + 本地无 key
                    { id: '丁1', type: 'web', model: 'legacy', endpoint: 'https://chat.openai.com' },                  // 旧 web → 跳过
                    { endpoint: 'http://no-id.example' },                                                              // 无 id → 跳过
                ],
                jobs: [
                    { task: gptStore.jobs[0].task, description: '同名未完成', createAt: 333 },                          // 同名未完成 → 跳过
                    { task: 'web/mock/tb-2?level=all', description: '新任务', createAt: 444 },                          // 新增
                    { task: gptStore.jobs[1].task, description: '同名已完成改名', createAt: 555 },                      // 本地已完成 → 覆盖
                ],
                uncompletedJobs: [
                    { task: gptStore.uncompletedJobs[0].task, description: '记录覆盖', createAt: 666, progress: { finished: 1, error: 1, total: 2 } },
                    { task: 'wenku/new/two.txt', description: '新记录', createAt: 777 },
                ],
            },
        },
    };
    const storageEvents = [];
    const onStorage = (e) => storageEvents.push(e);
    window.addEventListener('storage', onStorage);
    const mergeResult = await S.importWorkspace(mergeBundle, { mode: 'merge' });
    window.removeEventListener('storage', onStorage);
    const afterMerge = readKey('workspace-gpt');
    check('合并导入：计数 = 新增1/覆盖1/不变1/跳过web1/无id1/保留key2',
        mergeResult.workersAdded === 1 && mergeResult.workersUpdated === 1 && mergeResult.workersSame === 1
        && mergeResult.workersSkippedWeb === 1 && mergeResult.workersInvalid === 1 && mergeResult.keysKept === 2, mergeResult);
    check('合并导入：写入 1 个键且派发 StorageEvent',
        mergeResult.keysWritten === 1 && storageEvents.some((e) => e.key === 'workspace-gpt'),
        { keysWritten: mergeResult.keysWritten, events: storageEvents.map((e) => e.key) });
    check('合并导入：同 id 空 key 不吃掉本地凭据',
        afterMerge.workers[0].key === 'sk-fake-1' && afterMerge.workers[1].key === 'sk-fake-2', afterMerge.workers.map((w) => w.id + ':' + w.key));
    check('合并导入：覆盖带变化字段（model=m2-changed）', afterMerge.workers[1].model === 'm2-changed');
    check('合并导入：新条目按空 key 导入（keysMissing 计数）',
        afterMerge.workers.length === 3 && mergeResult.keysMissing === 1 && afterMerge.workers.some((w) => w.id === '丙1' && w.key === ''),
        { workers: afterMerge.workers.map((w) => w.id), keysMissing: mergeResult.keysMissing });
    check('合并导入：旧 web 条目未写入', !afterMerge.workers.some((w) => w.id === '丁1'));
    check('合并导入：队列同名未完成跳过、新任务追加、已完成被覆盖',
        mergeResult.jobsSkipped === 1 && mergeResult.jobsAdded === 1 && mergeResult.jobsReplaced === 1
        && afterMerge.jobs.length === 3
        && afterMerge.jobs[0].description === '测试书一'
        && afterMerge.jobs[1].description === '同名已完成改名'
        && afterMerge.jobs[2].task === 'web/mock/tb-2?level=all', mergeResult);
    check('合并导入：已完成记录同 task 覆盖 + 新记录追加（progress 保留）',
        mergeResult.recordsReplaced === 1 && mergeResult.recordsAdded === 1
        && afterMerge.uncompletedJobs.length === 2
        && afterMerge.uncompletedJobs[0].description === '记录覆盖'
        && afterMerge.uncompletedJobs[0].progress.error === 1, afterMerge.uncompletedJobs);
    check('合并导入：BETA 分区未在备份里 → 原样不动',
        JSON.stringify(readKey('workspace-gpt-pipeline')) === JSON.stringify(betaStore));

    // ---------- C. 站点迁移镜像 + Sakura 提示 ----------
    const migBundle = {
        kind: 'ntr-workspace-backup', version: 1, exportedAt: Date.now(),
        sourceKeys: { sakura: 'workspace-sakura' },
        stores: {
            sakura: {
                workers: [{ id: '丙2', endpoint: 'http://sakura.example', testSegLength: 400, testContext: { a: 1 } }],
                jobs: [], uncompletedJobs: [],
            },
        },
    };
    const migPlan = S.planWorkspaceImport(migBundle, { mode: 'merge' });
    const migSection = migPlan.sections[0];
    const migWorker = migSection.nextWorkers.find((w) => w.id === '丙2');
    check('迁移计划：testSegLength→segLength、删 testContext、migrated=1',
        migWorker && migWorker.segLength === 400
        && migWorker.testSegLength === undefined
        && migWorker.testContext === undefined
        && migSection.workers.migrated === 1, migWorker);
    check('迁移计划：跨域键映射提示（sourceKeys.sakura=workspace-sakura → 本域 sakura-workspace）',
        migPlan.sections[0].key === 'sakura-workspace'
        && migPlan.notes.some((n) => n.includes('workspace-sakura') && n.includes('sakura-workspace')), migPlan.notes);
    // 缺「共享」的提示：整表替换计划里结果集只有备份里的条目
    const migReplacePlan = S.planWorkspaceImport(migBundle, { mode: 'replace' });
    check('迁移计划：整表替换后缺「共享」→ 提示站点会补回',
        migReplacePlan.notes.some((n) => n.includes('共享')), migReplacePlan.notes);
    const migResult = await S.importWorkspace(migBundle, { mode: 'merge' });
    check('跨域导入：落到本域 sakura-workspace，且未凭空创建 workspace-sakura',
        migResult.keysWritten === 1 && localStorage.getItem('workspace-sakura') === null
        && readKey('sakura-workspace').workers.some((w) => w.id === '丙2' && w.segLength === 400),
        { keysWritten: migResult.keysWritten, hasSakuraKey: localStorage.getItem('workspace-sakura') !== null });

    // ---------- D. 整表替换 ----------
    const replaceBundle = {
        kind: 'ntr-workspace-backup', version: 1, exportedAt: Date.now(),
        sourceKeys: { gpt: 'workspace-gpt' },
        stores: { gpt: { workers: [{ id: '独苗', endpoint: 'http://x', model: 'm', key: 'k' }], jobs: [{ task: 'web/mock/only?level=all', description: '唯一', createAt: 1 }], uncompletedJobs: [] } },
    };
    const replaceResult = await S.importWorkspace(replaceBundle, { mode: 'replace' });
    const afterReplace = readKey('workspace-gpt');
    check('整表替换：条目集合等于备份（含删除计数 3 翻译器 / 3 队列 / 2 记录）',
        replaceResult.workersRemoved === 3 && replaceResult.jobsRemoved === 3 && replaceResult.recordsRemoved === 2
        && afterReplace.workers.length === 1 && afterReplace.workers[0].id === '独苗'
        && afterReplace.jobs.length === 1 && afterReplace.uncompletedJobs.length === 0, replaceResult);

    // ---------- E. 异常：报错且一个字节都不写 ----------
    const beforeBad = KEYS.map((k) => localStorage.getItem(k));
    const badCases = [
        ['kind 不符', { kind: 'glossary', version: 1, stores: {} }],
        ['版本过高', { kind: 'ntr-workspace-backup', version: 2, stores: {} }],
        ['缺 stores', { kind: 'ntr-workspace-backup', version: 1 }],
        ['stores 为空', { kind: 'ntr-workspace-backup', version: 1, stores: {} }],
        ['未知分区', { kind: 'ntr-workspace-backup', version: 1, stores: { nope: {} } }],
        ['workers 不是数组', { kind: 'ntr-workspace-backup', version: 1, stores: { gpt: { workers: 'x' } } }],
    ];
    for (const [label, bad] of badCases) {
        let threw = false;
        try { await S.importWorkspace(bad, { mode: 'merge' }); } catch (e) { threw = true; }
        check(`异常「${label}」：抛错且不改数据`, threw, null);
    }
    check('异常：全部失败后 localStorage 逐键未变',
        JSON.stringify(KEYS.map((k) => localStorage.getItem(k))) === JSON.stringify(beforeBad));

    // ---------- F. 面板：开、导出、预览、应用 ----------
    setKey('workspace-gpt', gptStore);
    localStorage.removeItem('workspace-gpt-pipeline');
    localStorage.removeItem('sakura-workspace');
    run('工作区备份');
    await waitFor(() => document.getElementById('ntr-workspace-backup-overlay'));
    const ov = document.getElementById('ntr-workspace-backup-overlay');
    check('面板：runModule 打开覆盖层', !!ov);
    const summaryReady = await waitFor(() => ov.querySelectorAll('#wb-summary tbody tr').length === 4, 4000);
    check('面板：概览 3 个工作区行 + 脚本队列行',
        summaryReady && ov.querySelectorAll('#wb-summary tbody tr').length === 4,
        ov.querySelectorAll('#wb-summary tbody tr').length);
    check('面板：分区勾选与按钮齐备',
        !!ov && ['wb-sec-gpt', 'wb-sec-gptPipeline', 'wb-sec-sakura', 'wb-sec-queue', 'wb-keys', 'wb-export-file', 'wb-copy', 'wb-pick', 'wb-preview', 'wb-apply', 'wb-mode', 'wb-import-json'].every((id) => !!ov.querySelector('#' + id)));
    check('面板：应用按钮初始禁用', ov && ov.querySelector('#wb-apply').disabled === true);

    // 导出按钮：内容进 textarea
    ov.querySelector('#wb-sec-gptPipeline').click();   // 取消勾选（该键已不存在）
    ov.querySelector('#wb-export-file').click();
    await waitFor(() => (ov.querySelector('#wb-export-json').value || '').includes('ntr-workspace-backup'));
    const exportedText = ov.querySelector('#wb-export-json').value;
    let exportedObj = null;
    try { exportedObj = JSON.parse(exportedText); } catch (e) { }
    check('面板：导出为文件 → textarea 里是合法备份（含 gpt、不含被取消勾选分区）',
        exportedObj && exportedObj.kind === 'ntr-workspace-backup'
        && !!exportedObj.stores.gpt && !exportedObj.stores.gptPipeline
        && Boolean(exportedObj.scriptQueue === undefined || Array.isArray((exportedObj.scriptQueue || {}).jobs)),
        exportedObj && Object.keys(exportedObj.stores));

    // 导入预览 + 应用
    const panelBundle = {
        kind: 'ntr-workspace-backup', version: 1, exportedAt: Date.now(),
        sourceKeys: { gpt: 'workspace-gpt' },
        stores: { gpt: { workers: [{ id: '面板新增', endpoint: 'http://127.0.0.1:8788/v1', model: 'mm', key: 'kk' }], jobs: [{ task: 'web/mock/panel?level=expire', description: '面板任务', createAt: 9 }], uncompletedJobs: [] } },
    };
    ov.querySelector('#wb-import-json').value = JSON.stringify(panelBundle);
    ov.querySelector('#wb-preview').click();
    await waitFor(() => (ov.querySelector('#wb-apply') || {}).disabled === false, 4000);
    const previewText = ov.querySelector('#wb-preview-box').textContent;
    check('面板：预览显示计数与明细', previewText.includes('新增 1') && previewText.includes('面板新增') && previewText.includes('面板任务'), previewText.slice(0, 200));
    check('面板：预览里任务带书链接（web/mock/panel → /novel/mock/panel）',
        !!ov.querySelector('#wb-preview-box a[href="/novel/mock/panel"]'), ov.querySelector('#wb-preview-box').innerHTML.slice(0, 300));
    const mark = toasts.length;
    ov.querySelector('#wb-apply').click();
    await waitFor(() => (readKey('workspace-gpt').workers || []).some((w) => w.id === '面板新增'), 4000);
    const afterPanel = readKey('workspace-gpt');
    check('面板：应用后条目写入 + 成功提示',
        afterPanel.workers.some((w) => w.id === '面板新增' && w.key === 'kk')
        && afterPanel.jobs.some((j) => j.task === 'web/mock/panel?level=expire')
        && toasts.slice(mark).some((t) => t.includes('导入完成')), toasts.slice(mark));
    check('面板：应用后预览清空、按钮复位',
        ov.querySelector('#wb-preview-box').textContent === '' && ov.querySelector('#wb-apply').disabled === true);
    ov.querySelector('#wb-close').click();
    check('面板：关闭后覆盖层移除', !document.getElementById('ntr-workspace-backup-overlay'));
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    KEYS.forEach((k) => { if (saved[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, saved[k]); });
    window.confirm = origConfirm;
    const ov = document.getElementById('ntr-workspace-backup-overlay');
    if (ov) ov.remove();
    toastObs.disconnect();
    out.notes.push('cleanup: 四个工作区键还原、confirm 还原、覆盖层移除、observer 断开');
}
return JSON.stringify(out, null, 1);
