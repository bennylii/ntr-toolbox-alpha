// daemon/proxy.mjs —— 出网代理（HTTP 绝对形式转发 + HTTPS CONNECT 隧道）
//
// 为什么自研而不用 Node 的 NODE_USE_ENV_PROXY：内置开关只在进程启动前解析环境变量、首值终身缓存，
// 无法做到「控制台保存即生效」；本模块挂在既有 fetchImpl 收口处，每次请求现读配置。
// 支持 http/https 代理（可带 user:pass@ 凭据）；不支持 SOCKS5 / PAC / 系统代理。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

export const DEFAULT_NO_PROXY = '127.0.0.1,localhost,::1';
const MAX_REDIRECTS = 5;

// ---- 配置 ----

// 归一化（缺省回填，不校验）；存储与接口回显都用这个形状
export function normalizeProxyConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const noProxy = Array.isArray(cfg.noProxy) ? cfg.noProxy.join(',') : String(cfg.noProxy ?? DEFAULT_NO_PROXY);
  return {
    enabled: cfg.enabled === true,
    url: String(cfg.url || '').trim(),
    noProxy: noProxy.split(',').map((s) => s.trim()).filter(Boolean).join(','),
  };
}

// 校验（保存与探测前调用；非法即抛，消息可直接回给控制台）
export function assertProxyConfig(raw) {
  const cfg = normalizeProxyConfig(raw);
  if (cfg.noProxy.length > 512) throw new Error('直连列表过长（上限 512 字符）');
  if (!cfg.url) {
    if (cfg.enabled) throw new Error('已启用代理但代理地址为空');
    return cfg;
  }
  let u;
  try { u = new URL(cfg.url); } catch { throw new Error('代理地址不是合法 URL（例：http://127.0.0.1:6789）'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('代理地址只支持 http:// 或 https://（不支持 SOCKS5）');
  if (!u.hostname) throw new Error('代理地址缺少主机名');
  return cfg;
}

// ---- 直连列表 ----

// noProxy 匹配：'*' 全直连；精确 host；域名命中本域与其子域（前导点忽略）；IP 只精确匹配
export function shouldBypass(hostname, noProxy) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const list = Array.isArray(noProxy) ? noProxy : String(noProxy ?? '').split(',');
  for (const entry of list) {
    const pat = String(entry || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!pat) continue;
    if (pat === '*') return true;
    const bare = pat.startsWith('.') ? pat.slice(1) : pat;
    if (host === bare || host.endsWith('.' + bare)) return true;
  }
  return false;
}

// ---- fetch 注入 ----

// createProxyFetch({ getProxy }) → fetch(url, init) 兼容函数
// getProxy 每次请求现读（返回存储里的原始配置），保存后立即生效；tls 仅供测试（自签证书）。
export function createProxyFetch({ getProxy, base, tls: tlsOverrides = null } = {}) {
  const baseFetch = base || ((...args) => globalThis.fetch(...args));
  return async function proxyFetch(url, init = {}, redirectsLeft = MAX_REDIRECTS) {
    const proxy = pickProxy(getProxy);
    let target;
    try { target = new URL(String(url)); } catch { return baseFetch(url, init); }
    if (!proxy || (target.protocol !== 'http:' && target.protocol !== 'https:')) return baseFetch(url, init);
    if (shouldBypass(target.hostname, proxy.noProxy)) return baseFetch(url, init);

    const res = await requestViaProxy(proxy, target, init, tlsOverrides);
    const location = res.headers.get('location');
    const follow = init.redirect === undefined || init.redirect === 'follow';
    if (follow && location && [301, 302, 303, 307, 308].includes(res.status) && redirectsLeft > 0) {
      const next = new URL(location, target);
      const method = (res.status === 303 || ((res.status === 301 || res.status === 302) && String(init.method || 'GET').toUpperCase() === 'POST'))
        ? 'GET' : String(init.method || 'GET').toUpperCase();
      const headers = normalizeHeaders(init.headers);
      const nextInit = { ...init, method, headers, redirect: 'follow' };
      if (method === 'GET') { delete nextInit.body; delete headers['content-type']; }
      return proxyFetch(next.href, nextInit, redirectsLeft - 1);
    }
    return res;
  };
}

// 解析出可用代理（未启用/无地址 → null）
function pickProxy(getProxy) {
  let raw;
  try { raw = typeof getProxy === 'function' ? getProxy() : getProxy; } catch { return null; }
  const cfg = normalizeProxyConfig(raw);
  if (!cfg.enabled || !cfg.url) return null;
  let u;
  try { u = new URL(cfg.url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const auth = u.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')
    : '';
  return { protocol: u.protocol, host: u.hostname, port, auth, noProxy: cfg.noProxy };
}

// ---- 请求执行 ----

async function requestViaProxy(proxy, target, init, tlsOverrides) {
  const method = String(init.method || 'GET').toUpperCase();
  const headers = normalizeHeaders(init.headers);
  const body = bodyToBuffer(init.body);
  if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
  const signal = init.signal;

  const throwIfAborted = () => { if (signal && signal.aborted) throw abortError(); };
  throwIfAborted();

  let raw;
  if (target.protocol === 'http:') {
    raw = await plainRequestThroughProxy(proxy, target, method, headers, body, signal);
  } else {
    raw = await httpsRequestThroughProxy(proxy, target, method, headers, body, signal, tlsOverrides);
  }

  const payload = decodeBody(raw.body, raw.headers);
  const responseHeaders = new Headers();
  raw.rawHeaders.forEach((value, i) => { if (i % 2 === 1) responseHeaders.append(raw.rawHeaders[i - 1], value); });
  const bodyless = method === 'HEAD' || raw.status === 204 || raw.status === 205 || raw.status === 304;
  return new Response(bodyless ? null : payload, { status: raw.status, statusText: raw.statusText || '', headers: responseHeaders });
}

// http 目标：把绝对形式 URL 直接发给代理（http://host:port/path）
function plainRequestThroughProxy(proxy, target, method, headers, body, signal) {
  return sendRequest(http.request, {
    protocol: proxy.protocol === 'https:' ? 'https:' : 'http:',
    host: proxy.host,
    port: proxy.port,
    method,
    path: target.href,
    headers: proxy.auth ? { ...headers, 'proxy-authorization': proxy.auth } : headers,
  }, body, signal, proxy);
}

// https 目标：先 CONNECT 隧道，再在隧道上做 TLS 与 HTTP
async function httpsRequestThroughProxy(proxy, target, method, headers, body, signal, tlsOverrides) {
  const socket = await connectTunnel(proxy, target, signal, tlsOverrides);
  try {
    return await sendRequest(https.request, {
      host: target.hostname,
      port: Number(target.port) || 443,
      method,
      path: target.pathname + target.search,
      headers,
      createConnection: () => socket,   // 隧道已就绪：直接把 TLS socket 交给 http 层，不再二次握手
    }, body, signal, proxy, tlsOverrides);
  } catch (e) {
    socket.destroy();
    throw e;
  }
}

function connectTunnel(proxy, target, signal, tlsOverrides) {
  return new Promise((resolve, reject) => {
    const port = Number(target.port) || 443;
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: proxy.auth ? { 'proxy-authorization': proxy.auth, host: `${target.hostname}:${port}` } : { host: `${target.hostname}:${port}` },
      ...(proxy.protocol === 'https:' ? { protocol: 'https:' } : {}),
    });
    const onAbort = () => { req.destroy(); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        cleanup();
        socket.destroy();
        reject(fetchFailed(new Error(`代理 CONNECT 失败 HTTP ${res.statusCode}`)));
        return;
      }
      // IP 字面量不设 SNI（RFC 6066 不允许，Node 会弃用告警）
      const sni = net.isIP(target.hostname) === 0 ? { servername: target.hostname } : {};
      const tlsSocket = tls.connect({ socket, ...sni, ...(tlsOverrides || {}) }, () => {
        cleanup();
        resolve(tlsSocket);
      });
      tlsSocket.once('error', (e) => { cleanup(); reject(fetchFailed(e)); });
    });
    req.once('error', (e) => { cleanup(); reject(fetchFailed(e)); });
    req.end();
  });
}

