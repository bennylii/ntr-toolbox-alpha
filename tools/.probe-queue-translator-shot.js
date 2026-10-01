// 截图用：队列面板「运行翻译器 ▾」展开 popover 的样子。先 cdp eval "window.__qbShot='closed'|'open'" 再 evalf 本文件，再 cdp shot
//   closed → 关闭态：按钮显示「运行翻译器 ▾」+ 默认跟随
//   open   → 展开态：popover 已弹出，包含"跟随 [...]" + 工作区 worker（测试 profile 一般只有跟随项）
const D = window._NTRGlossaryDev, Q = D.GlossaryQueue;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = window.__qbShot || 'closed';
Q.stop();
for (const j of await Q.list()) await Q.remove(j.id);
localStorage.removeItem('ntr-queue-runtime');
const old = document.getElementById('ntr-queue-overlay');
if (old) old.remove();
await Q.openPanel();
await sleep(400);
if (mode === 'open') {
  // 造一个 pending 任务并把运行时切到 fake-*，让按钮显示「运行翻译器：fake-worker-A」
  await Q.writeQueueRuntime({ workerId: 'fake-worker-A' });
  await sleep(300);
  // 手动打开 popover
  const btn = Array.from(document.querySelectorAll('#ntr-queue-overlay .ntr-g-toolbar button')).find((b) => b.textContent.startsWith('运行翻译器'));
  if (btn) btn.click();
  await sleep(400);
}
const panel = document.getElementById('ntr-queue-overlay');
return JSON.stringify({
  mode,
  toolbarBtn: Array.from(document.querySelectorAll('#ntr-queue-overlay .ntr-g-toolbar button')).find((b) => b.textContent.startsWith('运行翻译器'))?.textContent,
  popover: Array.from(document.querySelectorAll('.ntr-g-popover')).map((p) => ({
    options: Array.from(p.querySelectorAll('select option')).map((o) => ({ v: o.value, t: o.textContent })),
  })),
});