// 打开「AI提取术语表」设置面板，读当前设置（顺便可选地改 行数上限）
const out = {};
try {
  const header = Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('AI提取术语表'));
  const container = header.closest('.ntr-module-container');
  if (!container.querySelector('.ntr-settings-container')) {
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await new Promise((r) => setTimeout(r, 500));
  }
  const read = () => Array.from(container.querySelectorAll('input,select')).map((el) => {
    const row = el.closest('div');
    const label = row && row.querySelector('label');
    return { label: label ? label.textContent.trim().replace(/:$/, '') : el.dataset.settingName || '', value: el.value, disabled: el.disabled };
  });
  out.settings = read();

  const target = Number(window.__setMaxLines || 0);
  if (target > 0) {
    const el = Array.from(container.querySelectorAll('input')).find((i) => {
      const label = i.closest('div') && i.closest('div').querySelector('label');
      return label && /行数上限/.test(label.textContent);
    });
    if (el) { el.value = String(target); el.dispatchEvent(new Event('change', { bubbles: true })); out.setMaxLines = el.value; }
    else out.setMaxLines = 'not found';
  }
  // 关掉设置面板
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  await new Promise((r) => setTimeout(r, 200));
  out.settingsClosed = !container.querySelector('.ntr-settings-container');
  out.workers = (() => {
    try {
      const read = (k) => { const raw = localStorage.getItem(k); return raw ? (JSON.parse(raw).workers || []) : []; };
      return [...read('workspace-gpt-pipeline'), ...read('workspace-gpt')].map((w) => ({ id: w.id, model: w.model, endpoint: (w.endpoint || '').slice(0, 40) }));
    } catch (e) { return String(e); }
  })();
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);
