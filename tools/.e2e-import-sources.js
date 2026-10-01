// 导入来源矩阵：文本框文本 / 文本框 JSON / 剪贴板（桩：正常、空、报错、挂起）
// 跑法：cdp open http://127.0.0.1:8788/novel/mock/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.e2e-import-sources.js
// ⚠️ 目标页必须是**两段路径**（/novel/<provider>/<id>，例如 /novel/mock/mock-src）：/novel/mock-1 只有一段，
//    resolveGlossaryTarget() 会落到"本地卷"分支弹「选择本地卷」，需要目标的用例会卡死在那里
// 说明：写入全部走 fetch 拦截（干跑），不会污染线上术语表；
//       等待用 MutationObserver 而不是轮询 sleep —— 后台标签页的链式 timer 会被 Chrome 节流到 ~1s/次，轮询必超时。
const out = { parser: [], cases: [], errors: [] };
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

const MOD = () => window._NTRToolBox.configuration.modules.find((m) => m.name === '导入术语表(KWG)');
const set = (name, value) => { MOD().settings.find((s) => s.name === name).value = value; };

const realClipboard = navigator.clipboard;
const stubClipboard = (impl) => {
  try {
    Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => impl });
    return true;
  } catch (e) { out.errors.push('stub clipboard failed: ' + e.message); return false; }
};
const restoreClipboard = () => {
  try { Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => realClipboard }); } catch (e) {}
};

const notes = () => {
  const list = [];
  document.querySelectorAll('.ntr-notification-message').forEach((n) => { const t = n.textContent.trim(); if (!list.includes(t)) list.push(t); });
  return list;
};

const runCase = async (label, { text, useClipboard, expectWarn, dropFile, skipWrite, inspectPicker }) => {
  const rec = { label };
  const t0 = Date.now();
  const old = document.getElementById('ntr-glossary-overlay');
  if (old) old.remove();
  set('术语表', text);
  set('读取剪贴板', useClipboard);
  captured.length = 0;
  window._NTRToolBox.runModule('导入术语表(KWG)');

  const gotOverlay = await waitFor(() => {
    const o = document.getElementById('ntr-glossary-overlay');
    return !!(o && o.querySelector('.ntr-g-stats'));
  }, 15000);
  const o = document.getElementById('ntr-glossary-overlay');
  const snap = (el) => el ? {
    title: el.querySelector('.ntr-g-title').textContent,
    stats: el.querySelector('.ntr-g-stats').textContent,
    rows: el.querySelectorAll('tbody tr').length,
    rowData: [...el.querySelectorAll('tbody tr')].slice(0, 5).map((tr) => [...tr.children].map((td) => {
      const input = td.querySelector('input[type=text]');
      return (input ? input.value : td.textContent).trim();
    })),
    hasPicker: !!el.querySelector('#ntr-g-pick-file'),
    hint: (el.querySelector('.ntr-g-warn') || {}).textContent,
  } : null;
  rec.overlay = gotOverlay ? snap(o) : null;
  rec.warned = notes();
  if (expectWarn) rec.expectWarn = expectWarn;

  if (rec.overlay && dropFile) {    const card = document.querySelector('#ntr-glossary-overlay .ntr-g-card');
    const dt = new DataTransfer();
    dt.items.add(new File([dropFile.content], dropFile.name, { type: 'application/json' }));
    card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 700));
    const o2 = document.getElementById('ntr-glossary-overlay');
    rec.afterDrop = snap(o2);
    if (o2) rec.afterDrop.checked = [...o2.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length;
    rec.dropNotifications = notes();
  }

  if (rec.overlay && inspectPicker) {
    // 只验证按钮接线（生成的 input 属性），把 click 打桩掉，避免真的弹出系统文件对话框
    const origClick = HTMLInputElement.prototype.click;
    let made = null;
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file') { made = { type: this.type, accept: this.accept }; return; }
      return origClick.apply(this, arguments);
    };
    const btn = document.getElementById('ntr-g-pick-file');
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    HTMLInputElement.prototype.click = origClick;
    rec.pickerInput = made;
  }

  if (rec.overlay && !skipWrite) {
    rec.clickedWrite = clickText('合并写入');
    await waitFor(() => !document.getElementById('ntr-glossary-overlay'), 15000);
  }
  const cap = captured[0];
  rec.put = cap ? { url: cap.url, keys: Object.keys(JSON.parse(cap.body || '{}')) } : null;
  rec.ms = Date.now() - t0;
  out.cases.push(rec);
};

