#!/usr/bin/env node
// daemon/index.mjs —— GPT 翻译 worker 运行器（站点工作区兼容；零依赖，Node >= 24）
// 子命令：
//   auth <token>            保存站点凭据（也可由油猴「同步 Daemon」推送）
//   add <novel-url>         登记一本书（/novel/{provider}/{id} 或 /wenku/{id}）
//   run [--book key] [--concurrency 2]  跑一遍增强术语管线（提取→核实→回扫→直写/提案）
//   translate [--book key] [--level expire|normal|all] [--concurrency 2] [--max-chapters N]
//   watch [--interval 分钟]  常驻：定期按 expire 档补翻未译/过期章节
//   serve [--port 7331]     本机控制面（/status /progress /auth /run）
//   status                  控制台状态
//   forget <book>           忘记一本书（本地数据删除，站点不动）
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (name) => import(pathToFileURL(path.join(here, name)).href);
const { Store } = await imp('store.mjs');
const { loadEngine } = await imp('engine.mjs');
const { SiteClient } = await imp('site-client.mjs');
const { TranslationPipeline } = await imp('translate-pipeline.mjs');
const { GlossaryPipeline } = await imp('glossary-pipeline.mjs');
const { LlmScheduler } = await imp('scheduler.mjs');
const { startServer } = await imp('server.mjs');

const DB_PATH = path.join(here, 'daemon.db');
const RSS_LIMIT_MB = 500;
const log = {
  log: (...a) => console.log(new Date().toISOString().slice(11, 19), ...a),
  error: (...a) => console.error(new Date().toISOString().slice(11, 19), ...a),
};

const args = process.argv.slice(2);
const command = args[0] || 'status';
const flags = {};
for (let i = 1; i < args.length; i += 1) {
  if (args[i].startsWith('--')) {
    flags[args[i].slice(2)] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : true;
  }
}

const store = new Store(DB_PATH);
const engine = await loadEngine();

function getWorkers() {
  const workers = store.getConfig('workers');
  if (!Array.isArray(workers) || workers.length === 0) return [];
  return workers.map((w, i) => ({ id: w.id || `w${i}`, model: w.model, endpoint: w.endpoint, key: w.key || '' }));
}

function makeClient(book) {
  const origin = book.origin || store.getConfig('origin') || 'https://n.novelia.cc';
  return new SiteClient({ origin, token: store.getConfig('token') || '', engine });
}

// 调度器（全局并发门默认 1 = 单线程 Gemini 场景）；配置优先级：CLI 旗标 > config.llm > 默认
const pickNum = (flagVal, cfgVal, dflt) => {
  const f = Number(flagVal);
  if (flagVal !== undefined && flagVal !== true && Number.isFinite(f) && f >= 0) return f;
  const c = Number(cfgVal);
  if (Number.isFinite(c) && c >= 0) return c;
  return dflt;
};
const llmConfig = store.getConfig('llm') || {};
const scheduler = new LlmScheduler({
  engine, store, log,
  options: {
    maxInFlight: Math.max(1, pickNum(flags['max-in-flight'], llmConfig.maxInFlight, 1)),
    rpm: pickNum(flags.rpm, llmConfig.rpm, 0),
    transportRetries: pickNum(flags['transport-retries'], llmConfig.transportRetries, 3),
    maxPromptChars: Math.max(1000, pickNum(flags['max-prompt-chars'], llmConfig.maxPromptChars, 12000)),
    strictPrompt: flags['strict-prompt'] === true || llmConfig.strictPrompt === true,
    workers: getWorkers(),
  },
});

const pipeline = new TranslationPipeline({
  store, engine,
  scheduler,
  makeClient,
  log,
  options: {
    translatorId: 'gpt',
    level: typeof flags.level === 'string' ? flags.level : 'expire',
    concurrency: Math.max(1, Number(flags.concurrency) || 2),
    maxChapters: Math.max(0, Number(flags['max-chapters']) || 0),
    rssLimitMB: RSS_LIMIT_MB,
  },
});

const glossaryPipeline = new GlossaryPipeline({
  store, engine,
  scheduler,
  makeClient,
  log,
  options: {
    budgetChars: Math.max(200, Number(flags.budget) || 3000),
    concurrency: Math.max(1, Number(flags.concurrency) || 2),
    verify: flags['no-verify'] !== true,
    maxRequests: Number(flags['max-requests']) || 0,
    rssLimitMB: RSS_LIMIT_MB,
  },
});

// 自愈：未捕获异常干净退出（外部看门狗拉起；状态都在 SQLite）
process.on('unhandledRejection', (e) => { log.error('unhandledRejection:', e); process.exit(0); });
process.on('uncaughtException', (e) => { log.error('uncaughtException:', e); process.exit(0); });
setInterval(() => {
  const m = process.memoryUsage();
  store.addMetrics({ rss: m.rss / 1e6, heap: m.heapUsed / 1e6 });
}, 60000).unref();

