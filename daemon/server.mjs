// daemon/server.mjs —— 本机控制面（默认 127.0.0.1:7331）+ 设置控制台页面（/ui）
// 给油猴「同步 Daemon」推凭据；给浏览器看状态/改设置/派任务。
// 安全：跨域仅放行 站点域名 与 本机；非白名单 Origin 的写请求/预检一律 403（页面自身同源访问不受影响）。
// /run 为单队列（FIFO 串行）——同一时刻最多一个 runBook；每次 run 的选项按次传入，不改共享配置。
import http from 'node:http';
import { parseBookUrl } from './book-url.mjs';
import { PROMPT_SLOTS, DEFAULT_TEMPLATE, FORMAT_RULES } from './prompt.mjs';
import { UI_HTML } from './ui.mjs';

const CORS_BASE = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '600',
  // HTTPS 站点页面访问本机 daemon 走 Chrome 本地网络访问（LNA/PNA）预检：应答同意头
  'Access-Control-Allow-Private-Network': 'true',
};

const originAllowed = (origin) => {
  if (!origin) return true;   // curl/Node 直连（无 Origin）
  try {
    const u = new URL(origin);
    if (u.hostname === 'n.novelia.cc') return true;
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && (u.protocol === 'http:' || u.protocol === 'https:')) return true;
    return false;
  } catch { return false; }
};

