// 检查「术语队列」设置面板里出现 并发/RPM/逾时 三项覆盖（0=跟随），且是可编辑的 number 输入
const out = {};
const header = [...document.querySelectorAll('#ntr-panel .ntr-module-header')].find((h) => h.textContent.includes('术语队列'));
const sd = header.parentElement.querySelector('.ntr-settings-container');
if (sd.style.display === 'none') {
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));
  await new Promise((r) => setTimeout(r, 200));
}
const rows = [...sd.querySelectorAll('label')].map((l) => {
  const row = l.parentElement;
  const input = row.querySelector('input');
  return { name: l.textContent.trim().replace(/:\s*$/, ''), type: input ? input.type : null, value: input ? input.value : null, disabled: input ? input.disabled : null };
});
out.rows = rows;
out.hasNew = ['并发(0=跟随)', 'RPM(0=跟随)', '逾时(秒,0=跟随)'].every((n) => rows.some((r) => r.name === n && r.type === 'number' && r.value === '0' && r.disabled === false));
return JSON.stringify(out, null, 1);
