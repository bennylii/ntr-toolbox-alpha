// 行为定格（重构前基线）：添加GPT/Sakura翻译器、删除翻译器、启动翻译器
// 这些模块直接读写 localStorage（127.0.0.1 下 gpt='workspace-gpt'、sakura='sakura-workspace'），
// 删除/启动分支按 location.href 判定工作区类型 —— 用 pushState 切换，无需真导航。
// 跑法：node tools/.run-suite.mjs tools/.e2e-translator-mgmt.js "http://127.0.0.1:8788/wenku/mock-src"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(80); return fn(); };

const GPT_KEY = 'workspace-gpt';      // StorageUtils.gpt（127.0.0.1 分支）
const SK_KEY = 'sakura-workspace';    // StorageUtils.sakura（非 n.novelia.cc 分支）
const savedKeys = {};
[GPT_KEY, SK_KEY].forEach((k) => { savedKeys[k] = localStorage.getItem(k); });
const origHref = location.href;
let confirmCalls = 0;
const origConfirm = window.confirm;
window.confirm = () => { confirmCalls++; return true; };

// 抓 toast（存活约 1.3s，用 MutationObserver 边出现边抓）
const toasts = [];
const toastObs = new MutationObserver(() => {
    [...document.querySelectorAll('.ntr-notification-message')].forEach((n) => {
        const t = n.textContent.trim();
        if (!toasts.includes(t)) toasts.push(t);
    });
});
toastObs.observe(document.body, { childList: true, subtree: true });

const readWorkers = (key) => { try { return (JSON.parse(localStorage.getItem(key)) || {}).workers || []; } catch (e) { return []; } };
const setSetting = (modName, name, value) => {
    const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === modName);
    const s = mod.settings.find((x) => x.name === name);
    if (!s) throw new Error(modName + ' 缺少设置 ' + name);
    s.value = value;
};
const run = (modName) => window._NTRToolBox.runModule(modName);

