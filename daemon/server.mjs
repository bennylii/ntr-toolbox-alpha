// daemon/server.mjs —— 本机控制面（默认 127.0.0.1:7331）
// 给油猴「同步 Daemon」推凭据、给人工看状态/触发翻译；带 CORS（Chrome 视 localhost 为安全上下文）。
import http from 'node:http';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '600',
  // HTTPS 站点页面访问本机 daemon 走 Chrome 本地网络访问（LNA/PNA）预检：应答同意头，
  // 否则真实站点（https）里 fetch http://127.0.0.1 直接失败（http 页面的 mock 车道不受影响）。
  'Access-Control-Allow-Private-Network': 'true',
};

export function startServer({ store, pipeline, glossaryPipeline, port = 7331, log = console }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (code, obj) => { res.writeHead(code, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        const books = store.listBooks().map((b) => ({
          ...b,
          progress: store.listProgress(b.key).length,
        }));
        send(200, {
          ok: true,
          books,
          runs: store.listRuns(10),
          metrics: store.metricsSummary().slice(-6),
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/progress') {
        send(200, { ok: true, progress: store.listProgress(url.searchParams.get('book') || '') });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/proposals') {
        send(200, { ok: true, proposals: store.listProposals(url.searchParams.get('book')) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/auth') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (body.token) store.setConfig('token', body.token);
        if (Array.isArray(body.workers)) store.setConfig('workers', body.workers);
        if (body.origin) store.setConfig('origin', body.origin);
        log.log('[auth] 凭据/翻译器配置已更新');
        send(200, { ok: true, workers: Array.isArray(body.workers) ? body.workers.length : undefined });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/run') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body.bookKey) { send(400, { ok: false, error: '缺少 bookKey' }); return; }
        const job = body.job === 'glossary' ? 'glossary' : 'translate';
        if (job === 'glossary') {
          if (!glossaryPipeline) { send(400, { ok: false, error: '术语管线未装配' }); return; }
          glossaryPipeline.runBook(body.bookKey).catch((e) => log.log(`[run] ${body.bookKey} 失败: ${(e && e.message) || e}`));
        } else {
          if (body.level) pipeline.options.level = body.level;
          pipeline.runBook(body.bookKey).catch((e) => log.log(`[run] ${body.bookKey} 失败: ${(e && e.message) || e}`));
        }
        send(202, { ok: true, accepted: true, bookKey: body.bookKey, job });
        return;
      }
      send(404, { ok: false, error: `not found: ${url.pathname}` });
    } catch (e) {
      send(500, { ok: false, error: String((e && e.message) || e) });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      log.log(`[serve] http://127.0.0.1:${port}（/status /progress /auth /run）`);
      resolve(server);
    });
  });
}
