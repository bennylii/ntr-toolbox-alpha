// 「翻译器」下拉：应列出工作区 GPT 翻译器 + 「全部（自动轮换）」，且打开设置时刷新列表
// 覆盖两个存储：老工作区 workspace-gpt 与「GPT工作区BETA」的 workspace-gpt-pipeline
const out = { checks: [], notes: [] };
const check = (label, cond, extra) => out.checks.push({ ok: !!cond, label, extra });
const KEY = 'workspace-gpt';
const BETA_KEY = 'workspace-gpt-pipeline';
const backup = localStorage.getItem(KEY);
const betaBackup = localStorage.getItem(BETA_KEY);
const seed = (workers) => localStorage.setItem(KEY, JSON.stringify({ workers, jobs: [], uncompletedJobs: [] }));
const betaSeed = (workers) => localStorage.setItem(BETA_KEY, JSON.stringify({ workers, jobs: [], uncompletedJobs: [] }));
localStorage.removeItem(BETA_KEY);   // 基线：先保证 BETA 存储不存在

let fixtures = window.__selWorkers;
if (!Array.isArray(fixtures)) {
  fixtures = [
    { id: 'gpt-甲', type: 'api', model: 'gpt-4o-mini', endpoint: 'http://127.0.0.1:8788/v1', key: 'sk-a' },
    { id: 'gpt-乙', type: 'api', model: 'gpt-4o', endpoint: 'http://127.0.0.1:8788/v1', key: 'sk-b' },
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
check('列出工作区翻译器 gpt-甲/乙（带模型）', snap1.options.some((o) => o.v === 'gpt-甲' && /gpt-4o-mini/.test(o.t)) && snap1.options.some((o) => o.v === 'gpt-乙'), snap1.options);
check('默认选中「全部」', snap1.value === '', snap1.value);

// 选中 gpt-甲 → 写入配置
sel1.value = 'gpt-甲';
sel1.dispatchEvent(new Event('change', { bubbles: true }));
check('选择后写进配置', mod.settings.find((s) => s.name === '翻译器').value === 'gpt-甲', mod.settings.find((s) => s.name === '翻译器').value);

// 工作区新增一个翻译器 → 再打开设置应看到（不用刷新页面）
seed(JSON.parse(localStorage.getItem(KEY)).workers.concat([
  { id: 'gpt-丙', type: 'api', model: 'qwen3-8b', endpoint: 'http://127.0.0.1:8788/v1', key: 'sk-c' },
]));
await closeSettings();
const sel2 = await openSettings();
const snap2 = readSelect(sel2);
check('新加的 gpt-丙 不用刷新就出现', snap2.options.some((o) => o.v === 'gpt-丙'), snap2.options);
check('之前选中的 gpt-甲 仍在且保持选中', snap2.value === 'gpt-甲', snap2.value);

// 翻译器被删掉时：补一条当前值，不让选中项凭空消失
seed([{ id: 'gpt-丁', type: 'api', model: 'x', endpoint: 'http://127.0.0.1:8788/v1', key: 'sk-d' }]);
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
check('翻译器=空 → 用全部工作区翻译器', all.length === 1 && all[0].id === 'gpt-丁', all);
check('翻译器=指定 id → 只返回该翻译器（含 model/endpoint/key）', one.length === 1 && one[0].id === 'gpt-丁' && one[0].model === 'x', one);
check('翻译器=已删除的 id → 0 个（由调用方提示）', none.length === 0, none);

// GPT工作区BETA（/workspace/gpt-pipeline）另存一份 workspace-gpt-pipeline：那里的翻译器也要能选到
betaSeed([
  { id: 'gpt-戊BETA', type: 'api', model: 'qwen3-14b', endpoint: 'http://127.0.0.1:8788/v1', key: 'sk-e' },
  { id: 'gpt-丁', type: 'api', model: 'x', endpoint: 'http://127.0.0.1:8788/v1', key: 'sk-d' },   // 与老存储完全重复
]);
await closeSettings();
const sel4 = await openSettings();
const snap4 = readSelect(sel4);
check('BETA 工作区的翻译器出现在下拉里', snap4.options.some((o) => o.v === 'gpt-戊BETA' && /qwen3-14b/.test(o.t)), snap4.options);
check('老工作区的翻译器仍在', snap4.options.some((o) => o.v === 'gpt-丁'), snap4.options);
check('两处完全重复的翻译器只列一次', snap4.options.filter((o) => o.v === 'gpt-丁').length === 1, snap4.options.filter((o) => o.v === 'gpt-丁'));
const betaAll = await Dev.resolveGlossaryWorkers(fakeMod(''));
const betaOne = await Dev.resolveGlossaryWorkers(fakeMod('gpt-戊BETA'));
check('翻译器=空 → 合并两个存储（2 个唯一）', betaAll.length === 2, betaAll.map((w) => w.id));
check('能按 id 选中 BETA 工作区的翻译器', betaOne.length === 1 && betaOne[0].model === 'qwen3-14b', betaOne);

// 清理（这个 profile 原本就没有 workspace-gpt，直接删掉还原）
localStorage.removeItem(KEY);
if (betaBackup !== null) localStorage.setItem(BETA_KEY, betaBackup); else localStorage.removeItem(BETA_KEY);
const translatorSetting = mod.settings.find((s) => s.name === '翻译器');
if (translatorSetting) {
  translatorSetting.value = '';   // 别把测试用的 id 留在配置里（连持久化的那份一起复位）
  const box = window._NTRToolBox;
  if (box && typeof box.saveConfiguration === 'function') box.saveConfiguration();
}
await closeSettings();
return JSON.stringify(out, null, 1);
