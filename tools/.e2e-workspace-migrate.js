// 「合并旧工作区翻译器」模块定格：旧 workspace-gpt → 新 workspace-gpt-pipeline 的一次性迁移。
// 覆盖：模块注册/旧模块已退役、普通读取只看 pipeline、新增/跳过同名/覆盖、旧 web 与无效条目、
// 目标 jobs 保留、旧仓不改、StorageEvent、空旧仓提示、目标键不存在时创建、重复执行幂等。
// 跑法：node tools/.run-suite.mjs tools/.e2e-workspace-migrate.js "http://127.0.0.1:8788/wenku/mock-src"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEGACY = 'workspace-gpt';
const PIPE = 'workspace-gpt-pipeline';
const origLegacy = localStorage.getItem(LEGACY);
const origPipe = localStorage.getItem(PIPE);
const origPath = location.pathname;
const setStore = (k, obj) => localStorage.setItem(k, JSON.stringify(obj));
const getStore = (k) => { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; };
const workersOf = (k) => (getStore(k) || {}).workers || [];
const pipeIds = () => workersOf(PIPE).map((w) => w.id);
const legacyIds = () => workersOf(LEGACY).map((w) => w.id);
const worker = (id, model, endpoint, key, extra) => Object.assign({ id, type: 'api', model, endpoint, key }, extra || {});

const toasts = [];
const toastObs = new MutationObserver(() => {
    [...document.querySelectorAll('.ntr-notification-message')].forEach((n) => {
        const t = n.textContent.trim();
        if (!toasts.includes(t)) toasts.push(t);
    });
});
toastObs.observe(document.body, { childList: true, subtree: true });

const events = [];
const onStorage = (e) => events.push({ key: e.key, len: (e.newValue || '').length });
window.addEventListener('storage', onStorage);

