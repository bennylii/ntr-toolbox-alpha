// 行为定格（重构前基线）：排队Sakura v2 / 排队GPT v2 / 清空任务 的任务切分与落库
// 模块从站点接口抓数据后写 localStorage 任务串；这里打桩 fetch + pushState 切页型，
// 断言任务串的精确格式（webLinkBuilder/wenkuLinkBuilder）与智能/固定分段数学。
// 跑法：node tools/.run-suite.mjs tools/.e2e-collect-tasks.js "http://127.0.0.1:8788/novel?e2e=1"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(80); return fn(); };

const GPT_KEY = 'workspace-gpt';
const SK_KEY = 'sakura-workspace';
const savedKeys = {};
[GPT_KEY, SK_KEY].forEach((k) => { savedKeys[k] = localStorage.getItem(k); });
const origHref = location.href;
const origConfirm = window.confirm;
window.confirm = () => true;

// 抓 toast
const toasts = [];
const toastObs = new MutationObserver(() => {
    [...document.querySelectorAll('.ntr-notification-message')].forEach((n) => {
        const t = n.textContent.trim();
        if (!toasts.includes(t)) toasts.push(t);
    });
});
toastObs.observe(document.body, { childList: true, subtree: true });

// 打桩站点接口：/api/novel（搜索）与 /api/wenku/{id}（文库卷目录）
const fetched = [];
const origFetch = window.fetch;
window.fetch = async (url, opts) => {
    const u = String(url);
    fetched.push(u);
    if (u.includes('/api/novel?')) {
        return new Response(JSON.stringify({
            items: [
                { providerId: 'syosetu', novelId: 'n111', titleJp: 'A本', total: 20, sakura: 5, gpt: 4 },
                { providerId: 'kakuyomu', novelId: 'k222', titleZh: 'B本', total: 12, sakura: 0, gpt: 12 },
            ],
        }), { status: 200 });
    }
    const mw = u.match(/\/api\/wenku\/(w\d+)$/);
    if (mw) {
        const volumes = mw[1] === 'w1' ? [{ volumeId: 'v1' }, { volumeId: 'v2' }] : [];
        return new Response(JSON.stringify({ volumeJp: volumes }), { status: 200 });
    }
    return origFetch(url, opts);
};

const readJobs = (key) => { try { return (JSON.parse(localStorage.getItem(key)) || {}).jobs || []; } catch (e) { return []; } };
const setSetting = (modName, name, value) => {
    const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === modName);
    const s = mod.settings.find((x) => x.name === name);
    if (!s) throw new Error(modName + ' 缺少设置 ' + name);
    s.value = value;
};
const run = (modName) => window._NTRToolBox.runModule(modName);