function sendRequest(requestFn, options, body, signal, proxy, tlsOverrides) {
  return new Promise((resolve, reject) => {
    const req = requestFn({ ...options, ...(tlsOverrides && requestFn === https.request ? { rejectUnauthorized: tlsOverrides.rejectUnauthorized } : {}) });
    const onAbort = () => { req.destroy(); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    req.once('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.once('end', () => {
        cleanup();
        resolve({ status: res.statusCode, statusText: res.statusMessage, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) });
      });
      res.once('error', (e) => { cleanup(); reject(fetchFailed(e)); });
    });
    req.once('error', (e) => { cleanup(); reject(fetchFailed(e)); });
    if (body) req.write(body);
    req.end();
  });
}

// ---- 工具 ----

// 响应体解压（多数上游返回 identity；上游若压缩则按 content-encoding 解）
function decodeBody(buf, headers) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
  } catch { /* 解压失败按原样返回，交给调用方报错 */ }
  return buf;
}

function normalizeHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    h.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [key, value] of h) if (value !== undefined && value !== null) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(h)) if (value !== undefined && value !== null) out[String(key).toLowerCase()] = String(value);
  return out;
}

function bodyToBuffer(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  throw new TypeError('proxy fetch 只支持字符串 / Buffer / TypedArray 请求体');
}

function abortError() {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

// 与 undici 同形：TypeError('fetch failed') + cause 带 code/address/port（调用方的错误分类与日志不变）
function fetchFailed(cause) {
  const e = new TypeError('fetch failed');
  e.cause = cause;
  return e;
}
