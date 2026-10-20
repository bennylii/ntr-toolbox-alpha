// daemon/curl-fetch.mjs —— curl 子进程传输（代理链路兜底）
//
// 为什么需要：Node/undici 走本机代理访问部分站点（实测 n.novelia.cc 经 Clash 6789）会被
// 稳定 ECONNRESET（TLS 指纹/HTTP 层被拦），同一代理下 curl 成功率约 85%——undici 重试到顶仍
// 失败时，用 curl 子进程把同一个请求重发一次，把「站点功能整片不可用」降级成「偶发慢」。
// 只在传输层失败时触发（HTTP 状态错误是正常响应，不回落）；curl 不存在时保持原错误。
//
// 实现要点：用异步 spawn（**不要 spawnSync**：同步等子进程会阻塞事件循环，daemon 自己的 HTTP
// 服务与同进程内的测试假服务器都会因此收不到请求 → curl 干等到超时）。响应体落临时文件、
// 头落另一份临时文件，stdout 只回状态码，避免大响应塞满管道。
//
// 契约：fetch(url, init) → Response（含 -L 跟随重定向、--retry、--max-time、signal 中止），与 undici 同形。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let available = null;
// curl 是否可用（探测一次并缓存；Windows 10+/macOS/Linux 自带 curl.exe）
export function curlAvailable() {
  if (available !== null) return available;
  try {
    const r = spawnSync('curl', ['--version'], { windowsHide: true, timeout: 5000 });
    available = !r.error && r.status === 0;
  } catch {
    available = false;
  }
  return available;
}

const TMP = path.join(os.tmpdir(), `ntr-curl-${process.pid}`);

// createCurlFetch({ proxy, retries, retryDelay, maxTime }) → fetch(url, init) → Response
// proxy：'http://127.0.0.1:6789'（走代理）或 ''（直连，供 noProxy 命中时用）
export function createCurlFetch({ proxy = '', retries = 3, retryDelay = 2, maxTime = 90 } = {}) {
  let seq = 0;
  return async function curlFetch(url, init = {}) {
    if (!curlAvailable()) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('curl 不可用') });
    fs.mkdirSync(TMP, { recursive: true });
    const id = `${process.pid}-${(seq += 1)}`;
    const hdrFile = path.join(TMP, `h-${id}`);
    const outFile = path.join(TMP, `b-${id}`);
    const timeout = Math.max(1, Number(maxTime) || 90);
    const args = ['-s', '-S', '-L', '-D', hdrFile, '-o', outFile, '-w', '%{http_code}', '--max-time', String(timeout)];
    if (proxy) args.push('-x', proxy);
    if (Number(retries) > 0) {
      args.push('--retry', String(Math.floor(retries)), '--retry-all-errors', '--retry-delay', String(Math.max(0, Number(retryDelay) || 0)),
        '--retry-max-time', String(timeout));
    }
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET') args.push('-X', method);
    const headers = init.headers || {};
    const pairs = typeof headers.forEach === 'function' && typeof headers.get === 'function'
      ? (() => { const out = []; headers.forEach((v, k) => out.push([k, v])); return out; })()
      : Object.entries(headers);
    for (const [k, v] of pairs) if (v !== undefined && v !== null) args.push('-H', `${k}: ${v}`);
    let input = null;
    if (init.body !== undefined && init.body !== null) {
      args.push('--data-binary', '@-');
      input = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8')
        : (Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body));
    }
    args.push(String(url));

    const cleanup = () => { try { fs.unlinkSync(hdrFile); } catch { } try { fs.unlinkSync(outFile); } catch { } };
    const run = await new Promise((resolve) => {
      const child = spawn('curl', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d).slice(0, 400); });
      const onAbort = () => { try { child.kill(); } catch { } };
      if (init.signal) init.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => { resolve({ code: -1, stdout, stderr: e.message }); });
      child.on('close', (code) => {
        if (init.signal) init.signal.removeEventListener('abort', onAbort);
        resolve({ code, stdout, stderr });
      });
      if (input) child.stdin.end(input); else child.stdin.end();
    });

    let status = Number.parseInt(String(run.stdout || '').trim(), 10);
    const outHeaders = new Headers();
    try {
      const raw = fs.readFileSync(hdrFile, 'utf8');
      // 跟随重定向时 -D 会写多段头；取最后一段（最终响应）
      const blocks = raw.split(/\r\n\r\n/).filter((b) => /^HTTP\//.test(b.trim()));
      for (const line of (blocks[blocks.length - 1] || '').split(/\r?\n/).slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) outHeaders.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
    } catch { /* 无头文件：按空头处理 */ }
    let body = Buffer.alloc(0);
    try { body = fs.readFileSync(outFile); } catch { /* 无正文：按空处理 */ }
    cleanup();
    if (run.code !== 0 || !Number.isFinite(status) || status < 100) {
      const detail = String(run.stderr || '').trim().slice(0, 200) || `curl exit ${run.code}`;
      // 与 undici 同形：TypeError('fetch failed') + cause.code（调用方的错误分类/日志不用改）
      const cause = Object.assign(new Error(`curl 传输失败：${detail}`), { code: 'CURL_FAILED', exitCode: run.code });
      throw Object.assign(new TypeError('fetch failed'), { cause });
    }
    return new Response(body.length ? body : null, { status, headers: outHeaders });
  };
}