try {
    // ---------- A. 排队Sakura v2 · novels 流（智能分段） ----------
    localStorage.removeItem(SK_KEY);
    setSetting('排队Sakura v2', '单次撷取web数量(可破限)', 20);
    setSetting('排队Sakura v2', '模式', '常规');
    setSetting('排队Sakura v2', '分段', '智能');
    setSetting('排队Sakura v2', '智能均分任务上限', 10);
    setSetting('排队Sakura v2', '智能均分章节下限', 5);
    run('排队Sakura v2');
    // 期望：undone = A(20-5)=15、B(12-0)=12 → 总 27，任务数 min(⌊27/5⌋,10)=5，块大小 ⌈27/5⌉=6
    // A(未完成多者优先)：[5,11] [11,17] [17,20]；B：[0,6] [6,12]
    await waitFor(() => readJobs(SK_KEY).length === 5);
    const skJobs = readJobs(SK_KEY);
    const skTasks = skJobs.map(j => j.task);
    check('Sakura novels：搜索 API 的 URL 形状（pageSize/provider 全量）', fetched.some(u => u.includes('/api/novel?page=0&pageSize=20') && u.includes('provider=kakuyomu%2Csyosetu%2Cnovelup%2Chameln%2Cpixiv%2Calphapolis')), fetched.find(u => u.includes('/api/novel?')));
    check('Sakura novels：智能分段 5 个任务', skJobs.length === 5, skTasks);
    check('Sakura novels：任务串格式与切点', JSON.stringify(skTasks) === JSON.stringify([
        'web/syosetu/n111?level=normal&forceMetadata=false&startIndex=5&endIndex=11',
        'web/syosetu/n111?level=normal&forceMetadata=false&startIndex=11&endIndex=17',
        'web/syosetu/n111?level=normal&forceMetadata=false&startIndex=17&endIndex=20',
        'web/kakuyomu/k222?level=normal&forceMetadata=false&startIndex=0&endIndex=6',
        'web/kakuyomu/k222?level=normal&forceMetadata=false&startIndex=6&endIndex=12',
    ]), skTasks);
    check('Sakura novels：描述取 titleZh ?? titleJp', JSON.stringify(skJobs.map(j => j.description)) === JSON.stringify(['A本', 'A本', 'A本', 'B本', 'B本']), skJobs.map(j => j.description));

    // ---------- B. 排队GPT v2 · novels 流（固定分段） ----------
    localStorage.removeItem(GPT_KEY);
    setSetting('排队GPT v2', '模式', '常规');
    setSetting('排队GPT v2', '分段', '固定');
    setSetting('排队GPT v2', '固定均分任务', 3);
    run('排队GPT v2');
    // 期望：gpt 进度下 A undone=16、B undone=12-12=0 跳过；A 每本 3 块，块大小 ⌈16/3⌉=6，startBase=4
    await waitFor(() => readJobs(GPT_KEY).length === 3);
    const gptJobs = readJobs(GPT_KEY);
    check('GPT novels：固定分段 3 个任务（B 已译完跳过）', gptJobs.length === 3, gptJobs.map(j => j.task));
    check('GPT novels：任务串格式与切点', JSON.stringify(gptJobs.map(j => j.task)) === JSON.stringify([
        'web/syosetu/n111?level=normal&forceMetadata=false&startIndex=4&endIndex=10',
        'web/syosetu/n111?level=normal&forceMetadata=false&startIndex=10&endIndex=16',
        'web/syosetu/n111?level=normal&forceMetadata=false&startIndex=16&endIndex=20',
    ]), gptJobs.map(j => j.task));
    check('GPT novels：写入 workspace-gpt', !!localStorage.getItem(GPT_KEY), null);

    // ---------- C. 排队Sakura v2 · wenkus 流（列表页 → 卷目录） ----------
    localStorage.removeItem(SK_KEY);
    history.pushState({}, '', '/wenku');
    const stage = document.createElement('div');
    stage.id = 'ntr-e2e-collect-stage';
    ['w1', 'w2'].forEach((id) => {
        const a = document.createElement('a');
        a.href = '/wenku/' + id;
        a.textContent = 'item-' + id;
        stage.appendChild(a);
    });
    document.body.appendChild(stage);
    run('排队Sakura v2');
    await waitFor(() => readJobs(SK_KEY).length === 2);
    const wkJobs = readJobs(SK_KEY);
    check('Sakura wenkus：按列表链接取 id、卷目录生成任务（w2 无卷跳过）', JSON.stringify(wkJobs.map(j => j.task)) === JSON.stringify([
        'wenku/w1/v1?level=normal&forceMetadata=false&startIndex=0&endIndex=65536',
        'wenku/w1/v2?level=normal&forceMetadata=false&startIndex=0&endIndex=65536',
    ]), wkJobs.map(j => j.task));
    check('Sakura wenkus：描述为卷 id', JSON.stringify(wkJobs.map(j => j.description)) === JSON.stringify(['v1', 'v2']), wkJobs.map(j => j.description));

    // ---------- D. 清空任务 ----------
    history.pushState({}, '', '/workspace/gpt');
    setSetting('清空任务', '确认清空', true);
    run('清空任务');
    await waitFor(() => readJobs(GPT_KEY).length === 0);
    check('清空任务：确认后清空 workspace-gpt 并 toast 计数', readJobs(GPT_KEY).length === 0 && toasts.some(t => t.includes('已清空 3 个任务')), toasts);
    // 仅清空已完成 → 提示不支持、不动数据
    localStorage.setItem(GPT_KEY, JSON.stringify({ workers: [], jobs: [{ task: 'x', description: 'y' }], uncompletedJobs: [] }));
    setSetting('清空任务', '仅清空已完成', true);
    const mark1 = toasts.length;
    run('清空任务');
    await sleep(400);
    check('清空任务：仅清空已完成 → 警告且数据不变', toasts.slice(mark1).some(t => t.includes('仅清空已完成功能需配合网站API')) && readJobs(GPT_KEY).length === 1, toasts.slice(mark1));
    // 非工作区 URL → 报错 toast
    history.replaceState({}, '', origHref);
    setSetting('清空任务', '仅清空已完成', false);
    const mark2 = toasts.length;
    run('清空任务');
    await sleep(400);
    check('清空任务：非工作区 URL → 无法确定工作区类型', toasts.slice(mark2).some(t => t.includes('无法确定工作区类型')), toasts.slice(mark2));
    // 排队成功 toast（带本数与分段数）
    check('Sakura novels：排队成功 toast（2 本 5 段）', toasts.some(t => t.includes('排队成功 : 共 2 本小说, 均分 5 分段')), toasts.filter(t => t.includes('排队成功')));
    check('GPT novels：排队成功 toast（1 本 3 段）', toasts.some(t => t.includes('排队成功 : 共 1 本小说, 均分 3 分段')), toasts.filter(t => t.includes('排队成功')));
    check('Sakura wenkus：排队成功 toast（2 本 2 段）', toasts.some(t => t.includes('排队成功 : 共 2 本小说, 均分 2 分段')), toasts.filter(t => t.includes('排队成功')));
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    Object.keys(savedKeys).forEach((k) => { if (savedKeys[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, savedKeys[k]); });
    window.confirm = origConfirm;
    window.fetch = origFetch;
    history.replaceState({}, '', origHref);
    document.querySelectorAll('#ntr-e2e-collect-stage').forEach((e) => e.remove());
    toastObs.disconnect();
    out.notes.push('cleanup: localStorage 键还原、fetch/confirm 还原、URL 还原、stage DOM 移除、observer 断开');
}
return JSON.stringify(out, null, 1);