const maskKey = (key) => {
  const s = String(key || '');
  if (s === '') return '';
  return s.length <= 8 ? s.slice(0, 2) + '…' : s.slice(0, 4) + '…' + s.slice(-2);
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

  const llmConfig = () => store.getConfig('llm') || {};
  const schedulerOptionsFrom = (llm) => ({
    ...(llm.maxInFlight !== undefined ? { maxInFlight: Math.max(1, Number(llm.maxInFlight) || 1) } : {}),
    ...(llm.rpm !== undefined ? { rpm: Math.max(0, Number(llm.rpm) || 0) } : {}),
    ...(llm.transportRetries !== undefined ? { transportRetries: Math.max(0, Number(llm.transportRetries) || 0) } : {}),
    ...(llm.maxPromptChars !== undefined ? { maxPromptChars: Math.max(1000, Number(llm.maxPromptChars) || 12000) } : {}),
    ...(llm.strictPrompt !== undefined ? { strictPrompt: llm.strictPrompt === true } : {}),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const origin = req.headers.origin;
    const allowed = originAllowed(origin);
    const cors = { ...CORS_BASE, ...(allowed && origin ? { 'Access-Control-Allow-Origin': origin } : (allowed ? { 'Access-Control-Allow-Origin': '*' } : {})) };
    const send = (code, obj) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };
    const html = (code, text) => { res.writeHead(code, { ...cors, 'content-type': 'text/html; charset=utf-8' }); res.end(text); };

    if (!allowed) {
      if (req.method === 'OPTIONS' || req.method === 'POST') { send(403, { ok: false, error: `Origin 不在白名单：${origin}` }); return; }
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    const readBody = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('请求体不是合法 JSON'); }
    };

    try {
      if (req.method === 'GET' && (url.pathname === '/ui' || url.pathname === '/')) {
        html(200, UI_HTML);
        return;
      }
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
      if (req.method === 'GET' && url.pathname === '/settings') {
        const workers = store.getConfig('workers') || [];
        send(200, {
          ok: true,
          settings: {
            llm: llmConfig(),
            origin: store.getConfig('origin') || 'https://n.novelia.cc',
            tokenSet: Boolean(store.getConfig('token')),
            workers: workers.map((w, i) => ({ id: w.id || `w${i}`, model: w.model || '', endpoint: w.endpoint || '', key: maskKey(w.key) })),
          },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/settings') {
        const body = await readBody();
        if (body.llm && typeof body.llm === 'object') {
          const merged = { ...llmConfig(), ...body.llm };
          store.setConfig('llm', merged);
          if (scheduler) scheduler.setOptions(schedulerOptionsFrom(merged));
        }
        if (typeof body.origin === 'string' && body.origin.trim() !== '') store.setConfig('origin', body.origin.trim());
        log.log('[settings] 设置已更新');
        send(200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/rules') {
        send(200, { ok: true, rules: store.listRules(url.searchParams.get('book') || '') });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/rules') {
        const body = await readBody();
        if (body.action === 'add') {
          if (!body.kind || !body.pattern) { send(400, { ok: false, error: '缺少 kind/pattern' }); return; }
          if (!['text_preserve', 'pre_replacement', 'post_replacement'].includes(body.kind)) { send(400, { ok: false, error: 'kind 不合法' }); return; }
          const id = store.addRule({
            bookKey: String(body.bookKey || ''),
            kind: body.kind,
            pattern: String(body.pattern),
            replacement: body.replacement === undefined ? '' : String(body.replacement),
            regex: body.regex ? 1 : 0,
            case_sensitive: body.case_sensitive ? 1 : 0,
            enabled: body.enabled === false ? 0 : 1,
            priority: Number(body.priority) || 100,
          });
          send(200, { ok: true, id });
          return;
        }
        if (body.action === 'toggle') { store.setRuleEnabled(Number(body.id), body.enabled !== false); send(200, { ok: true }); return; }
        if (body.action === 'delete') { store.deleteRule(Number(body.id)); send(200, { ok: true }); return; }
        send(400, { ok: false, error: '未知 action' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/prompts') {
        const book = url.searchParams.get('book') || '';
        send(200, { ok: true, rows: store.listPrompts(book), defaults: DEFAULT_TEMPLATE, formatRules: FORMAT_RULES, slots: PROMPT_SLOTS });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/prompts') {
        const body = await readBody();
        const book = String(body.bookKey || '');
        if (body.action === 'clear') {
          if (!PROMPT_SLOTS.includes(body.slot)) { send(400, { ok: false, error: 'slot 不合法' }); return; }
          store.clearPrompt(book, body.slot);
          send(200, { ok: true });
          return;
        }
        if (body.action === 'clear-all') {
          for (const slot of PROMPT_SLOTS) store.clearPrompt(book, slot);
          send(200, { ok: true });
          return;
        }
        if (!PROMPT_SLOTS.includes(body.slot)) { send(400, { ok: false, error: 'slot 不合法' }); return; }
        store.setPrompt(book, body.slot, String(body.text == null ? '' : body.text));
        send(200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/books') {
        const body = await readBody();
        if (body.action === 'add') {
          const raw = String(body.url || '').trim();
          const info = parseBookUrl(raw);
          const origin = (() => { try { return new URL(raw).origin; } catch { return undefined; } })();
          store.upsertBook({ ...info, origin, title: '' });
          log.log(`[books] 已登记 ${info.key}`);
          send(200, { ok: true, key: info.key });
          return;
        }
        if (body.action === 'forget') {
          store.forgetBook(String(body.key || ''));
          log.log(`[books] 已忘记 ${body.key}`);
          send(200, { ok: true });
          return;
        }
        send(400, { ok: false, error: '未知 action' });
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
        const body = await readBody();
        if (body.token) store.setConfig('token', body.token);
        if (Array.isArray(body.workers)) store.setConfig('workers', body.workers);
        if (body.origin) store.setConfig('origin', body.origin);
        if (scheduler && Array.isArray(body.workers)) scheduler.setWorkers(body.workers);   // 热更新，无需重启
        log.log('[auth] 凭据/翻译器配置已更新');
        send(200, { ok: true, workers: Array.isArray(body.workers) ? body.workers.length : undefined });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/run') {
        const body = await readBody();
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
      log.log(`[serve] http://127.0.0.1:${port}（控制台 /ui；API /status /runs /progress /proposals /settings /rules /prompts /books /auth /run）`);
      resolve(server);
    });
  });
}
