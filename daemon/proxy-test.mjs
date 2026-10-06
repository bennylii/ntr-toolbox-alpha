// daemon/proxy-test.mjs —— 出网代理单测（纯函数 + 本地回环集成；不需要 mock，不碰外网）
// 用法：node daemon/proxy-test.mjs
// 集成部分在进程内起三个服务：测试代理（绝对形式 + CONNECT）、HTTP 目标、HTTPS 目标（自签证书 fixture）。
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { normalizeProxyConfig, assertProxyConfig, shouldBypass, createProxyFetch, DEFAULT_NO_PROXY } from './proxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cert = fs.readFileSync(path.join(here, 'test-fixtures', 'localhost-cert.pem'));
const key = fs.readFileSync(path.join(here, 'test-fixtures', 'localhost-key.pem'));

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log('  ok  ' + name); } catch (e) { fail += 1; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
};
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ---- 测试服务 ----

function startProxy() {
  const counts = { absolute: 0, connect: 0, auth: '' };
  const server = http.createServer((req, res) => {
    counts.absolute += 1;
    if (req.headers['proxy-authorization']) counts.auth = req.headers['proxy-authorization'];
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); res.end('bad absolute url'); return; }
    const upstream = http.request({
      host: target.hostname,
      port: Number(target.port) || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers: { ...req.headers, host: target.host },
    }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    upstream.on('error', () => { try { res.writeHead(502); res.end('proxy upstream error'); } catch { /* ignore */ } });
    req.pipe(upstream);
  });
  server.on('connect', (req, socket, head) => {
    counts.connect += 1;
    if (req.headers['proxy-authorization']) counts.auth = req.headers['proxy-authorization'];
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port) || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return { server, counts };
}

function startHttpTarget() {
  const hits = { n: 0, lastAuth: '' };
  const server = http.createServer((req, res) => {
    hits.n += 1;
    hits.lastAuth = req.headers.authorization || hits.lastAuth;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/redir') { res.writeHead(302, { location: '/final' }); res.end(); return; }
      if (req.url === '/gzip') {
        const body = zlib.gzipSync(Buffer.from(JSON.stringify({ gz: true }), 'utf8'));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(body);
        return;
      }
      if (req.url === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('late'); }, 5000); return; }
      if (req.url === '/fail') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8'), auth: req.headers.authorization || '' }));
    });
  });
  return { server, hits };
}

function startHttpsTarget() {
  const server = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tls: true, path: req.url }));
  });
  return { server };
}

// ---- 纯函数 ----

console.log('== 代理：配置归一化与校验 ==');
await t('缺省值：未启用 + 回环直连列表', () => {
  const cfg = normalizeProxyConfig(undefined);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.url, '');
  assert.equal(cfg.noProxy, DEFAULT_NO_PROXY);
});
await t('数组形式的 noProxy 归一为逗号串', () => {
  assert.equal(normalizeProxyConfig({ noProxy: ['a', ' b ', ''] }).noProxy, 'a,b');
});
await t('enabled 但地址为空 → 抛错', () => {
  assert.throws(() => assertProxyConfig({ enabled: true, url: '' }), /代理地址为空/);
});
await t('非 http/https 协议 → 抛错（不支持 SOCKS5）', () => {
  assert.throws(() => assertProxyConfig({ url: 'socks5://127.0.0.1:1080' }), /只支持 http/);
});
await t('非法 URL → 抛错', () => {
  assert.throws(() => assertProxyConfig({ url: '127.0.0.1:6789' }), /不是合法 URL/);
});
await t('合法 http 地址通过', () => {
  const cfg = assertProxyConfig({ enabled: true, url: 'http://127.0.0.1:6789' });
  assert.equal(cfg.url, 'http://127.0.0.1:6789');
});
await t('未启用且地址为空 → 不抛（等价于关闭）', () => {
  assert.equal(assertProxyConfig({ enabled: false, url: '' }).enabled, false);
});

console.log('== 代理：直连列表匹配 ==');
await t('精确 host 命中（大小写不敏感）', () => {
  assert.equal(shouldBypass('LocalHost', 'localhost'), true);
  assert.equal(shouldBypass('127.0.0.1', '127.0.0.1,localhost,::1'), true);
});
await t("'*' 全直连", () => assert.equal(shouldBypass('example.com', '*'), true));
await t('裸域名命中其子域，不命中旁系', () => {
  assert.equal(shouldBypass('api.example.com', 'example.com'), true);
  assert.equal(shouldBypass('example.com', 'example.com'), true);
  assert.equal(shouldBypass('notexample.com', 'example.com'), false);
});
await t('前导点写法与裸域名等价（本域 + 子域）', () => {
  assert.equal(shouldBypass('a.example.com', '.example.com'), true);
  assert.equal(shouldBypass('example.com', '.example.com'), true);
});
await t('IPv6 方括号归一', () => assert.equal(shouldBypass('[::1]', '::1'), true));
await t('未命中 → 走代理（false）', () => assert.equal(shouldBypass('n.novelia.cc', '127.0.0.1'), false));

