// 文件导入的**点选路径** + 解析健壮性（BOM / CRLF / 数组 JSON / 坏 JSON / 空文件 / 临时端点校验）
// 跑法：cdp open http://127.0.0.1:8788/novel/mock/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-import-files.js
// ⚠️ 目标页必须是**两段路径**（/novel/<provider>/<id>，例如 /novel/mock/mock-src）：/novel/mock-1 只有一段，
//    resolveGlossaryTarget() 会落到"本地卷"分支弹「选择本地卷」，需要目标的用例会卡死在那里
// 说明：写入仍走 fetch 拦截（干跑）；"选择文件"用「打桩 input.click 拿到脚本创建的 input → 用 DataTransfer 赋值 files → 派发 change」
//       模拟用户选文件，既覆盖真实代码路径又不会弹出系统对话框。
const out = { cases: [], errors: [] };
window.confirm = () => true;

const waitFor = (predicate, timeoutMs) => new Promise((resolve) => {
  if (predicate()) return resolve(true);
  const obs = new MutationObserver(() => { if (predicate()) { obs.disconnect(); resolve(true); } });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { obs.disconnect(); resolve(false); }, timeoutMs);
});

const clickText = (want) => {
  const el = [...document.querySelectorAll('button, .ntr-g-btn')].find((e) => e.textContent.trim() === want);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
};

const origFetch = window.fetch;
const captured = [];
window.fetch = async (url, opts) => {
  if (opts && opts.method === 'PUT' && String(url).includes('/glossary')) {
    captured.push({ url: String(url), body: opts.body });
    return new Response('', { status: 200 });
  }
  return origFetch(url, opts);
};

// 通知只活 1 秒，必须边出现边抓
const seen = [];
const notesObs = new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => {
  if (n.nodeType === 1 && n.classList && n.classList.contains('ntr-notification-message')) seen.push(n.textContent.trim());
})));
notesObs.observe(document.body, { childList: true, subtree: true });

const MOD = () => window._NTRToolBox.configuration.modules.find((m) => m.name === '导入术语表(KWG)');
const set = (name, value) => { MOD().settings.find((s) => s.name === name).value = value; };

const overlaySnap = () => {
  const o = document.getElementById('ntr-glossary-overlay');
  if (!o || !o.querySelector('.ntr-g-stats')) return null;
  return {
    stats: o.querySelector('.ntr-g-stats').textContent,
    rows: o.querySelectorAll('tbody tr').length,
    checked: [...o.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length,
  };
};

// 模拟用户通过「选择 JSON 文件」按钮选文件
const pickWithFile = (name, content, type = 'application/json') => {
  const origClick = HTMLInputElement.prototype.click;
  let input = null;
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') { input = this; return; } return origClick.apply(this, arguments); };
  const btn = document.getElementById('ntr-g-pick-file');
  if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  HTMLInputElement.prototype.click = origClick;
  if (!input) return { error: '没有捕获到 file input' };
  const dt = new DataTransfer();
  dt.items.add(new File([content], name, { type }));
  try { input.files = dt.files; } catch (e) { Object.defineProperty(input, 'files', { value: dt.files, configurable: true }); }
  input.dispatchEvent(new Event('change'));
  return { captured: { type: input.type, accept: input.accept } };
};

const runCase = async (label, { file, expectNoLoad, skipWrite }) => {
  const rec = { label };
  const old = document.getElementById('ntr-glossary-overlay');
  if (old) old.remove();
  seen.length = 0;
  captured.length = 0;
  set('术语表', '');
  set('读取剪贴板', false);
  window._NTRToolBox.runModule('导入术语表(KWG)');
  await waitFor(() => !!overlaySnap(), 10000);
  rec.beforePick = overlaySnap();
  rec.pick = pickWithFile(file.name, file.content, file.type);
  await new Promise((r) => setTimeout(r, 800));
  rec.afterPick = overlaySnap();
  rec.notifications = seen.slice();
  if (expectNoLoad) rec.expectNoLoad = expectNoLoad;
  if (rec.afterPick && !skipWrite) {
    rec.clickedWrite = clickText('合并写入');
    await waitFor(() => !document.getElementById('ntr-g-glossary-overlay') && !document.getElementById('ntr-glossary-overlay'), 10000);
  }
  const cap = captured[0];
  rec.put = cap ? { url: cap.url, keys: Object.keys(JSON.parse(cap.body || '{}')) } : null;
  out.cases.push(rec);
};

try {
  // BOM（Windows 记事本存的 UTF-8 文件）——曾经会因为 startsWith('{') 失效而解析不出来
  await runCase('P1 点选：带 BOM 的 JSON 文件', { file: { name: 'bom.json', content: '\uFEFF{"テスト薔":"薔译","テスト薇":"薇译"}' } });
  await runCase('P2 点选：CRLF 的 => 文本文件', { file: { name: 'crlf.txt', content: 'テスト葵 => 葵译\r\nテスト茜 => 茜译\r\n', type: 'text/plain' } });
  await runCase('P3 点选：KWG 默认 output.json（对象数组，含 type/count）', { file: { name: 'output.json', content: JSON.stringify([{ src: 'テスト柊', dst: '柊译', type: '名詞', count: 4 }]) } });
  // 数组里混入非对象项/缺字段项：只保留合法条目
  await runCase('P3b 点选：数组含垃圾项', { file: { name: 'junk.json', content: '[1,"x",{"src":"a"},{"dst":"b"},{"src":"テスト榊","dst":"榊译"}]' } });
  await runCase('P4 点选：坏 JSON', { file: { name: 'broken.json', content: '{ "テスト柾": ' }, expectNoLoad: '应提示 JSON 解析失败', skipWrite: true });
  await runCase('P5 点选：空文件', { file: { name: 'empty.json', content: '' }, expectNoLoad: '应提示解析不到术语', skipWrite: true });
  await runCase('P6 点选：嵌套对象 JSON（值非字符串应被丢弃）', { file: { name: 'nested.json', content: '{"テスト楸":"楸译","nest":{"a":"b"},"num":5}' } });

  // 临时端点必须配模型（新增校验）
  // 注意：模块 run(cfg) 收到的 cfg 就是**模块对象**（getModuleSetting 读 cfg.settings），不是整份配置
  const fakeMod = (endpoint, model, key, useTest = true) => ({
    name: 'AI提取术语表',
    settings: [
      { name: '使用临时端点', value: useTest },
      { name: '临时端点', value: endpoint },
      { name: '临时模型', value: model },
      { name: '临时Key', value: key },
      { name: '翻译器', value: '' },
    ],
  });
  const dev = window._NTRGlossaryDev;
  out.workerCheck = {
    endpointOnly: (await dev.resolveGlossaryWorkers(fakeMod('http://127.0.0.1:8788', '', ''))).length,
    endpointAndModel: (await dev.resolveGlossaryWorkers(fakeMod('http://127.0.0.1:8788', 'mock-glossary-1', ''))).map((w) => ({ model: w.model, key: w.key, endpoint: w.endpoint })),
    endpointAndModelAndKey: (await dev.resolveGlossaryWorkers(fakeMod('http://127.0.0.1:8788', 'mock-glossary-1', 'sk-test'))).map((w) => w.key),
    // 开关没勾时：即使端点/模型都填了也不生效（回落工作区翻译器）
    switchOff: (await dev.resolveGlossaryWorkers(fakeMod('http://127.0.0.1:8788', 'mock-glossary-1', 'sk-test', false))).length,
  };
} catch (e) {
  out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
}

window.fetch = origFetch;
notesObs.disconnect();
return JSON.stringify(out, null, 1);
