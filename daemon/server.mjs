// daemon/server.mjs —— 本机控制面（默认 127.0.0.1:7331）+ 设置控制台页面（/ui）
// 给油猴「同步 Daemon」推凭据；给浏览器看状态/改设置/派任务。
// 安全：跨域仅放行 站点域名 与 本机；非白名单 Origin 的写请求/预检一律 403（页面自身同源访问不受影响）。
// /run 为单队列（FIFO 串行）——同一时刻最多一个 runBook；每次 run 的选项按次传入，不改共享配置。
import http from 'node:http';
import { parseBookUrl } from './book-url.mjs';
import { PROMPT_SLOTS, DEFAULT_TEMPLATE, FORMAT_RULES } from './prompt.mjs';
import { UI_HTML } from './ui.mjs';
import { createJobQueue } from './job-queue.mjs';
import { restoreSnapshot, applyProposal } from './glossary-io.mjs';

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

export function startServer({ store, pipeline, glossaryPipeline, checkPipeline, scheduler, agentScheduler = null, queue, makeClient, engine, agentLoop, agentEvents, port = 7331, log = console }) {
  // 单队列（控制面 /run 与 Agent 工具共用；未传入时按本进程管线自建）
  const jobQueue = queue || createJobQueue({
    resolveRunner: (job) => ({ glossary: glossaryPipeline, check: checkPipeline, translate: pipeline }[job]),
    log,
  });

  const llmConfig = () => store.getConfig('llm') || {};
  const schedulerOptionsFrom = (llm) => ({
    ...(llm.maxInFlight !== undefined ? { maxInFlight: Math.max(1, Number(llm.maxInFlight) || 1) } : {}),
    ...(llm.rpm !== undefined ? { rpm: Math.max(0, Number(llm.rpm) || 0) } : {}),
    ...(llm.transportRetries !== undefined ? { transportRetries: Math.max(0, Number(llm.transportRetries) || 0) } : {}),
    ...(llm.maxPromptChars !== undefined ? { maxPromptChars: Math.max(1000, Number(llm.maxPromptChars) || 12000) } : {}),
    ...(llm.strictPrompt !== undefined ? { strictPrompt: llm.strictPrompt === true } : {}),
  });

  // 助手池显式配置 = config.agent.workers 非空；空/缺省 = 跟随翻译池（/auth 推送镜像过去）
  const agentPoolExplicit = (cfgAgent) => Array.isArray(cfgAgent && cfgAgent.workers) && cfgAgent.workers.length > 0;

  // worker 列表合并：GET 永远只回掩码 key；客户端保存时 key 留空（或仍是掩码）= 沿用同 id 既有明文 key
  const maskMergeWorkers = (incoming, existing) => {
    const prevById = new Map((existing || []).map((w, i) => [String(w.id || `w${i}`), w]));
    return (incoming || [])
      .filter((w) => w && w.endpoint)
      .map((w, i) => {
        const id = String(w.id || `w${i}`);
        const key = String(w.key || '');
        const prev = prevById.get(id);
        return { id, model: w.model || '', endpoint: w.endpoint, key: (key === '' || key.includes('…')) ? ((prev && prev.key) || '') : key };
      });
  };

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
          queue: jobQueue.list().slice(-20),
          llm: scheduler ? scheduler.stats() : null,
          llmAgent: agentScheduler ? agentScheduler.stats() : null,
          usage: store.usageTotals(),
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/settings') {
        const workers = store.getConfig('workers') || [];
        const cfgAgent = store.getConfig('agent') || {};
        const maskList = (list) => (list || []).map((w, i) => ({ id: w.id || `w${i}`, model: w.model || '', endpoint: w.endpoint || '', key: maskKey(w.key) }));
        send(200, {
          ok: true,
          settings: {
            llm: llmConfig(),
            agent: { ...cfgAgent, ...(Array.isArray(cfgAgent.workers) ? { workers: maskList(cfgAgent.workers) } : {}) },
            origin: store.getConfig('origin') || 'https://n.novelia.cc',
            tokenSet: Boolean(store.getConfig('token')),
            workers: maskList(workers),
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
        if (Array.isArray(body.workers)) {
          const merged = maskMergeWorkers(body.workers, store.getConfig('workers'));
          store.setConfig('workers', merged);
          if (scheduler) scheduler.setWorkers(merged);
          if (agentScheduler && !agentPoolExplicit(store.getConfig('agent'))) agentScheduler.setWorkers(merged);
        }
        if (body.agent && typeof body.agent === 'object') {
          const cfgAgent = store.getConfig('agent') || {};
          const incoming = { ...body.agent };
          if (Array.isArray(incoming.workers)) {
            incoming.workers = maskMergeWorkers(incoming.workers, cfgAgent.workers);
            // 空数组 = 回到「跟随翻译池」；非空 = 显式助手池
            if (agentScheduler) agentScheduler.setWorkers(incoming.workers.length > 0 ? incoming.workers : (store.getConfig('workers') || []));
          }
          if (incoming.llm && typeof incoming.llm === 'object') {
            incoming.llm = { ...(cfgAgent.llm || {}), ...incoming.llm };
            if (agentScheduler) agentScheduler.setOptions(schedulerOptionsFrom(incoming.llm));
          }
          const merged = { ...cfgAgent, ...incoming };
          store.setConfig('agent', merged);
          if (agentLoop && agentLoop.setOptions) agentLoop.setOptions(merged);
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
          const item = jobQueue.get(id);
          send(item ? 200 : 404, item ? { ok: true, run: item } : { ok: false, error: 'run 不存在' });
          return;
        }
        send(200, { ok: true, runs: jobQueue.list().slice(-20).reverse() });
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
      if (req.method === 'GET' && url.pathname === '/snapshots') {
        send(200, { ok: true, snapshots: store.listSnapshots(url.searchParams.get('book') || '') });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/snapshots/restore') {
        const body = await readBody();
        const book = store.getBook(String(body.book || ''));
        if (!book) { send(400, { ok: false, error: 'book 不存在' }); return; }
        if (!makeClient) { send(500, { ok: false, error: 'makeClient 未装配' }); return; }
        const result = await restoreSnapshot({ store, client: makeClient(book), book, snapshotId: body.snapshotId });
        send(200, { ok: true, ...result });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/proposals/close') {
        const body = await readBody();
        const proposal = store.getProposal(body.id);
        if (!proposal) { send(404, { ok: false, error: '提案不存在' }); return; }
        store.setProposalStatus(proposal.id, String(body.status || 'closed'));
        send(200, { ok: true, id: proposal.id, status: String(body.status || 'closed') });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/proposals/apply') {
        const body = await readBody();
        const proposal = store.getProposal(body.id);
        if (!proposal) { send(404, { ok: false, error: '提案不存在' }); return; }
        const book = store.getBook(String(body.book || proposal.bookKey || ''));
        if (!book) { send(400, { ok: false, error: 'book 不存在（提案缺 bookKey 时需传 book）' }); return; }
        if (!makeClient || !engine) { send(500, { ok: false, error: 'makeClient/engine 未装配' }); return; }
        const result = await applyProposal({ store, client: makeClient(book), book, proposal, engine });
        if (result.applied > 0) store.setProposalStatus(proposal.id, 'applied');
        send(200, { ok: true, ...result });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/auth') {
        const body = await readBody();
        if (body.token) store.setConfig('token', body.token);
        if (Array.isArray(body.workers)) store.setConfig('workers', body.workers);
        if (body.origin) store.setConfig('origin', body.origin);
        if (scheduler && Array.isArray(body.workers)) scheduler.setWorkers(body.workers);   // 热更新，无需重启
        // 助手池「跟随翻译池」模式：同步镜像；显式配置过则不被推送覆盖
        if (agentScheduler && Array.isArray(body.workers) && !agentPoolExplicit(store.getConfig('agent'))) agentScheduler.setWorkers(body.workers);
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
        const { id } = jobQueue.enqueue({ bookKey: body.bookKey, job, options });
        send(202, { ok: true, accepted: true, queued: true, id, bookKey: body.bookKey, job });
        return;
      }
      // ---- Agent（本地助手） ----
      if (req.method === 'GET' && url.pathname === '/agent/config') {
        const cfg = store.getConfig('agent') || {};
        send(200, {
          ok: true,
          approvalMode: cfg.approvalMode === 'auto' ? 'auto' : 'manual',
          tools: agentLoop ? [...agentLoop.registry.keys()] : [],
          sessions: store.listAgentSessions(20).map((x) => ({ id: x.id, bookKey: x.bookKey, title: x.title, state: x.state, updatedAt: x.updatedAt, running: agentLoop ? agentLoop.running(x.id) : false })),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/agent/config') {
        const body = await readBody();
        const cfg = store.getConfig('agent') || {};
        const next = { ...cfg };
        if (body.approvalMode === 'auto' || body.approvalMode === 'manual') next.approvalMode = body.approvalMode;
        store.setConfig('agent', next);
        send(200, { ok: true, approvalMode: next.approvalMode || 'manual' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/agent/skills') {
        if (!agentLoop || !agentLoop.skills) { send(400, { ok: false, error: '技能目录未装配' }); return; }
        send(200, { ok: true, skills: agentLoop.skills.list().map((s) => ({ name: s.name, description: s.description, files: s.files.length })) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/agent/personality') {
        const body = await readBody();
        const sessionId = String(body.session || '');
        if (!store.getAgentSession(sessionId)) { send(404, { ok: false, error: '会话不存在' }); return; }
        store.setAgentPersonality(sessionId, String(body.text == null ? '' : body.text));
        send(200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/agent/sessions') {
        send(200, { ok: true, sessions: store.listAgentSessions(20).map((x) => ({ id: x.id, bookKey: x.bookKey, title: x.title, state: x.state, updatedAt: x.updatedAt, running: agentLoop ? agentLoop.running(x.id) : false })) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/agent/session') {
        const body = await readBody();
        const id = store.createAgentSession({ bookKey: String(body.bookKey || ''), title: String(body.title || 'agent') });
        send(200, { ok: true, sessionId: id });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/agent/snapshot') {
        const sessionId = url.searchParams.get('session') || '';
        const session = store.getAgentSession(sessionId);
        if (!session) { send(404, { ok: false, error: '会话不存在' }); return; }
        send(200, {
          ok: true,
          session: { id: session.id, bookKey: session.bookKey, title: session.title, state: session.state, personality: session.personality || '', summaryUpTo: session.summaryUpTo, updatedAt: session.updatedAt },
          running: agentLoop ? agentLoop.running(sessionId) : false,
          messages: store.listAgentMessages(sessionId).map((m) => ({ seq: m.seq, role: m.role, content: m.content, toolCalls: m.toolCalls, toolCallId: m.toolCallId, name: m.name, at: m.at, usage: m.usage })),
          pendingDecision: store.getPendingAgentDecision(sessionId),
          usage: store.agentSessionUsage(sessionId),
          revision: agentEvents ? agentEvents.revision(sessionId) : 0,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/agent/message') {
        if (!agentLoop) { send(400, { ok: false, error: 'agent 未装配' }); return; }
        const body = await readBody();
        const text = String(body.message || '').trim();
        if (text === '') { send(400, { ok: false, error: '缺少 message' }); return; }
        let sessionId = String(body.session || '');
        if (!sessionId) sessionId = store.createAgentSession({ bookKey: String(body.bookKey || ''), title: text.slice(0, 40) });
        if (!store.getAgentSession(sessionId)) { send(404, { ok: false, error: '会话不存在' }); return; }
        if (agentLoop.running(sessionId)) { send(409, { ok: false, error: '该会话上一轮还在进行（可先停止）' }); return; }
        let pinnedSkills = [];
        if (text.includes('@') && agentLoop.skills) {
          const m = agentLoop.skills.mentions(text);
          pinnedSkills = m.skills;
          if (m.unknown.length > 0) {
            send(400, { ok: false, error: `未知技能：${m.unknown.join('、')}`, knownSkills: agentLoop.skills.list().map((x) => x.name) });
            return;
          }
        }
        const onEvent = (ev) => { if (agentEvents) agentEvents.publish(sessionId, ev); };
        agentLoop.runTurn(sessionId, text, {
          onEvent,
          approvalMode: body.approvalMode === 'auto' || body.approvalMode === 'manual' ? body.approvalMode : undefined,
          pinnedSkills,
        }).then((result) => onEvent({ type: 'turn_end', ok: result.ok, error: result.error || '', steps: result.steps || 0 }))
          .catch((e) => onEvent({ type: 'turn_end', ok: false, error: String((e && e.message) || e) }));
        send(202, { ok: true, accepted: true, sessionId });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/agent/decision') {
        if (!agentLoop) { send(400, { ok: false, error: 'agent 未装配' }); return; }
        const body = await readBody();
        const okDecision = agentLoop.resolveDecision(body.id, String(body.status || 'rejected'), body.resolution || null);
        send(okDecision ? 200 : 404, okDecision ? { ok: true } : { ok: false, error: '决定不存在或已处理' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/agent/stop') {
        if (!agentLoop) { send(400, { ok: false, error: 'agent 未装配' }); return; }
        const body = await readBody();
        send(200, { ok: true, stopped: agentLoop.stop(String(body.session || '')) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/agent/events') {
        if (!agentEvents) { send(400, { ok: false, error: 'agent 事件总线未装配' }); return; }
        const sessionId = url.searchParams.get('session') || '';
        const since = Number(url.searchParams.get('since') || 0);
        res.writeHead(200, { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        const write = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* 连接已断 */ } };
        for (const ev of agentEvents.since(sessionId, since)) write(ev);
        const unsubscribe = agentEvents.subscribe(sessionId, write);
        const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* ignore */ } }, 15000);
        const cleanup = () => { clearInterval(keepalive); unsubscribe(); try { res.end(); } catch { /* ignore */ } };
        req.on('close', cleanup);
        req.on('error', cleanup);
        return;
      }
      send(404, { ok: false, error: `not found: ${url.pathname}` });
    } catch (e) {
      send(500, { ok: false, error: String((e && e.message) || e) });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      log.log(`[serve] http://127.0.0.1:${port}（控制台 /ui；API /status /runs /progress /proposals /snapshots /settings /rules /prompts /books /auth /run /agent/*）`);
      resolve(server);
    });
  });
}
