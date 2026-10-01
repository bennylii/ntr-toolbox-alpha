// 配置合并回归（这两处都坑过：整段替换 settings、白名单被旧值覆盖）
// 跑法：node tools/cdp.mjs evalf tools/.e2e-config.js
// 直接调 script.loadConfiguration()，不用刷新页面：塞一份"老配置"进 localStorage → 看合并结果 → 恢复原配置。
const KEY = 'NTR_ToolBox_Config';
const box = window._NTRToolBox;
const backup = localStorage.getItem(KEY);
const out = { cases: [] };

const get = (mod, name) => (mod.settings.find((s) => s.name === name) || {}).value;
const stage = (modules) => localStorage.setItem(KEY, JSON.stringify({ version: 23, modules }));

try {
  const before = JSON.parse(backup || '{}');
  // 基线：优先用存储里的模块数；全新 origin（例如 mock 离线测试页）localStorage 是空的，就退回当前实例的模块数
  const baselineCount = (before.modules && before.modules.length) || box.configuration.modules.length;

  // 1) 老配置：老模块名 + 缺新设置项 + 陈旧白名单 + 幽灵设置项 + 缺模块
  stage([
    {
      name: 'AI提取术语表',
      whitelist: ['/stale-route'],
      settings: [
        { name: '模式', value: '写入' },
        { name: '分块字数', value: 1234 },
        { name: '临时端点', value: 'http://127.0.0.1:8788' },
        { name: '幽灵设置', value: '不该被保留' },
      ],
    },
    { name: '導入術語表(KWG)', settings: [{ name: '術語表', value: '旧模块名的值' }] },
    { name: '导入术语表(KWG)', settings: [{ name: '术语表', value: '应保留的术语表文本' }] },
  ]);
  const cfg = box.loadConfiguration();
  const ai = cfg.modules.find((m) => m.name === 'AI提取术语表');
  const imp = cfg.modules.find((m) => m.name === '导入术语表(KWG)');
  out.cases.push({
    label: '老配置升级：保留用户值 + 补齐新设置项 + 白名单以代码为准',
    userValuePreserved: get(ai, '模式') === '写入',
    userNumberPreserved: String(get(ai, '分块字数')) === '1234',
    userTextPreserved: get(ai, '临时端点') === 'http://127.0.0.1:8788',
    newSettingsBackfilled: get(ai, '逾时(秒)') === 300 && get(ai, 'RPM') === 0 && get(ai, '并发') === 2,
    ghostSettingIgnored: !ai.settings.some((s) => s.name === '幽灵设置'),
    whitelistFromCode: JSON.stringify(ai.whitelist) === JSON.stringify(['/novel', '/wenku', '/favorite', '/workspace']),
    oldNameModuleIgnored: !cfg.modules.some((m) => m.name === '導入術語表(KWG)'),
    textSettingPreserved: get(imp, '术语表') === '应保留的术语表文本',
    modulesComplete: cfg.modules.length === baselineCount,
    runReattached: typeof ai.run === 'function' && typeof imp.run === 'function',
    allModuleNames: cfg.modules.map((m) => m.name),
  });

  // 2) 版本不符 → 直接回落全新默认（不带旧值）
  localStorage.setItem(KEY, JSON.stringify({ version: 1, modules: [{ name: 'AI提取术语表', settings: [{ name: '模式', value: '写入' }] }] }));
  const fresh = box.loadConfiguration();
  const freshAi = fresh.modules.find((m) => m.name === 'AI提取术语表');
  out.cases.push({
    label: '版本号不符 → 全新默认配置',
    versionMatched: fresh.version === 23,
    modeIsDefault: get(freshAi, '模式') === '预览',
    modulesComplete: fresh.modules.length === baselineCount,
  });

  // 3) 完全空 localStorage → 不炸
  localStorage.removeItem(KEY);
  const emptyCfg = box.loadConfiguration();
  out.cases.push({
    label: 'localStorage 空 → 全新默认配置',
    modulesComplete: emptyCfg.modules.length === baselineCount,
    modeIsDefault: get(emptyCfg.modules.find((m) => m.name === 'AI提取术语表'), '模式') === '预览',
  });
} catch (e) {
  out.error = 'fatal: ' + (e && (e.stack || e.message || e));
} finally {
  // 恢复原配置
  if (backup === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, backup);
}
out.restored = localStorage.getItem(KEY) === backup;
return JSON.stringify(out, null, 1);
