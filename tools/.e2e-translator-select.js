// 「翻译器」下拉：只列新版 GPT 工作区（workspace-gpt-pipeline）+「全部（自动轮换）」，
// 且打开设置时刷新列表；旧 workspace-gpt 的 workers 已退役，不应再出现。
const out = { checks: [], notes: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const PIPE = 'workspace-gpt-pipeline';
const LEGACY = 'workspace-gpt';
const pipeBackup = localStorage.getItem(PIPE);
const legacyBackup = localStorage.getItem(LEGACY);
const seed = (workers) => localStorage.setItem(PIPE, JSON.stringify({ workers, jobs: [], uncompletedJobs: [] }));
const seedLegacy = (workers) => localStorage.setItem(LEGACY, JSON.stringify({ workers, jobs: [], uncompletedJobs: [] }));
localStorage.removeItem(PIPE);   // 基线：先保证 pipeline 存储不存在
localStorage.setItem(LEGACY, JSON.stringify({ workers: [], jobs: [], uncompletedJobs: [] }));

const w = (id, model, endpoint, key) => ({ id, type: 'api', model, endpoint, key });

let fixtures = window.__selWorkers;
if (!Array.isArray(fixtures)) {
  fixtures = [
    w('gpt-甲', 'gpt-4o-mini', 'http://127.0.0.1:8788/v1', 'sk-a'),
    w('gpt-乙', 'gpt-4o', 'http://127.0.0.1:8788/v1', 'sk-b'),
  ];
}
seed(fixtures);
const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === 'AI提取术语表');
const header = [...document.querySelectorAll('#ntr-panel .ntr-module-header')].find((h) => h.textContent.includes('AI提取术语表'));
const settingsDiv = header.parentElement.querySelector('.ntr-settings-container');
const syncSettings = async (open) => {
  const isOpen = window.getComputedStyle(settingsDiv).display !== 'none';
  if (isOpen !== open) {
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));
    await new Promise((r) => setTimeout(r, 100));
  }
};
const openSettings = async () => {
  await syncSettings(true);
  return settingsDiv.querySelector('select[data-setting-name="翻译器"]');
};
const closeSettings = () => syncSettings(false);
const readSelect = (sel) => ({ value: sel.value, options: [...sel.options].map((o) => ({ v: o.value, t: o.textContent })) });

// 先强制关一次再打开：不管上一条用例有没有留着设置面板，都保证选项被重新求值
await closeSettings();
const sel1 = await openSettings();
check('设置面板已打开且能找到选择框', !!sel1);
const snap1 = readSelect(sel1);
check('包含「全部（自动轮换）」且值为空串', snap1.options.some((o) => o.v === '' && /全部/.test(o.t)), snap1.options);
check('列出 pipeline 翻译器 gpt-甲/乙（带模型）', snap1.options.some((o) => o.v === 'gpt-甲' && /gpt-4o-mini/.test(o.t)) && snap1.options.some((o) => o.v === 'gpt-乙'), snap1.options);
check('默认选中「全部」', snap1.value === '', snap1.value);

// 选中 gpt-甲 → 写入配置
sel1.value = 'gpt-甲';
sel1.dispatchEvent(new Event('change', { bubbles: true }));
check('选择后写进配置', mod.settings.find((s) => s.name === '翻译器').value === 'gpt-甲', mod.settings.find((s) => s.name === '翻译器').value);

// pipeline 新增一个翻译器 → 再打开设置应看到（不用刷新页面）
seed(JSON.parse(localStorage.getItem(PIPE)).workers.concat([w('gpt-丙', 'qwen3-8b', 'http://127.0.0.1:8788/v1', 'sk-c')]));
await closeSettings();
const sel2 = await openSettings();
const snap2 = readSelect(sel2);
check('新加的 gpt-丙 不用刷新就出现', snap2.options.some((o) => o.v === 'gpt-丙'), snap2.options);
check('之前选中的 gpt-甲 仍在且保持选中', snap2.value === 'gpt-甲', snap2.value);

// 翻译器被删掉时：补一条当前值，不让选中项凭空消失
seed([w('gpt-丁', 'x', 'http://127.0.0.1:8788/v1', 'sk-d')]);
await closeSettings();
const sel3 = await openSettings();
const snap3 = readSelect(sel3);
check('当前值被删后仍在选项里（补 (未设置) 或原值）', snap3.options.some((o) => o.v === 'gpt-甲'), snap3.options);

// worker 解析：按 id 过滤
const Dev = window._NTRGlossaryDev;
const fakeMod = (translator) => ({ name: 'AI提取术语表', settings: [
  { name: '翻译器', value: translator }, { name: '临时端点', value: '' }, { name: '临时模型', value: '' }, { name: '临时Key', value: '' },
] });
const all = await Dev.resolveGlossaryWorkers(fakeMod(''));
const one = await Dev.resolveGlossaryWorkers(fakeMod('gpt-丁'));
const none = await Dev.resolveGlossaryWorkers(fakeMod('不存在'));
check('翻译器=空 → 用全部 pipeline 翻译器', all.length === 1 && all[0].id === 'gpt-丁', all);
check('翻译器=指定 id → 只返回该翻译器（含 model/endpoint/key）', one.length === 1 && one[0].id === 'gpt-丁' && one[0].model === 'x', one);
check('翻译器=已删除的 id → 0 个（由调用方提示）', none.length === 0, none);

// 旧 workspace-gpt 的 workers 已退役：同 id/独有 id 都不应出现
seedLegacy([
  w('gpt-丁', 'legacy-model', 'http://legacy/v1', 'sk-legacy'),
  w('legacy-己', 'legacy-only', 'http://legacy/v1', 'sk-legacy-2'),
]);
await closeSettings();
const sel4 = await openSettings();
const snap4 = readSelect(sel4);
check('旧仓独有 id 不出现', !snap4.options.some((o) => o.v === 'legacy-己'), snap4.options);
check('旧仓同 id 不覆盖 pipeline 版本', snap4.options.filter((o) => o.v === 'gpt-丁').length === 1
  && /x/.test(snap4.options.find((o) => o.v === 'gpt-丁').t), snap4.options.filter((o) => o.v === 'gpt-丁'));
const legacyOnly = await Dev.resolveGlossaryWorkers(fakeMod('legacy-己'));
const sameId = await Dev.resolveGlossaryWorkers(fakeMod('gpt-丁'));
check('按旧仓独有 id 解析 → 0 个', legacyOnly.length === 0, legacyOnly);
check('按同 id 解析 → 只返回 pipeline 的一条', sameId.length === 1 && sameId[0].model === 'x', sameId);

// 清理：两个键都还原；配置里的翻译器复位
if (pipeBackup !== null) localStorage.setItem(PIPE, pipeBackup); else localStorage.removeItem(PIPE);
if (legacyBackup !== null) localStorage.setItem(LEGACY, legacyBackup); else localStorage.removeItem(LEGACY);
const translatorSetting = mod.settings.find((s) => s.name === '翻译器');
if (translatorSetting) {
  translatorSetting.value = '';   // 别把测试用的 id 留在配置里（连持久化的那份一起复位）
  const box = window._NTRToolBox;
  if (box && typeof box.saveConfiguration === 'function') box.saveConfiguration();
}
await closeSettings();
return JSON.stringify(out, null, 1);
