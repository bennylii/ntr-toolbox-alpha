// daemon/workspace-bootstrap.mjs —— 工作区子进程引导（workspace_run 沙箱）
// 由父进程以 --import 预载：阻塞等待 "start" IPC → 定义不可配置的全局 ws → 再放行主脚本。
// 契约：父进程消息 {type:'start'} / {type:'response', id, result:{ok,value}|{ok,message}}；
//       子进程消息 {type:'request', id, request}。请求期间 ref 通道，空闲 unref（脚本自然退出）。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pending = new Map();
let seq = 0;

const waitStart = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('工作区启动超时（未收到 start）')), 15000);
  process.on('message', (msg) => {
    if (msg && msg.type === 'start') { clearTimeout(timer); resolve(); }
    else if (msg && msg.type === 'response') {
      const fn = pending.get(msg.id);
      if (fn) { pending.delete(msg.id); fn(msg.result); }
    }
  });
  process.once('disconnect', () => { clearTimeout(timer); process.exit(1); });
});

const call = (request, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('ws 请求超时：' + String(request && request.kind))); }, timeoutMs);
  pending.set(id, (result) => {
    clearTimeout(timer);
    if (process.channel) process.channel.unref();
    if (result && result.ok) resolve(result.value);
    else reject(new Error((result && result.message) || 'ws 请求失败'));
  });
  if (process.channel) process.channel.ref();
  process.send({ type: 'request', id, request });
});

await waitStart;

let contract = {};
try {
  contract = JSON.parse(readFileSync(path.join(process.cwd(), 'contract.json'), 'utf8'));
} catch (e) {
  contract = { error: 'contract.json 不可读：' + String((e && e.message) || e) };
}

const doing = (text) => call({ kind: 'doing', text: String(text == null ? '' : text) });
const read = (request) => call({ kind: 'read', ...(request || {}) });

Object.defineProperty(globalThis, 'ws', {
  value: Object.freeze({ contract, doing, read }),
  configurable: false,
  writable: false,
});

if (process.channel) process.channel.unref();
