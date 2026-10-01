// 探针：审计按钮点一次，onAudit 到底被调用几次（怀疑重复触发）
const UI = window._NTRGlossaryDev.GlossaryUI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { calls: [] };
const origConfirm = window.confirm;
window.confirm = () => { out.confirms = (out.confirms || 0) + 1; return out.confirmAnswer !== false; };
try {
  const entries = [
    { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 3 },
    { src: 'ボブ', dst: '鲍勃', type: '男性人名', count: 10 },
  ];
  UI.open({
    title: '审计重复触发探针',
    target: { kind: 'web', providerId: 'mock', novelId: 'x' },
    entries,
    existing: {},
    mode: 'merge',
    onWrite: async () => { },
    onAudit: async (targets) => {
      out.calls.push({ n: targets.length, at: Date.now(), stack: String(new Error().stack).split('\n').slice(1, 4).join(' | ') });
      return { marks: new Map([['ボブ', { why: '3', note: 'x' }]]), unmatched: 0, batches: 1, failed: '' };
    },
  });
  for (let i = 0; i < 40 && !document.querySelector('#ntr-glossary-overlay thead th'); i++) await sleep(100);
  const ov = document.getElementById('ntr-glossary-overlay');
  const fb = ov.querySelector('#ntr-g-filter-btn');
  if (ov.querySelector('#ntr-g-filter-popover').style.display === 'none') fb.click();
  await sleep(120);
  const auditBtn = ov.querySelector('#ntr-g-audit-btn');
  out.handlers = !!auditBtn.onclick;
  auditBtn.click();
  await sleep(600);
  out.callsAfterOneClick = out.calls.length;
  out.confirms = out.confirms || 0;
  out.note = ov.querySelector('#ntr-g-audit-note').textContent;
  const c = Array.from(ov.querySelectorAll('.ntr-g-btn')).find((b) => b.textContent === '关闭');
  if (c) c.click();
} catch (e) { out.err = String((e && e.stack) || e); }
finally { window.confirm = origConfirm; }
return JSON.stringify(out, null, 1);
