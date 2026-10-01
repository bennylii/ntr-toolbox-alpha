// 行为定格（重构前基线）：StorageUtils（经模块驱动间接钉住 —— 类本身不暴露在 _NTRToolBox/_NTRGlossaryDev 上）
// 覆盖：键名域名分支、_getData 损坏自愈归一化、addJobs 同 task 去重、_setData 的 StorageEvent、
//       主循环 href 变化触发的 update()（读改写回 + 缺失字段补齐）。
// 注意：必须在 /novel 列表页跑 —— 排队 v2 在 /wenku/{id} 详情页走的是 clickButtons 分支而非 novels API。
// 跑法：node tools/.run-suite.mjs tools/.e2e-storage-utils.js "http://127.0.0.1:8788/novel?e2e=1"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(80); return fn(); };

const GPT_KEY = 'workspace-gpt';
const SK_KEY = 'sakura-workspace';
const savedKeys = {};
[GPT_KEY, SK_KEY].forEach((k) => { savedKeys[k] = localStorage.getItem(k); });
const origHref = location.href;

const readData = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return undefined; } };
const box = window._NTRToolBox;
const run = (modName) => box.runModule(modName);
const setSetting = (modName, name, value) => {
    const mod = box.configuration.modules.find((m) => m.name === modName);
    const s = mod.settings.find((x) => x.name === name);
    if (s) s.value = value;
};
const savedModuleSettings = {};
['添加Sakura翻译器', '删除翻译器'].forEach((n) => {
    const mod = box.configuration.modules.find((m) => m.name === n);
    savedModuleSettings[n] = mod.settings.map((s) => ({ name: s.name, value: s.value }));
});

try {
    // ---------- A. 键名域名分支：127.0.0.1 下 sakura → sakura-workspace ----------
    localStorage.removeItem(SK_KEY);
    const sakuraMod = box.configuration.modules.find((m) => m.name === '添加Sakura翻译器');
    sakuraMod.settings.find((s) => s.name === '数量').value = 1;
    sakuraMod.settings.find((s) => s.name === '名称').value = '甲';
    run('添加Sakura翻译器');
    await waitFor(() => !!localStorage.getItem(SK_KEY));
    check('键名：非 novelia 域写 sakura-workspace（而非 workspace-sakura）', !!localStorage.getItem(SK_KEY) && !localStorage.getItem('workspace-sakura'), Object.keys(localStorage));
    const data = readData(SK_KEY);
    check('归一化：workers/jobs/uncompletedJobs 三字段齐', data && Array.isArray(data.workers) && Array.isArray(data.jobs) && Array.isArray(data.uncompletedJobs), Object.keys(data || {}));

    // ---------- B. _setData 派发 StorageEvent ----------
    let ev = null;
    const onStorage = (e) => { if (e.key === SK_KEY) ev = e; };
    window.addEventListener('storage', onStorage);
    sakuraMod.settings.find((s) => s.name === '名称').value = '乙';
    run('添加Sakura翻译器');
    await waitFor(() => !!ev);
    check('StorageEvent：key/newValue 带新值', ev && ev.newValue && JSON.parse(ev.newValue).workers.some((w) => w.id === '乙1'), ev && ev.newValue && JSON.parse(ev.newValue).workers.map((w) => w.id));
    window.removeEventListener('storage', onStorage);

    // ---------- C. addJobs 同 task 去重：排队 v2 连跑两次，任务不翻倍 ----------
    localStorage.removeItem(SK_KEY);
    const collectMod = box.configuration.modules.find((m) => m.name === '排队Sakura v2');
    const savedCollect = collectMod.settings.map((s) => ({ name: s.name, value: s.value }));
    const origFetch = window.fetch;
    window.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/novel?')) {
            return new Response(JSON.stringify({ items: [{ providerId: 'syosetu', novelId: 'dedupe1', titleJp: '去重书', total: 10, sakura: 0 }] }), { status: 200 });
        }
        return origFetch(url);
    };
    setSetting('排队Sakura v2', '分段', '固定');
    setSetting('排队Sakura v2', '固定均分任务', 2);
    run('排队Sakura v2');
    await waitFor(() => (readData(SK_KEY) || { jobs: [] }).jobs.length === 2);
    run('排队Sakura v2');
    await sleep(600);
    check('addJobs 去重：同 task 二次入队不翻倍（仍 2 条）', (readData(SK_KEY) || { jobs: [] }).jobs.length === 2, (readData(SK_KEY) || { jobs: [] }).jobs.length);
    window.fetch = origFetch;
    collectMod.settings.forEach((s) => { const sv = savedCollect.find((x) => x.name === s.name); if (sv) s.value = sv.value; });

    // ---------- D. _getData 损坏自愈：坏 JSON → 移除重建为归一化结构 ----------
    localStorage.setItem(GPT_KEY, '{corrupted json!!');
    history.pushState({}, '', '/workspace/gpt');
    setSetting('删除翻译器', '确认删除', false);
    run('删除翻译器');
    await waitFor(() => { const d = readData(GPT_KEY); return d && Array.isArray(d.workers) && d.workers.length === 0; });
    const healed = readData(GPT_KEY);
    check('自愈：坏 JSON 被重建为归一化空结构', healed && Array.isArray(healed.workers) && healed.workers.length === 0 && Array.isArray(healed.jobs) && Array.isArray(healed.uncompletedJobs), healed);
    history.replaceState({}, '', origHref);
    await sleep(500);   // 等一次 250ms 可见性 tick 把 _lastEndPoint 收敛回原 href

    // ---------- E. 主循环 href 变化 → StorageUtils.update()：读改写回 + 缺字段补齐 ----------
    localStorage.setItem(GPT_KEY, JSON.stringify({ workers: [{ id: '仅有worker' }] }));   // 故意缺 jobs/uncompletedJobs
    history.pushState({}, '', '/workspace/gpt?b=1');   // 与 D 的 URL 不同，确保 href 判定变化成立
    await waitFor(() => { const d = readData(GPT_KEY); return d && Array.isArray(d.jobs) && Array.isArray(d.uncompletedJobs); }, 6000);
    const updated = readData(GPT_KEY);
    check('update()：href 切到 workspace 后读改写回并补齐缺字段', updated && updated.workers.length === 1 && Array.isArray(updated.jobs) && Array.isArray(updated.uncompletedJobs), updated && Object.keys(updated));
    history.replaceState({}, '', origHref);
    // 非 workspace 路径下再切一次：不应报错、数据保持
    localStorage.setItem(GPT_KEY, JSON.stringify({ workers: [], jobs: [], uncompletedJobs: [] }));
    history.pushState({}, '', '/novel');
    await sleep(700);
    check('update()：非 workspace 路径 no-op', (readData(GPT_KEY) || {}).workers && (readData(GPT_KEY) || {}).workers.length === 0, readData(GPT_KEY));
    history.replaceState({}, '', origHref);
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    Object.keys(savedKeys).forEach((k) => { if (savedKeys[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, savedKeys[k]); });
    Object.keys(savedModuleSettings).forEach((n) => {
        const mod = box.configuration.modules.find((m) => m.name === n);
        savedModuleSettings[n].forEach(({ name, value }) => { const s = mod.settings.find((x) => x.name === name); if (s) s.value = value; });
    });
    history.replaceState({}, '', origHref);
    out.notes.push('cleanup: localStorage 键还原、模块设置还原、URL 还原');
}
return JSON.stringify(out, null, 1);
