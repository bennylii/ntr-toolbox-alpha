// daemon/server.mjs —— 本机控制面（默认 127.0.0.1:7331）
// 给油猴「同步 Daemon」推凭据、给人工看状态/触发任务；带 CORS（Chrome 视 localhost 为安全上下文）。
// /run 为单队列（FIFO 串行）——同一时刻最多一个 runBook，避免并发改写共享配置/抢上游；
// 每次 run 的选项以参数传给管线（不再改写共享 pipeline.options）。
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

export function startServer({ store, pipeline, glossaryPipeline, checkPipeline, scheduler, port = 7331, log = console }) {
  const queue = [];
  let queueSeq = 0;
  let pumping = false;
  const publicItem = (it) => ({
    id: it.id, bookKey: it.bookKey, job: it.job, state: it.state,
    enqueuedAt: it.enqueuedAt, startedAt: it.startedAt || 0, finishedAt: it.finishedAt || 0,
    error: it.error || '', stats: it.stats || null,
  });
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const item = queue.find((q) => q.state === 'queued');
        if (!item) break;
        item.state = 'running';
        item.startedAt = Date.now();
        try {
          const runner = { glossary: glossaryPipeline, check: checkPipeline, translate: pipeline }[item.job];
          if (!runner) throw new Error(`${item.job} 管线未装配`);
          const result = await runner.runBook(item.bookKey, { options: item.options });
          item.state = 'done';
          item.stats = (result && result.stats) || null;
        } catch (e) {
          item.state = 'failed';
          item.error = (e && e.message) || String(e);
          log.log(`[run] ${item.bookKey} 失败: ${item.error}`);
        }
        item.finishedAt = Date.now();
        if (queue.length > 50) queue.splice(0, queue.length - 50);
      }
    } finally {
      pumping = false;
    }
  }

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
          queue: queue.slice(-20).map(publicItem),
          llm: scheduler ? scheduler.stats() : null,
          usage: store.usageTotals(),
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/runs') {
        const id = Number(url.searchParams.get('id') || 0);
        if (id > 0) {
          const item = queue.find((q) => q.id === id);
          send(item ? 200 : 404, item ? { ok: true, run: publicItem(item) } : { ok: false, error: 'run 不存在' });
          return;
        }
        send(200, { ok: true, runs: queue.slice(-20).reverse().map(publicItem) });
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
        if (scheduler && Array.isArray(body.workers)) scheduler.setWorkers(body.workers);   // 热更新，无需重启
        log.log('[auth] 凭据/翻译器配置已更新');
        send(200, { ok: true, workers: Array.isArray(body.workers) ? body.workers.length : undefined });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/run') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body.bookKey) { send(400, { ok: false, error: '缺少 bookKey' }); return; }
        const job = ['glossary', 'check', 'translate'].includes(body.job) ? body.job : 'translate';
        const runner = { glossary: glossaryPipeline, check: checkPipeline, translate: pipeline }[job];
        if (!runner) { send(400, { ok: false, error: `${job} 管线未装配` }); return; }
        const options = { ...(body.options || {}) };
        if (job === 'translate' && body.level) options.level = body.level;
        const item = { id: (queueSeq += 1), bookKey: body.bookKey, job, options, state: 'queued', enqueuedAt: Date.now() };
        queue.push(item);
        pump();
        send(202, { ok: true, accepted: true, queued: true, id: item.id, bookKey: item.bookKey, job });
        return;
      }
      send(404, { ok: false, error: `not found: ${url.pathname}` });
    } catch (e) {
      send(500, { ok: false, error: String((e && e.message) || e) });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      log.log(`[serve] http://127.0.0.1:${port}（/status /runs /progress /proposals /auth /run）`);
      resolve(server);
    });
  });
}