// ---- 集成 ----

console.log('== 代理：本地回环集成（绝对形式 / CONNECT / 直连豁免 / 结构不变） ==');
const proxy = startProxy();
const httpTarget = startHttpTarget();
const httpsTarget = startHttpsTarget();
const proxyPort = await listen(proxy.server);
const httpPort = await listen(httpTarget.server);
const httpsPort = await listen(httpsTarget.server);
const httpUrl = `http://127.0.0.1:${httpPort}`;
const httpsUrl = `https://127.0.0.1:${httpsPort}`;

let proxyCfg = null;   // 每次请求现读：测试里直接改这个变量模拟「保存设置」
const proxied = createProxyFetch({ getProxy: () => proxyCfg, tls: { rejectUnauthorized: false } });

await t('未启用 → 直连（代理计数不变）', async () => {
  proxyCfg = { enabled: false, url: `http://127.0.0.1:${proxyPort}`, noProxy: '' };
  const before = proxy.counts.absolute;
  const res = await proxied(`${httpUrl}/direct`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).path, '/direct');
  assert.equal(proxy.counts.absolute, before);
});
await t('启用 + noProxy 命中回环 → 直连', async () => {
  proxyCfg = { enabled: true, url: `http://127.0.0.1:${proxyPort}`, noProxy: '127.0.0.1' };
  const before = proxy.counts.absolute;
  await proxied(`${httpUrl}/bypass`);
  assert.equal(proxy.counts.absolute, before);
});
await t('启用 + noProxy 为空 → http 目标经代理（绝对形式）', async () => {
  proxyCfg = { enabled: true, url: `http://127.0.0.1:${proxyPort}`, noProxy: '' };
  const before = proxy.counts.absolute;
  const res = await proxied(`${httpUrl}/via-proxy`);
  assert.equal(await res instanceof Response, true);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).path, '/via-proxy');
  assert.equal(proxy.counts.absolute, before + 1);
});
await t('POST 体与头部原样转发；调用方 Authorization 保留', async () => {
  const res = await proxied(`${httpUrl}/echo`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
  const data = await res.json();
  assert.equal(data.method, 'POST');
  assert.equal(data.body, '{"a":1}');
  assert.equal(data.auth, 'Bearer test-token');
});
await t('代理 URL 带 user:pass → 发 Proxy-Authorization', async () => {
  proxyCfg = { enabled: true, url: `http://u:p@127.0.0.1:${proxyPort}`, noProxy: '' };
  await proxied(`${httpUrl}/auth`);
  assert.equal(proxy.counts.auth, 'Basic ' + Buffer.from('u:p').toString('base64'));
  proxyCfg = { enabled: true, url: `http://127.0.0.1:${proxyPort}`, noProxy: '' };
});
await t('https 目标经 CONNECT 隧道（TLS 端到端）', async () => {
  const before = proxy.counts.connect;
  const res = await proxied(`${httpsUrl}/tls`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).tls, true);
  assert.equal(proxy.counts.connect, before + 1);
});
await t('非 2xx 原样返回（不抛）', async () => {
  const res = await proxied(`${httpUrl}/fail`);
  assert.equal(res.status, 500);
  assert.equal(res.ok, false);
  assert.equal(await res.text(), 'boom');
});
await t('重定向跟随（302 → 200 /final）', async () => {
  const res = await proxied(`${httpUrl}/redir`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).path, '/final');
});
await t('gzip 响应自动解码', async () => {
  const res = await proxied(`${httpUrl}/gzip`);
  assert.deepEqual(await res.json(), { gz: true });
});
await t('AbortSignal → AbortError（调度器按 name 识别）', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(proxied(`${httpUrl}/slow`, { signal: controller.signal }), (e) => e && e.name === 'AbortError');
});
await t('配置现读：切回未启用后立即直连（保存即生效）', async () => {
  const before = proxy.counts.absolute;
  proxyCfg = { enabled: false, url: `http://127.0.0.1:${proxyPort}`, noProxy: '' };
  await proxied(`${httpUrl}/re-read`);
  assert.equal(proxy.counts.absolute, before);
});
await t('代理不可达 → TypeError(fetch failed) + cause.code（与 undici 同形）', async () => {
  proxyCfg = { enabled: true, url: 'http://127.0.0.1:1', noProxy: '' };
  await assert.rejects(proxied(`${httpUrl}/dead-proxy`), (e) => e instanceof TypeError && e.message === 'fetch failed' && Boolean(e.cause && e.cause.code));
  proxyCfg = null;
});
await t('http 目标未被误走 CONNECT（协议分流正确）', async () => {
  const connects = proxy.counts.connect;
  proxyCfg = { enabled: true, url: `http://127.0.0.1:${proxyPort}`, noProxy: '' };
  await proxied(`${httpUrl}/no-connect`);
  assert.equal(proxy.counts.connect, connects);
  proxyCfg = null;
});

for (const s of [proxy.server, httpTarget.server, httpsTarget.server]) s.close();

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  proxy-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
