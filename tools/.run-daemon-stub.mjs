// tools/.run-daemon-stub.mjs —— 「同步 Daemon」e2e 用的 /auth 接收 stub（端口 7343）
// 跑法：node tools/.run-daemon-stub.mjs （另开一个终端，与 e2e 同时运行）
import http from 'node:http';

let last = {};
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method === 'POST' && req.url === '/auth') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { last = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { last = {}; }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method === 'GET' && req.url === '/last') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(last));
    return;
  }
  res.writeHead(404, cors);
  res.end();
}).listen(7343, '127.0.0.1', () => console.log('[stub] listening http://127.0.0.1:7343'));
