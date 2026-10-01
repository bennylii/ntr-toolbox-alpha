// 端到端：本地卷 写入（合并）+ 回滚；带阶段心跳便于外部观察
const volumeId = 'jp.测试卷.测试用.txt';
const out = { stage: 'init', notifications: [], errors: [], timeline: [] };
const t0 = Date.now();
const mark = (label) => { out.stage = label; out.timeline.push(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`); };
window.__e2e = out;
window.addEventListener('unhandledrejection', (e) => out.errors.push('rejection: ' + (e.reason && (e.reason.message || e.reason))));
window.addEventListener('error', (e) => out.errors.push('error: ' + e.message));
window.confirm = () => true;
window.alert = () => { };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (want) => {
  const els = [...document.querySelectorAll('button, .ntr-g-btn, .ntr-g-tab, .ntr-module-header')];
  const el = els.find((e) => e.textContent.trim() === want) || els.find((e) => e.textContent.includes(want));
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
};
const collect = () => {
  [...document.querySelectorAll('.ntr-notification-message')].forEach((n) => {
    const text = n.textContent.trim();
    if (!out.notifications.includes(text)) out.notifications.push(text);
  });
};
const readMeta = async () => {
  out.stage = 'readMeta:start';
  const db = await new Promise((res, rej) => { const r = indexedDB.open('volumes', 2); r.onblocked = () => rej(new Error('idb blocked')); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  out.stage = 'readMeta:opened';
  const meta = await new Promise((res, rej) => { const q = db.transaction('metadata', 'readonly').objectStore('metadata').get(volumeId); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  out.stage = 'readMeta:got';
  return { glossary: Object.keys(meta.glossary || {}).length, glossaryId: meta.glossaryId };
};

try {
  mark('read-before');
  out.before = await readMeta();
  mark('read-before-done');

  document.querySelectorAll('#ntr-glossary-overlay, #ntr-glossary-status').forEach((e) => e.remove());
  mark('run-extract');
  window._NTRToolBox.runModule('AI提取术语表');

  let picked = false;
  for (let i = 0; i < 40 && !picked; i++) {
    await sleep(150);
    const picker = document.getElementById('ntr-glossary-overlay');
    if (picker && picker.innerText.includes('选择本地卷')) picked = clickText('选择');
  }
  mark('picker-clicked:' + picked);

  let mergeUi = null;
  for (let i = 0; i < 200; i++) {
    await sleep(250);
    collect();
    const o = document.getElementById('ntr-glossary-overlay');
    if (o && o.querySelector('.ntr-g-stats')) {
      mergeUi = {
        stats: o.querySelector('.ntr-g-stats').textContent,
        checkboxes: o.querySelectorAll('tbody input[type=checkbox]').length,
        checked: [...o.querySelectorAll('tbody input[type=checkbox]')].filter((c) => c.checked).length,
        warn: o.querySelector('.ntr-g-warn').textContent.trim(),
        hasWriteBtn: !!([...o.querySelectorAll('button')].find((b) => b.textContent.includes('合并写入'))),
      };
      break;
    }
  }
  out.mergeUi = mergeUi;
  mark('overlay-ready');

  out.clickedWrite = clickText('合并写入');
  mark('write-clicked');
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    collect();
    if (!document.getElementById('ntr-glossary-overlay')) break;
  }
  mark('write-finished');
  out.afterWrite = await readMeta();
  out.snapshot = await window._NTRGlossaryDev.GlossaryDB.getAll('snapshots')
    .then((all) => {
      const mine = all.filter((s) => String(s.key || '').startsWith('local:' + volumeId + '#')).sort((a, b) => b.createAt - a.createAt);
      return mine.length ? { latest: Object.keys(mine[0].glossary || {}).length, count: mine.length } : null;
    });
  mark('write-done');

  out.clickedRollback = clickText('回滚术语表');
  let picked2 = false;
  for (let i = 0; i < 40 && !picked2; i++) {
    await sleep(150);
    const picker = document.getElementById('ntr-glossary-overlay');
    if (picker && picker.innerText.includes('选择本地卷')) picked2 = clickText('选择');
  }
  mark('rollback-picker-clicked:' + picked2);
  for (let i = 0; i < 40; i++) { await sleep(200); collect(); }
  out.afterRollback = await readMeta();
  mark('rollback-done');
} catch (e) {
  out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
  mark('fatal');
}
collect();
mark('end');
return JSON.stringify(out, null, 2);