try {
  // 解析器直测（不碰 DOM）：确认 KWG 默认 output.json（对象数组）被接受且带上 type/count
  const parserProbe = (label, text) => {
    const entries = window._NTRGlossaryDev.parseGlossaryEntries(text);
    out.parser.push({
      label,
      entries: entries.map((e) => ({ src: e.src, dst: e.dst, type: e.type, count: e.count, ctx: (e.context || []).length })),
    });
  };
  parserProbe('KWG output.json（对象数组，含 type/count/context）', JSON.stringify([
    { src: 'テスト龍', dst: '龙译', type: '名詞', count: 9, context: ['前文A'], dst_choices: ['龙译', '竜译'], info_choices: ['龙'] },
    { src: 'テスト虎', dst: '虎译', type: '人名', count: 3 },
  ]));
  parserProbe('数组里混入垃圾项（数字/字符串/缺字段）', '[1,"x",{"src":"a"},{"dst":"b"},{"src":"テスト犬","dst":"犬译"}]');
  parserProbe('扁平 JSON（output_autonovel.json）', '{"テスト猫":"猫译"}');
  parserProbe('CRLF 文本行', 'テスト鳥 => 鸟译\r\nテスト魚 => 鱼译\r\n');
  parserProbe('BOM + 扁平 JSON', '\uFEFF{"テスト虫":"虫译"}');
  parserProbe('嵌套 JSON（值不是字符串 → 空）', '{"a":{"b":"c"}}');
  parserProbe('空文本', '   ');

  await runCase('A 文本框（jp => zh 行）', { text: 'テスト甲 => 甲译', useClipboard: false });
  await runCase('B 文本框（扁平 JSON）', { text: '{\n  "テスト乙": "乙译",\n  "テスト丙": "丙译"\n}', useClipboard: false });
  await runCase('C 文本框（JSON 数组，KWG 默认 output.json 简化版）', { text: '[{"src":"テスト配列","dst":"配列译"}]', useClipboard: false });
  await runCase('C3 文本框（KWG 默认 output.json，带 type/count）', {
    text: JSON.stringify([
      { src: 'テスト龍', dst: '龙译', type: '名詞', count: 9, context: ['前文A'], dst_choices: ['龙译', '竜译'] },
      { src: 'テスト虎', dst: '虎译', type: '人名', count: 3 },
    ]),
    useClipboard: false,
  });
  await runCase('C2 文本框（JSON 带前后空格）', { text: '  { "テスト己" : "己译" }  ', useClipboard: false });
  await runCase('H 空文本 + 空剪贴板 → 仍开弹层并给出选择文件入口', { text: '', useClipboard: false, skipWrite: true, inspectPicker: true });
  await runCase('I 拖入 .json 文件（走同一段解析 → 可直接写入）', { text: '', useClipboard: false, dropFile: { name: 'output_autonovel.json', content: '{"テスト杉":"杉译","テスト桧":"桧译"}' } });
  await runCase('I2 拖入 文本文件（原文 => 译文 行）', { text: '', useClipboard: false, dropFile: { name: 'glossary.txt', content: 'テスト桐 => 桐译' } });
  await runCase('I3 拖入 KWG 默认 output.json（对象数组）', {
    text: '',
    useClipboard: false,
    dropFile: { name: 'output.json', content: JSON.stringify([{ src: 'テスト鮫', dst: '鲨译', type: '名詞', count: 5 }, { src: 'テスト鯨', dst: '鲸译', type: '名詞', count: 2 }]) },
  });

  // 剪贴板：CDP 里没有真实用户手势 + 窗口无焦点，readText 拿不到数据（会永久挂起），只能打桩验证代码路径
  stubClipboard({ readText: async () => '{"テスト丁":"丁译"}', writeText: async () => {} });
  await runCase('D 剪贴板（JSON，应优先于文本框）', { text: 'fallback => 不应被用到', useClipboard: true });

  stubClipboard({ readText: async () => '', writeText: async () => {} });
  await runCase('E 剪贴板为空 → 回退文本框', { text: 'テスト戊 => 戊译', useClipboard: true, expectWarn: '应提示剪贴板为空' });

  stubClipboard({ readText: async () => { throw new Error('denied'); }, writeText: async () => {} });
  await runCase('F 剪贴板报错 → 回退文本框', { text: 'テスト庚 => 庚译', useClipboard: true, expectWarn: '应提示读取失败' });

  stubClipboard({ readText: () => new Promise(() => {}), writeText: async () => {} });
  await runCase('G 剪贴板挂起 → 3s 超时后回退文本框', { text: 'テスト辛 => 辛译', useClipboard: true, expectWarn: '应提示读取失败/超时' });
  restoreClipboard();
} catch (e) {
  out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
}

window.fetch = origFetch;
restoreClipboard();
return JSON.stringify(out, null, 1);
