// 把「AI提取术语表」切成「直接提取 + 写入 + 临时端点(mock)」，给 .e2e-local-write / .e2e-wenku-dryrun
// 这类"现场跑提取"的用例做前置配置（模块设置只存在内存里，刷新页面就回到 TM 存的旧值）
// 跑法：cdp open <页面> + cdp inject 后 node tools/cdp.mjs evalf tools/.setup-direct-extract.js
return (() => {
  const TB = window._NTRToolBox;
  const mod = TB.configuration.modules.find((m) => m.name === 'AI提取术语表');
  const set = (n, v) => {
    const s = mod.settings.find((x) => x.name === n);
    if (s) s.value = v; else mod.settings.push({ name: n, value: v });
    return n + '=' + (mod.settings.find((x) => x.name === n) || {}).value;
  };
  return [
    set('任务方式', '直接提取'), set('模式', '写入'),
    set('使用临时端点', true), set('临时端点', 'http://127.0.0.1:8788'),
    set('临时模型', 'mock-glossary-1'), set('临时Key', 'x'),
    set('原文语言', 'JA'), set('分块字数', 600), set('最大轮数', 2),
    set('输出上限', 0), set('并发', 2), set('RPM', 0), set('逾时(秒)', 60),
  ];
})()
