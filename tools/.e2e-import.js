// 端到端：本地卷 导入 diff（新增/相同/冲突/仅已有）+ 冲突策略 + 写入 + 回滚（选版本 → diff 预览 → 回滚到此版本）
// 跑法：在 /favorite/local 页，先 evalf tools/.mk-volume.js 造卷，再 evalf 本文件
// 说明：等待用 MutationObserver（后台标签的链式 timer 会被节流到 ~1s/次，sleep 轮询会假死超时）；
//       通知只活 1s，也用 observer 抓。写入只落本地卷 IDB（测试 profile），服务端术语表不动。
const volumeId = 'jp.测试卷.测试用.txt';
const out = { stage: 'init', notifications: [], errors: [] };
const mark = (l) => { out.stage = l; };
window.__e2e = out;
window.confirm = () => true;
window.alert = () => { };

const drainNotes = () => {
  document.querySelectorAll('.ntr-notification-message').forEach((n) => {
    const text = n.textContent.trim();
    if (!out.notifications.includes(text)) out.notifications.push(text);
  });
};
const notesObs = new MutationObserver(drainNotes);
notesObs.observe(document.body, { childList: true, subtree: true });

const waitFor = (predicate, timeoutMs) => new Promise((resolve) => {
  if (predicate()) return resolve(true);
  const obs = new MutationObserver(() => { if (predicate()) { obs.disconnect(); resolve(true); } });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { obs.disconnect(); resolve(!!predicate()); }, timeoutMs);
});

const clickText = (want) => {
  const els = [...document.querySelectorAll('button, .ntr-g-btn, .ntr-g-tab, .ntr-module-header')];
  const el = els.find((e) => e.textContent.trim() === want) || els.find((e) => e.textContent.includes(want));
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
};
const overlay = () => document.getElementById('ntr-glossary-overlay');
const overlayText = () => { const o = overlay(); return o ? o.innerText : ''; };
// 必须限定在弹层里找按钮：本地卷书架页自己就有一个「选择」按钮（n-button），全局找会点错元素
const clickInOverlay = (want) => {
  const o = overlay();
  if (!o) return false;
  const els = [...o.querySelectorAll('button, .ntr-g-btn, .ntr-g-tab')];
  const el = els.find((e) => e.textContent.trim() === want) || els.find((e) => e.textContent.includes(want));
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
};

