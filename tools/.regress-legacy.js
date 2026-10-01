const notes = [];
const obs = setInterval(() => {
  document.querySelectorAll('.ntr-notification-message').forEach((n) => {
    const t = n.textContent.trim();
    if (!notes.includes(t)) notes.push(t);
  });
}, 100);
window._NTRToolBox.runModule('填充术语表');
await new Promise((r) => setTimeout(r, 1500));
clearInterval(obs);
return JSON.stringify({ notes });
