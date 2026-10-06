// tools/.probe-tm-hash-ws.mjs —— 连 TM 扩展 service worker 算已安装脚本正文的 sha256
// （chrome.storage.local 只在扩展上下文可用，页面上下文跑不了；与本地 dev 构建整文件 sha256 比对）
// 用法：node tools/.probe-tm-hash-ws.mjs            # 默认 CDP 9333
//       CDP_PORT=9334 node tools/.probe-tm-hash-ws.mjs
// 比对：node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('ntr-toolbox-alpha.dev.user.js')).digest('hex'))"
const PORT = process.env.CDP_PORT || '9333';
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const sw = list.find((t) => t.type === 'service_worker' && /tampermonkey/i.test(t.url))
  || list.find((t) => t.type === 'service_worker');
if (!sw) {
  console.log('TM service worker 未找到。当前 targets：');
  console.log(list.map((t) => `${t.type}  ${t.url.slice(0, 80)}`).join('\n'));
  process.exit(1);
}
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === mid) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const expr = `(async () => {
  const all = await chrome.storage.local.get(null);
  const out = [];
  for (const [k, entry] of Object.entries(all)) {
    if (!k.startsWith('!extdb.@source#')) continue;
    const stored = entry && entry.value;
    if (typeof stored !== 'string') continue;
    const buf = new TextEncoder().encode(stored);
    const dig = await crypto.subtle.digest('SHA-256', buf);
    const name = (stored.match(/^\\/\\/ @name\\s+(.+)$/m) || [])[1] || '?';
    const ver = (stored.match(/^\\/\\/ @version\\s+(.+)$/m) || [])[1] || '?';
    out.push({ name: name.trim(), version: ver.trim(), sha256: Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, '0')).join('') });
  }
  return JSON.stringify(out);
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(r.result.value);
ws.close();
