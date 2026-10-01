// 临时端点折叠框：默认收起+禁用；勾选开关 → 自动展开且可编辑；取消勾选 → 收起+禁用；勾选时覆盖翻译器下拉
const out = { checks: [] };
const check = (l, c, e) => out.checks.push({ ok: !!c, label: l, extra: c ? undefined : e });
const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === 'AI提取术语表');
const header = [...document.querySelectorAll('#ntr-panel .ntr-module-header')].find((h) => h.textContent.includes('AI提取术语表'));
const sd = header.parentElement.querySelector('.ntr-settings-container');
const openSettings = async () => {
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));
  await new Promise((r) => setTimeout(r, 120));
};
if (sd.style.display === 'none') await openSettings();
else { await openSettings(); await openSettings(); }   // 保证处于打开状态

const box = sd.querySelector('.ntr-settings-group');
check('三个临时设置收进同一个折叠框', !!box);
const head = box.querySelector('.ntr-settings-group-head');
const body = box.querySelector('.ntr-settings-group-body');
const toggle = sd.querySelector('input[type=checkbox][data-setting-name="使用临时端点"]');
check('开关「使用临时端点」在框外', !!toggle && !box.contains(toggle));
check('框内就是 临时端点/临时模型/临时Key', [...body.querySelectorAll('label')].map((l) => l.textContent.trim().replace(':','')).join('/') === '临时端点/临时模型/临时Key', [...body.querySelectorAll('label')].map((l) => l.textContent));

// 先复位成未勾选
toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
check('未勾选：框收起', body.style.display === 'none', body.style.display);
check('未勾选：框内输入禁用', [...body.querySelectorAll('input')].every((i) => i.disabled));
check('未勾选：标题是收起箭头', head.textContent.startsWith('▸'), head.textContent);

toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
check('勾选后：自动展开', body.style.display === 'block', body.style.display);
check('勾选后：框内输入可编辑', [...body.querySelectorAll('input')].every((i) => !i.disabled));
check('勾选后：标题是展开箭头', head.textContent.startsWith('▾'), head.textContent);

// 填值 → 覆盖翻译器下拉
const setVal = (name, v) => { const el = [...body.querySelectorAll('input')].find((i) => i.previousElementSibling.textContent.includes(name)); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
setVal('临时端点', 'http://127.0.0.1:8788/v1');
setVal('临时模型', 'mock-glossary-1');
setVal('临时Key', 'sk-x');
const Dev = window._NTRGlossaryDev;
const w1 = await Dev.resolveGlossaryWorkers(mod);
check('勾选后 workers 用临时端点（覆盖翻译器下拉）', w1.length === 1 && w1[0].endpoint === 'http://127.0.0.1:8788/v1' && w1[0].model === 'mock-glossary-1', w1);

// 取消勾选 → 回到工作区翻译器（此 profile 无翻译器 → 0 个）
toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
check('取消勾选：重新收起并禁用', body.style.display === 'none' && [...body.querySelectorAll('input')].every((i) => i.disabled));
const w2 = await Dev.resolveGlossaryWorkers(mod);
check('取消勾选后不再用临时端点（回落工作区翻译器）', w2.length === 0 || w2.every((w) => w.endpoint !== 'http://127.0.0.1:8788/v1'), w2);

// 折叠框手动展开/收起
toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
check('点标题可手动收起', body.style.display === 'none', body.style.display);
head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
check('再点一次可展开', body.style.display === 'block', body.style.display);

// 收尾：清掉测试值 + 复位开关
setVal('临时端点', ''); setVal('临时模型', ''); setVal('临时Key', '');
toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
return JSON.stringify(out, null, 1);