const idbPut = async (store, value) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('volumes', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(value);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
};
const readMeta = async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('volumes', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return await new Promise((res, rej) => { const q = db.transaction('metadata', 'readonly').objectStore('metadata').get(volumeId); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
};
const setImportText = (text) => {
  const mod = window._NTRToolBox.configuration.modules.find((m) => m.name === '导入术语表(KWG)');
  mod.settings.find((s) => s.name === '术语表').value = text;
  mod.settings.find((s) => s.name === '读取剪贴板').value = false;
};

try {
  // 清掉上次跑残留的弹层（同一个 id 可能堆了多个），再开始
  document.querySelectorAll('#ntr-glossary-overlay').forEach((e) => e.remove());

  // 现有术语表：3 条
  mark('seed-glossary');
  const meta = await readMeta();
  if (!meta) throw new Error('测试卷不存在，请先 evalf tools/.mk-volume.js');
  meta.glossary = { 'アリス': '爱丽丝', 'ローズ': '罗丝', 'レナリス': '蕾娜莉丝' };
  meta.glossaryId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  await idbPut('metadata', meta);
  out.seeded = { count: Object.keys(meta.glossary).length, glossaryId: meta.glossaryId };

  // 导入：アリス 相同、ローズ 冲突、エリクシル 新增；レナリス 等仅已有
  setImportText('アリス => 爱丽丝\nローズ => 蔷薇\nエリクシル => 万灵药');
  mark('run-import');
  window._NTRToolBox.runModule('导入术语表(KWG)');

  out.volumePicker = await waitFor(() => overlayText().includes('选择本地卷'), 15000);
  out.volumePicked = clickInOverlay('选择');
  const diffReady = await waitFor(() => !!document.querySelector('#ntr-glossary-overlay .ntr-g-stats'), 15000);
  drainNotes();
  const o = overlay();
  out.diffBefore = diffReady && o ? {
    stats: o.querySelector('.ntr-g-stats').textContent.trim(),
    rows: [...o.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.innerText.trim()).join(' | ')),
    checked: [...o.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length,
    checkboxes: o.querySelectorAll('tbody input[type=checkbox]').length,
    warn: o.querySelector('.ntr-g-warn').textContent.trim(),
  } : null;
  mark('diff-ready');

  // 切到「采用新提取」并勾选冲突行
  out.clickedPolicy = clickInOverlay('冲突：保留现有');
  const policyBtn = overlay() ? [...overlay().querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('冲突')) : '';
  out.policyLabelAfter = policyBtn;
  const policyOverlay = overlay();
  out.afterPolicy = policyOverlay ? {
    stats: policyOverlay.querySelector('.ntr-g-stats').textContent.trim(),
    checked: [...policyOverlay.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length,
    warn: policyOverlay.querySelector('.ntr-g-warn').textContent.trim(),
  } : null;
  mark('policy-clicked');

  out.clickedWrite = clickInOverlay('合并写入');
  await waitFor(() => !overlay(), 20000);
  drainNotes();
  const after = await readMeta();
  out.afterWrite = { count: Object.keys(after.glossary || {}).length, glossary: after.glossary, glossaryIdChanged: after.glossaryId !== meta.glossaryId };
  const versionsAfterWrite = await window._NTRGlossaryDev.GlossaryTargets.listSnapshots({ kind: 'local', volumeId });
  out.versionsAfterWrite = versionsAfterWrite.map((v) => v.note);
  mark('write-done');

  // 回滚：选本地卷 → 选版本 → diff 预览 → 回滚到此版本
  // 用 runModule 而不是点面板：面板点击入口有 domainAllowed 域名闸门（离线 mock 测试页会被拦掉）
  window._NTRToolBox.runModule('回滚术语表');
  const volPicked = await waitFor(() => overlayText().includes('选择本地卷'), 15000);
  out.rollbackVolumePicker = volPicked;
  out.rollbackVolumePicked = clickInOverlay('选择');

  const versionPicked = await waitFor(() => !!overlay() && overlayText().includes('回滚术语表') && !overlay().querySelector('table'), 15000);
  if (versionPicked) {
    out.rollbackVersionList = [...overlay().querySelectorAll('.ntr-g-body > div')].map((d) => d.innerText.replace(/\s+/g, ' ').trim());
    out.rollbackVersionPicked = clickInOverlay('选择');
  }
  mark('rollback-version-picked:' + versionPicked);

  const previewOk = await waitFor(() => !!(overlay() && overlay().querySelector('#ntr-g-restore')), 15000);
  if (previewOk) {
    const p = overlay();
    out.rollbackPreview = {
      title: p.querySelector('.ntr-g-title').textContent.trim(),
      stats: p.querySelector('.ntr-g-stats').textContent.trim(),
      warn: p.querySelector('.ntr-g-warn').textContent.trim(),
      rows: [...p.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.innerText.trim()).join(' | ')),
      tabs: [...p.querySelectorAll('.ntr-g-tab')].map((t) => t.textContent.trim()),
    };
    out.clickedRestore = clickInOverlay('回滚到此版本');
  }
  await waitFor(() => !overlay(), 20000);
  drainNotes();
  const rolled = await readMeta();
  out.afterRollback = { count: Object.keys(rolled.glossary || {}).length, glossary: rolled.glossary };
  const versionsAfter = await window._NTRGlossaryDev.GlossaryTargets.listSnapshots({ kind: 'local', volumeId });
  out.versionsAfterRollback = versionsAfter.map((v) => ({ note: v.note, glossary: v.glossary }));
  mark('rollback-done');
} catch (e) {
  out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
}

drainNotes();
notesObs.disconnect();
mark('end');
return JSON.stringify(out, null, 2);
