// 老配置迁移：以前「临时端点」填了就直接生效 → 现在应自动勾上「使用临时端点」；没填则保持不勾
const out = { checks: [] };
const check = (l, c, e) => out.checks.push({ ok: !!c, label: l, extra: c ? undefined : e });
const KEY = 'NTR_ToolBox_Config';
const backup = localStorage.getItem(KEY);
const box = window._NTRToolBox;
const stage = (settings) => localStorage.setItem(KEY, JSON.stringify({ version: 23, modules: [{ name: 'AI提取术语表', settings }] }));
const probe = (label) => {
  const m = box.loadConfiguration().modules.find((x) => x.name === 'AI提取术语表');
  const get = (n) => (m.settings.find((s) => s.name === n) || {}).value;
  return { label, useTest: get('使用临时端点'), endpoint: get('临时端点'), model: get('临时模型'), translator: get('翻译器'), type: (m.settings.find((s) => s.name === '使用临时端点') || {}).type };
};

try {
  stage([{ name: '临时端点', value: 'http://old.example/v1' }, { name: '临时模型', value: 'old-model' }]);
  const a = probe('老配置填了临时端点');
  check('老配置填过端点 → 自动勾上「使用临时端点」', a.useTest === true, a);
  check('老配置的端点/模型值保留', a.endpoint === 'http://old.example/v1' && a.model === 'old-model', a);
  check('新设置项类型是 boolean（代码为准）', a.type === 'boolean', a.type);

  stage([{ name: '临时端点', value: '' }, { name: '临时模型', value: '' }, { name: '翻译器', value: 'gpt-甲' }]);
  const b = probe('老配置没填临时端点');
  check('没填过端点 → 保持不勾选', b.useTest === false, b);
  check('翻译器选择保留', b.translator === 'gpt-甲', b);

  stage([{ name: '使用临时端点', value: true }, { name: '临时端点', value: '' }]);
  const c = probe('用户自己勾了但没填端点');
  check('已存在的开关值不被迁移覆盖', c.useTest === true, c);
} catch (e) {
  out.error = String(e && (e.stack || e.message));
} finally {
  if (backup === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, backup);
  box.loadConfiguration();
}
return JSON.stringify(out, null, 1);