try {
    const box = window._NTRToolBox;
    const mod = box.configuration.modules.find((m) => m.name === '合并旧工作区翻译器');
    check('模块「合并旧工作区翻译器」已注册', !!mod);
    check('旧同步模块已退役（配置里不存在）',
        !box.configuration.modules.some((m) => m.name === '复制翻译器到BETA工作区')
        && !box.configuration.modules.some((m) => m.name === '工作区翻译器自动同步'),
        box.configuration.modules.map((m) => m.name));
    if (!mod) throw new Error('模块不存在');
    const overwrite = () => mod.settings.find((s) => s.name === '覆盖同名翻译器');
    const run = async () => { await mod.run(mod); await sleep(80); };

    // A) 普通读取只看 pipeline：旧仓独有的 id 不出现
    setStore(LEGACY, { workers: [worker('legacy-only', 'm-l', 'http://legacy/v1', 'k-l')], jobs: [], uncompletedJobs: [] });
    setStore(PIPE, { workers: [worker('pipe-only', 'm-p', 'http://pipe/v1', 'k-p')], jobs: [], uncompletedJobs: [] });
    const readIds = window._NTRGlossaryDev.readWorkspaceGptWorkers().map((w) => w.id);
    check('普通读取只含 workspace-gpt-pipeline，不含旧仓 workers',
        readIds.includes('pipe-only') && !readIds.includes('legacy-only'), readIds);

    // B) 默认合并不覆盖同名：A 新增、B 保留新仓、web/无效跳过
    setStore(LEGACY, {
        workers: [
            worker('A', 'm-a', 'http://a/v1', 'k-a'),
            worker('B', 'm-b-old', 'http://b-old/v1', 'k-b-old'),
            { id: 'W', type: 'web', model: 'web-mode', endpoint: 'https://chat.openai.com' },
            { endpoint: 'http://no-id/v1' },
            { id: 'no-endpoint' },
        ],
        jobs: [{ task: 'legacy-job', description: '旧任务', createAt: 1 }],
        uncompletedJobs: [],
    });
    setStore(PIPE, {
        workers: [worker('B', 'm-b-new', 'http://b-new/v1', 'k-b-new')],
        jobs: [{ task: 'shared-job', description: '共享任务', createAt: 2 }],
        uncompletedJobs: [{ task: 'shared-rec', description: '共享记录', createAt: 3 }],
    });
    overwrite().value = false;
    events.length = 0;
    await run();
    check('默认合并：A 新增、B 保留新仓配置',
        JSON.stringify(pipeIds().sort()) === JSON.stringify(['A', 'B'])
        && workersOf(PIPE).find((w) => w.id === 'B').model === 'm-b-new',
        workersOf(PIPE));
    check('默认合并：旧 web 与缺 id/endpoint 条目未迁移',
        !pipeIds().includes('W') && !pipeIds().includes('') && pipeIds().length === 2, pipeIds());
    check('默认合并：新仓 jobs/uncompletedJobs 原样保留',
        getStore(PIPE).jobs.length === 1 && getStore(PIPE).jobs[0].task === 'shared-job'
        && getStore(PIPE).uncompletedJobs.length === 1 && getStore(PIPE).uncompletedJobs[0].task === 'shared-rec',
        getStore(PIPE));
    check('默认合并：旧仓数据未改动',
        legacyIds().length === 5 && workersOf(LEGACY).find((w) => w.id === 'B').model === 'm-b-old'
        && getStore(LEGACY).jobs[0].task === 'legacy-job', workersOf(LEGACY).map((w) => w.id));
    check('默认合并：派发 pipeline StorageEvent', events.some((e) => e.key === PIPE && e.len > 0), events);
    check('默认合并：提示新增/跳过同名/跳过旧 web/跳过无效',
        toasts.some((t) => /已合并 1 个旧工作区翻译器/.test(t) && /新增 1/.test(t)
            && /跳过同名 1/.test(t) && /跳过旧 web 1/.test(t) && /跳过无效 2/.test(t)), toasts.slice(-3));

    // C) 重复执行：幂等，不再写入
    events.length = 0;
    const mark = toasts.length;
    await run();
    check('重复执行：不重复添加', pipeIds().length === 2, pipeIds());
    check('重复执行：无变化时不写 pipeline（无 StorageEvent）', events.length === 0, events);
    check('重复执行：提示同名可勾选覆盖',
        toasts.slice(mark).some((t) => /已有同名翻译器（2 个）/.test(t)), toasts.slice(mark));

    // D) 勾选覆盖：用旧仓配置替换同 id
    overwrite().value = true;
    setStore(LEGACY, {
        workers: [worker('A', 'm-a-old2', 'http://a-old2/v1', 'k-a-old2'), worker('B', 'm-b-old2', 'http://b-old2/v1', 'k-b-old2')],
        jobs: [{ task: 'legacy-job', description: '旧任务', createAt: 1 }],
        uncompletedJobs: [],
    });
    events.length = 0;
    await run();
    const afterOverwrite = workersOf(PIPE);
    check('勾选覆盖：同 id 用旧仓配置替换',
        afterOverwrite.find((w) => w.id === 'A').model === 'm-a-old2'
        && afterOverwrite.find((w) => w.id === 'B').model === 'm-b-old2', afterOverwrite);
    check('勾选覆盖：提示覆盖 2', toasts.some((t) => /已合并 2 个旧工作区翻译器/.test(t) && /覆盖 2/.test(t)), toasts.slice(-3));

    // E) 旧仓为空：提示且不写
    setStore(LEGACY, { workers: [], jobs: [], uncompletedJobs: [] });
    events.length = 0;
    const markEmpty = toasts.length;
    await run();
    check('旧仓为空：提示没有可合并的翻译器',
        toasts.slice(markEmpty).some((t) => /没有可合并的翻译器/.test(t)), toasts.slice(markEmpty));
    check('旧仓为空：pipeline 不变且不写', events.length === 0 && pipeIds().sort().join(',') === 'A,B', pipeIds());

    // F) 目标键不存在：创建 pipeline 仓并保留三个数组
    localStorage.removeItem(PIPE);
    setStore(LEGACY, { workers: [worker('C', 'm-c', 'http://c/v1', 'k-c')], jobs: [], uncompletedJobs: [] });
    events.length = 0;
    await run();
    const created = getStore(PIPE);
    check('目标键不存在：创建 workspace-gpt-pipeline 且写入 C',
        !!created && Array.isArray(created.workers) && created.workers.some((w) => w.id === 'C')
        && Array.isArray(created.jobs) && Array.isArray(created.uncompletedJobs), created);
    check('目标键不存在：派发 StorageEvent', events.some((e) => e.key === PIPE), events);
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    toastObs.disconnect();
    window.removeEventListener('storage', onStorage);
    history.replaceState({}, '', origPath);
    [LEGACY, PIPE].forEach((k) => {
        const orig = k === LEGACY ? origLegacy : origPipe;
        if (orig === null) localStorage.removeItem(k); else localStorage.setItem(k, orig);
    });
    const mod = window._NTRToolBox && window._NTRToolBox.configuration.modules.find((m) => m.name === '合并旧工作区翻译器');
    if (mod) {
        const s = mod.settings.find((x) => x.name === '覆盖同名翻译器');
        if (s) s.value = false;
    }
    out.notes.push('cleanup: workspace-gpt / workspace-gpt-pipeline 已还原，覆盖开关复位');
}
return JSON.stringify(out, null, 1);
