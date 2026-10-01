// 行为定格（重构前基线）：「资料同步」——上游就存在的空 run 占位模块（hidden: true）
// 没有可执行行为，只钉契约：模块形状、run 为 no-op（localStorage 逐键不变）、bind 值可配置 round-trip。
// 跑法：node tools/.run-suite.mjs tools/.e2e-sync-storage.js "http://127.0.0.1:8788/wenku/mock-src"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };

const box = window._NTRToolBox;
const CFG_KEY = 'NTR_ToolBox_Config';
const savedCfg = localStorage.getItem(CFG_KEY);
const lsSnapshot = () => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; };

try {
    const mod = box.configuration.modules.find((m) => m.name === '资料同步');
    check('模块存在且为 onclick 型', !!mod && mod.type === 'onclick', mod && mod.type);
    check('hidden: true（面板不可见）', mod && mod.hidden === true, mod && mod.hidden);
    check('whitelist = /workspace/*', mod && mod.whitelist === '/workspace/*', mod && mod.whitelist);
    check('settings 仅 bind 一项且默认 none', JSON.stringify(mod.settings) === JSON.stringify([{ name: 'bind', type: 'string', value: 'none' }]), JSON.stringify(mod.settings));

    const before = lsSnapshot();
    let threw = null;
    try { mod.run(mod); } catch (e) { threw = e; }
    check('run 不抛异常', !threw, threw && String(threw));
    check('run 后 localStorage 逐键不变（no-op）', JSON.stringify(lsSnapshot()) === JSON.stringify(before),
        Object.keys(lsSnapshot()).filter((k) => lsSnapshot()[k] !== before[k]));

    // bind 值走 spec-01 配置合并 round-trip
    mod.settings.find((s) => s.name === 'bind').value = 'k';
    box.saveConfiguration();
    const reloaded = box.loadConfiguration();
    check('配置 round-trip：bind 值经 save/load 保留', reloaded.modules.find((m) => m.name === '资料同步').settings.find((s) => s.name === 'bind').value === 'k', null);
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    if (savedCfg === null) localStorage.removeItem(CFG_KEY); else localStorage.setItem(CFG_KEY, savedCfg);
    out.notes.push('cleanup: NTR_ToolBox_Config 还原');
}
return JSON.stringify(out, null, 1);