try {
    // ---------- A. 添加GPT翻译器 ----------
    localStorage.removeItem(GPT_KEY);
    let storageEvents = [];
    const onStorage = (e) => { if (e.key === GPT_KEY) storageEvents.push(e); };
    window.addEventListener('storage', onStorage);
    setSetting('添加GPT翻译器', '数量', 3);
    setSetting('添加GPT翻译器', '名称', '甲');
    setSetting('添加GPT翻译器', '模型', 'm1');
    setSetting('添加GPT翻译器', '链接', 'http://127.0.0.1:8788/v1');
    setSetting('添加GPT翻译器', 'Key', 'k1');
    run('添加GPT翻译器');
    await waitFor(() => readWorkers(GPT_KEY).length === 3);
    const gptWorkers = readWorkers(GPT_KEY);
    check('添加GPT：数量=3 生成 甲1..甲3', JSON.stringify(gptWorkers.map(w => w.id)) === JSON.stringify(['甲1', '甲2', '甲3']), gptWorkers.map(w => w.id));
    check('添加GPT：worker 字段 type/model/endpoint/key', gptWorkers.every(w => w.type === 'api' && w.model === 'm1' && w.endpoint === 'http://127.0.0.1:8788/v1' && w.key === 'k1'), gptWorkers[0]);
    const gptRaw = JSON.parse(localStorage.getItem(GPT_KEY));
    check('添加GPT：数据带 jobs/uncompletedJobs 归一化', Array.isArray(gptRaw.jobs) && Array.isArray(gptRaw.uncompletedJobs), Object.keys(gptRaw));
    check('添加GPT：写入派发 StorageEvent(key=workspace-gpt)', storageEvents.length >= 1, storageEvents.length);
    // 重跑同 id 覆盖（不新增）
    setSetting('添加GPT翻译器', '数量', 1);
    setSetting('添加GPT翻译器', '模型', 'm2');
    run('添加GPT翻译器');
    await waitFor(() => (readWorkers(GPT_KEY)[0] || {}).model === 'm2');
    check('添加GPT：同 id 覆盖不新增', readWorkers(GPT_KEY).length === 3 && readWorkers(GPT_KEY)[0].model === 'm2' && readWorkers(GPT_KEY)[1].model === 'm1', readWorkers(GPT_KEY).map(w => w.id + ':' + w.model));

    // ---------- B. 添加Sakura翻译器 ----------
    localStorage.removeItem(SK_KEY);
    setSetting('添加Sakura翻译器', '数量', 2);
    setSetting('添加Sakura翻译器', '名称', '乙');
    setSetting('添加Sakura翻译器', '链接', 'http://sakura.example');
    run('添加Sakura翻译器');
    await waitFor(() => readWorkers(SK_KEY).length === 2);
    const skWorkers = readWorkers(SK_KEY);
    check('添加Sakura：数量=2 生成 乙1..乙2', JSON.stringify(skWorkers.map(w => w.id)) === JSON.stringify(['乙1', '乙2']), skWorkers.map(w => w.id));
    check('添加Sakura：worker 字段 endpoint/prevSegLength/segLength', skWorkers.every(w => w.endpoint === 'http://sakura.example' && w.prevSegLength === 500 && w.segLength === 500), skWorkers[0]);

    // ---------- C. 删除翻译器（/workspace/gpt 分支） ----------
    history.pushState({}, '', '/workspace/gpt');
    localStorage.setItem(GPT_KEY, JSON.stringify({ workers: [{ id: '甲1' }, { id: '甲2' }, { id: '甲3' }, { id: '共享' }], jobs: [], uncompletedJobs: [] }));
    setSetting('删除翻译器', '确认删除', true);
    setSetting('删除翻译器', '排除', '共享,本机,AutoDL');
    run('删除翻译器');
    await waitFor(() => readWorkers(GPT_KEY).length === 1);
    check('删除GPT：排除名单外全删、共享保留', JSON.stringify(readWorkers(GPT_KEY).map(w => w.id)) === JSON.stringify(['共享']), readWorkers(GPT_KEY).map(w => w.id));
    check('删除GPT：确认弹窗出现且被接受', confirmCalls >= 1, confirmCalls);
    check('删除GPT：成功 toast', toasts.some(t => t.includes('已删除 GPT 翻译器')), toasts);
    // confirm=false → 取消
    const cancelMark = toasts.length;
    window.confirm = () => false;
    localStorage.setItem(GPT_KEY, JSON.stringify({ workers: [{ id: '甲1' }, { id: '甲2' }], jobs: [], uncompletedJobs: [] }));
    run('删除翻译器');
    await sleep(400);
    check('删除GPT：confirm=false → 已取消删除 toast', toasts.slice(cancelMark).some(t => t.includes('已取消删除')), toasts.slice(cancelMark));
    check('删除GPT：取消后 worker 不变', readWorkers(GPT_KEY).length === 2, readWorkers(GPT_KEY).map(w => w.id));
    // 确认删除=false → 不弹窗直接删
    window.confirm = () => { confirmCalls++; return true; };
    const confirmBefore = confirmCalls;
    setSetting('删除翻译器', '确认删除', false);
    run('删除翻译器');
    await waitFor(() => readWorkers(GPT_KEY).length === 0);
    check('删除GPT：关闭确认 → 直接删空且不再弹窗', readWorkers(GPT_KEY).length === 0 && confirmCalls === confirmBefore, { workers: readWorkers(GPT_KEY).length, confirmCalls });
    // sakura 分支
    history.pushState({}, '', '/workspace/sakura');
    localStorage.setItem(SK_KEY, JSON.stringify({ workers: [{ id: '乙1' }, { id: '乙2' }], jobs: [], uncompletedJobs: [] }));
    run('删除翻译器');
    await waitFor(() => readWorkers(SK_KEY).length === 0);
    check('删除Sakura：toast 且清空', toasts.some(t => t.includes('已删除 Sakura 翻译器')) && readWorkers(SK_KEY).length === 0, readWorkers(SK_KEY));
    // 非工作区 URL → 静默 no-op
    history.replaceState({}, '', origHref);
    const delMark = toasts.length;
    localStorage.setItem(GPT_KEY, JSON.stringify({ workers: [{ id: '甲1' }], jobs: [], uncompletedJobs: [] }));
    run('删除翻译器');
    await sleep(400);
    check('删除：非工作区 URL → 无 toast、数据不动', toasts.length === delMark && readWorkers(GPT_KEY).length === 1, { newToasts: toasts.slice(delMark) });

    // ---------- D. 启动翻译器 ----------
    const stage = document.createElement('div');
    stage.id = 'ntr-e2e-launch-stage';
    const clicked = [];
    const mkItem = (withError) => {
        const item = document.createElement('div');
        item.className = 'n-list-item';
        const b = document.createElement('button');
        b.textContent = '启动';
        b.addEventListener('click', () => clicked.push(b));
        item.appendChild(b);
        if (withError) {
            const err = document.createElement('div');
            err.textContent = 'TypeError: Failed to fetch';
            item.appendChild(err);
        }
        stage.appendChild(item);
        return b;
    };
    const b1 = mkItem(false), b2 = mkItem(false), bErr = mkItem(true), b3 = mkItem(false);
    document.body.appendChild(stage);
    setSetting('启动翻译器', '最多启动', 2);
    setSetting('启动翻译器', '延迟间隔', 15);
    setSetting('启动翻译器', '避免无效启动', false);
    run('启动翻译器');
    await sleep(500);
    check('启动翻译器：最多启动=2 → 只点前两个有效按钮', clicked.length === 2 && clicked[0] === b1 && clicked[1] === b2, clicked.length);
    check('启动翻译器：带 TypeError 的条目被跳过', !clicked.includes(bErr), clicked.length);
    check('启动翻译器：第三个有效按钮未被点（上限）', !clicked.includes(b3), clicked.length);
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    Object.keys(savedKeys).forEach((k) => { if (savedKeys[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, savedKeys[k]); });
    window.confirm = origConfirm;
    window.removeEventListener('storage', () => { });
    history.replaceState({}, '', origHref);
    document.querySelectorAll('#ntr-e2e-launch-stage').forEach((e) => e.remove());
    toastObs.disconnect();
    out.notes.push('cleanup: localStorage 键还原、URL 还原、stage DOM 移除、observer 断开');
}
return JSON.stringify(out, null, 1);
