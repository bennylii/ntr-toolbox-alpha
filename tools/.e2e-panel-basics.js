// 行为定格（重构前基线）：面板框架契约（下轮 clean-room 重写 spec-03 的前置）
// mock 上 domainAllowed=false —— 点击/键盘路径被域门槛拦下是「上游行为」的一部分，按现状钉住；
// keep 持久化/最小化/拖拽/设置渲染不走域门槛，直调或派发事件断言。
// 跑法：node tools/.run-suite.mjs tools/.e2e-panel-basics.js "http://127.0.0.1:8788/wenku/mock-src"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(60); return fn(); };

const CFG_KEY = 'NTR_ToolBox_Config';
const savedCfg = localStorage.getItem(CFG_KEY);
const savedKeep = localStorage.getItem('NTR_KeepState');
const savedPos = localStorage.getItem('ntr-panel-position');

const box = window._NTRToolBox;
const findMod = (name) => box.configuration.modules.find((m) => m.name === name);

try {
    // ---------- A. 模块行 DOM 结构 ----------
    const containers = [...box.panelBody.querySelectorAll(':scope > .ntr-module-container')];
    check('模块行数量与配置一致', containers.length === box.configuration.modules.length, { containers: containers.length, modules: box.configuration.modules.length });
    const gptContainer = containers[box.configuration.modules.findIndex((m) => m.name === '添加GPT翻译器')];
    const gptHeader = gptContainer.querySelector('.ntr-module-header');
    check('header 含模块名 + ▶/⇋ 图标（onclick=▶ / keep=⇋）', gptHeader.textContent.includes('添加GPT翻译器') && gptHeader.textContent.includes('▶'), gptHeader.textContent);
    const retryHeader = findMod('自动重试') && [...box.panelBody.querySelectorAll('.ntr-module-header')].find((h) => h.textContent.includes('自动重试'));
    check('keep 型模块图标 ⇋', retryHeader && retryHeader.textContent.includes('⇋'), retryHeader && retryHeader.textContent);
    const settingsDiv = gptContainer.querySelector('.ntr-settings-container');
    check('settings-container 默认隐藏', settingsDiv && settingsDiv.style.display === 'none', settingsDiv && settingsDiv.style.display);
    const glance = [...box.panelBody.querySelectorAll('.ntr-module-header')].find((h) => h.textContent.includes('术语队列')).querySelector('.ntr-module-glance');
    check('术语队列行含速览角标（分叉集成点）', !!glance, glance && glance.textContent);
    check('headerMap 缓存了全部 header', box.headerMap.size === box.configuration.modules.length, box.headerMap.size);

    // ---------- B. 右键开/关设置面板 ----------
    gptHeader.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    check('右键：设置面板展开', settingsDiv.style.display === 'block', settingsDiv.style.display);
    check('展开时刷新下拉选项（select 带选项）', settingsDiv.querySelectorAll('select').length === 0 || [...settingsDiv.querySelectorAll('select')].every((s) => s.options.length > 0), null);
    gptHeader.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    check('再右键：设置面板收起', settingsDiv.style.display === 'none', settingsDiv.style.display);

    // ---------- C. 设置行控件类型 ----------
    const ctrl = (name) => settingsDiv.querySelector(`[data-setting-name="${name}"], .ntr-number-input ~ *, input, button, select`);
    const numInput = settingsDiv.querySelector('input[type=number].ntr-number-input');
    const txtInput = settingsDiv.querySelector('input[type=text].ntr-input');
    const bindBtn = settingsDiv.querySelector('button.ntr-bind-button');
    check('number → .ntr-number-input', !!numInput, null);
    check('string → .ntr-number-input 同排的 .ntr-input', !!txtInput, null);
    check('bind → .ntr-bind-button 且显示 (None)', !!bindBtn && bindBtn.textContent === '(None)', bindBtn && bindBtn.textContent);
    const aiSettings = [...box.panelBody.querySelectorAll('.ntr-module-container')][box.configuration.modules.findIndex((m) => m.name === 'AI提取术语表')].querySelector('.ntr-settings-container');
    const modeSelect = aiSettings.querySelector('select[data-setting-name="模式"]');
    check('select 带 data-setting-name 与选项', modeSelect && modeSelect.options.length >= 2, modeSelect && modeSelect.options.length);
    check('settingGroups 折叠框渲染（分叉集成点）', !!aiSettings.querySelector('.ntr-settings-group') && !!aiSettings.querySelector('.ntr-settings-group-head'), null);
    const impSettings = [...box.panelBody.querySelectorAll('.ntr-module-container')][box.configuration.modules.findIndex((m) => m.name === '导入术语表(KWG)')].querySelector('.ntr-settings-container');
    check('textarea → textarea.ntr-input', !!impSettings.querySelector('textarea.ntr-input'), null);
    const retrySettings = [...box.panelBody.querySelectorAll('.ntr-module-container')][box.configuration.modules.findIndex((m) => m.name === '自动重试')].querySelector('.ntr-settings-container');
    check('boolean → checkbox', retrySettings.querySelectorAll('input[type=checkbox]').length === 2, retrySettings.querySelectorAll('input[type=checkbox]').length);

    // ---------- D. 改值即 saveConfiguration ----------
    numInput.value = '7';
    numInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(100);
    let stored = JSON.parse(localStorage.getItem(CFG_KEY));
    const gptStored = stored.modules.find((m) => m.name === '添加GPT翻译器');
    check('onchange 立即写盘 NTR_ToolBox_Config', gptStored && gptStored.settings.find((s) => s.name === '数量').value === 7, gptStored && gptStored.settings.find((s) => s.name === '数量').value);
    numInput.value = '5';
    numInput.dispatchEvent(new Event('change', { bubbles: true }));

    // ---------- E. 域门槛：mock 上点击/键盘不执行模块 ----------
    let runCalls = 0;
    const gptMod = findMod('添加GPT翻译器');
    const origGptRun = gptMod.run;
    gptMod.run = function () { runCalls++; };
    gptHeader.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }));
    await sleep(150);
    check('域门槛：mock 上左键点击 header 不执行 run', runCalls === 0, runCalls);
    box.runModule('添加GPT翻译器');
    await waitFor(() => runCalls > 0);
    check('对照：runModule 直调执行', runCalls >= 1, runCalls);
    gptMod.run = origGptRun;

    // 键盘 bind 同样被白名单+域门槛拦下
    const syncMod = findMod('资料同步');
    syncMod.settings.find((s) => s.name === 'bind').value = 'q';
    let syncCalls = 0;
    const origSyncRun = syncMod.run;
    syncMod.run = function () { syncCalls++; };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true }));
    await sleep(150);
    check('域门槛：bind 键盘路径在 mock 上不执行', syncCalls === 0, syncCalls);
    syncMod.run = origSyncRun;
    syncMod.settings.find((s) => s.name === 'bind').value = 'none';

    // ---------- F. keep 持久化（直调） ----------
    const retryMod = findMod('自动重试');
    const hdr = box.headerMap.get(retryMod);
    box.startKeepModule(retryMod, hdr);
    check('startKeep：header.active + keepActiveSet + NTR_KeepState 写盘', hdr.classList.contains('active')
        && box.keepActiveSet.has('自动重试')
        && JSON.parse(localStorage.getItem('NTR_KeepState') || '{}').自动重试 === true, localStorage.getItem('NTR_KeepState'));
    box.stopKeepModule(retryMod, hdr);
    check('stopKeep：全部还原', !hdr.classList.contains('active') && !box.keepActiveSet.has('自动重试') && !JSON.parse(localStorage.getItem('NTR_KeepState') || '{}').自动重试, localStorage.getItem('NTR_KeepState'));
    localStorage.setItem('NTR_KeepState', JSON.stringify({ '自动重试': true }));
    box.loadKeepStateAndStart();
    check('loadKeepState：按盘上状态恢复激活', box.keepActiveSet.has('自动重试') && hdr.classList.contains('active'), box.keepActiveSet.size);

    // ---------- G. 显隐：mock 上全部隐藏 + 不可见 keep 自动停 ----------
    box.updateModuleVisibility();
    check('mock 域：所有模块行 display:none', containers.every((c) => c.style.display === 'none'), containers.filter((c) => c.style.display !== 'none').length);
    check('不可见 keep 自动停', !box.keepActiveSet.has('自动重试') && !hdr.classList.contains('active'), box.keepActiveSet.size);

    // ---------- H. 最小化（标题栏右键） ----------
    box.titleBar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    check('最小化：toggleSpan 变 [+]、body/infoBar 隐藏', box.toggleSpan.textContent === '[+]' && box.panelBody.style.display === 'none' && box.infoBar.style.display === 'none', { toggle: box.toggleSpan.textContent, body: box.panelBody.style.display });
    await waitFor(() => !!localStorage.getItem('ntr-panel-position'), 1500);   // 位置在 310ms 的锚角计算后写盘
    check('最小化：ntr-panel-position 写盘', !!localStorage.getItem('ntr-panel-position'), localStorage.getItem('ntr-panel-position'));
    box.titleBar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    check('还原：toggleSpan 回 [-]、body 显示', box.toggleSpan.textContent === '[-]' && box.panelBody.style.display !== 'none', box.toggleSpan.textContent);

    // ---------- I. 拖拽：move 生效 + mouseup 写盘 + 视口夹紧 ----------
    const rect = box.panel.getBoundingClientRect();
    box.titleBar.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: rect.left + 10, clientY: rect.top + 5, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.left + 60, clientY: rect.top + 45, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(100);
    const pos1 = JSON.parse(localStorage.getItem('ntr-panel-position') || '{}');
    check('拖拽：位置移动约 +50/+40 并写盘', Math.abs(parseFloat(pos1.left) - (rect.left + 50)) < 3 && Math.abs(parseFloat(pos1.top) - (rect.top + 40)) < 3, pos1);
    // 极端拖拽 → 夹紧在视口内
    const rect2 = box.panel.getBoundingClientRect();
    box.titleBar.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: rect2.left + 10, clientY: rect2.top + 5, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: -100000, clientY: -100000, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(100);
    const pos2 = JSON.parse(localStorage.getItem('ntr-panel-position') || '{}');
    check('拖拽：负坐标被夹紧到视口内', parseFloat(pos2.left) >= 0 && parseFloat(pos2.top) >= 0, pos2);
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    if (savedCfg === null) localStorage.removeItem(CFG_KEY); else localStorage.setItem(CFG_KEY, savedCfg);
    if (savedKeep === null) localStorage.removeItem('NTR_KeepState'); else localStorage.setItem('NTR_KeepState', savedKeep);
    if (savedPos === null) localStorage.removeItem('ntr-panel-position'); else localStorage.setItem('ntr-panel-position', savedPos);
    box.keepActiveSet.clear();
    out.notes.push('cleanup: 配置/keep 状态/面板位置还原，keepActiveSet 清空');
}
return JSON.stringify(out, null, 1);