function parseBookUrl(url) {
  const m = /\/(novel|wenku)\/([^/?#]+)(?:\/([^/?#]+))?/.exec(url);
  if (!m) throw new Error('无法从 URL 解析书籍（需要 /novel/{provider}/{id} 或 /wenku/{id}）');
  if (m[1] === 'novel') return { kind: 'web', providerId: m[2], novelId: m[3], key: `web:${m[2]}/${m[3]}` };
  return { kind: 'wenku', providerId: '', novelId: m[2], key: `wenku:${m[2]}` };
}

async function runBooks(filterKey) {
  const books = filterKey ? [store.getBook(filterKey)].filter(Boolean) : store.listBooks();
  if (books.length === 0) { log.error('没有登记的书：先 add <novel-url>'); return; }
  for (const book of books) {
    log.log(`==== translate ${book.key}（level=${pipeline.options.level}）====`);
    try {
      const result = await pipeline.runBook(book.key);
      log.log(`==== ${book.key} 完成`, JSON.stringify(result.stats));
    } catch (e) {
      log.error(`==== ${book.key} 失败: ${(e && e.message) || e}`);
      if (e && e.code === 'unauthorized') log.error('凭据失效：在站点页面点「同步 Daemon」，或 daemon auth <token> 重新写入');
    }
  }
}

switch (command) {
  case 'auth': {
    const token = args[1];
    if (!token) { log.error('用法: daemon auth <token>'); process.exit(2); }
    store.setConfig('token', token);
    log.log('token 已保存');
    break;
  }
  case 'add': {
    const url = args[1];
    if (!url) { log.error('用法: daemon add <novel-url>'); process.exit(2); }
    const info = parseBookUrl(url);
    store.upsertBook({ ...info, origin: new URL(url).origin, title: '' });
    log.log(`已登记: ${info.key}（${info.kind}）`);
    break;
  }
  case 'run': {
    const books = flags.book ? [store.getBook(flags.book)].filter(Boolean) : store.listBooks();
    if (books.length === 0) { log.error('没有登记的书：先 add <novel-url>'); break; }
    for (const book of books) {
      log.log(`==== glossary ${book.key} ====`);
      try {
        const r = await glossaryPipeline.runBook(book.key);
        log.log(`==== ${book.key} 完成`, JSON.stringify(r.stats));
      } catch (e) {
        log.error(`==== ${book.key} 失败: ${(e && e.message) || e}`);
        if (e && e.code === 'unauthorized') log.error('凭据失效：在站点页面点「同步 Daemon」，或 daemon auth <token> 重新写入');
      }
    }
    break;
  }
  case 'translate': {
    await runBooks(flags.book);
    break;
  }
  case 'watch': {
    const intervalMin = Math.max(1, Number(flags.interval) || 30);
    const watchJob = flags.job === 'glossary' ? 'glossary' : 'translate';
    log.log(`watch 模式（job=${watchJob}）：每 ${intervalMin} 分钟一次（Ctrl-C 退出）`);
    for (;;) {
      if (watchJob === 'glossary') {
        const books = flags.book ? [store.getBook(flags.book)].filter(Boolean) : store.listBooks();
        for (const book of books) {
          try { await glossaryPipeline.runBook(book.key); } catch (e) { log.error(`${book.key}: ${(e && e.message) || e}`); }
        }
      } else {
        await runBooks(flags.book);
      }
      log.log(`休眠 ${intervalMin} 分钟…`);
      await new Promise((r) => setTimeout(r, intervalMin * 60 * 1000));
    }
  }
  case 'serve': {
    const port = Math.max(1, Number(flags.port) || 7331);
    await startServer({ store, pipeline, glossaryPipeline, scheduler, port, log });
    log.log('serve 模式：Ctrl-C 退出');
    await new Promise(() => { });
  }
  case 'status': {
    const books = store.listBooks();
    log.log(`books: ${books.length}`);
    books.forEach((b) => {
      const prog = store.listProgress(b.key);
      log.log(`  ${b.key}  [${b.state}] ${b.title || ''}  已译章节=${prog.length}`);
    });
    log.log(`open proposals: ${store.listProposals().filter((x) => x.status === 'open').length}`);
    log.log(`workers: ${getWorkers().length} 个（auth / 油猴同步写入）`);
    const llm = scheduler.stats();
    log.log(`llm: maxInFlight=${llm.maxInFlight} workers=${llm.workers} 请求=${llm.requests} 传输重试=${llm.transportRetries} 在途峰值=${llm.maxObservedInFlight}`);
    const u = store.usageTotals();
    log.log(`usage: 轮次=${u.rows} 请求=${u.requests} prompt=${u.promptTokens} completion=${u.completionTokens}`);
    break;
  }
  case 'forget': {
    const key = args[1];
    if (!key) { log.error('用法: daemon forget <bookKey>'); process.exit(2); }
    store.forgetBook(key);
    log.log(`已忘记 ${key}（站点数据不受影响）`);
    break;
  }
  default:
    log.error(`未知命令: ${command}（可用 auth/add/translate/watch/serve/status/forget）`);
    process.exit(2);
}
