#!/usr/bin/env node
// daemon/index.mjs —— GPT 翻译 worker 运行器（站点工作区兼容；零依赖，Node >= 24）
// 子命令：
//   auth <token>            保存站点凭据（也可由油猴「Daemon 连接」推送/自动同步）
//   add <novel-url>         登记一本书（/novel/{provider}/{id} 或 /wenku/{id}）
//   run [--book key] [--concurrency 2]  跑一遍增强术语管线（提取→核实→回扫→直写/提案）
//   check [--book key] [--codes A,B] [--limit N] [--propose] [--tsv]   质检（七码报告；propose 出提案）
//   rules list|add|rm|enable|disable   文本处理链规则（pre/post 替换、保留段）
//   prompt show|set|clear   提示词模板（prefix/base/thinking/suffix；base 必须含 {format_rules}）
//   glossary-io import|export   LG 术语表互通（JSON；写站点=快照+全量替换+回读校验）
//   agent [--book key] [--message "..."] [--session id] [--auto]   本地助手（工具调用；缺 --message 进交互模式）
//   export-src --book key [--out file]   导出站点原文为 LG 可翻译的纯文本（+对齐清单）
//   import-lg --book key --txt file --manifest file [--apply] [--limit N]   LG 译文结果对齐导入（gpt 端）
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
const { loadEngine, repoRoot } = await imp('engine.mjs');
const { SiteClient } = await imp('site-client.mjs');
const { TranslationPipeline } = await imp('translate-pipeline.mjs');
const { GlossaryPipeline } = await imp('glossary-pipeline.mjs');
const { CheckPipeline, samplesToTsv } = await imp('check-pipeline.mjs');
const { parseLgGlossary, planImport, applyImport, toLgGlossary } = await imp('glossary-io.mjs');
const { parseBookUrl } = await imp('book-url.mjs');
const { collectChapters, buildSourceExport, manifestOf, splitResultLines, verifyImport, exportBookSource, applyImportReport, createLgImportRunner } = await imp('lg-align.mjs');
const { createAgentLlm } = await imp('agent-llm.mjs');
const { createAgentLoop } = await imp('agent-loop.mjs');
const { doingTool, askUserTool } = await imp('agent-tools.mjs');
const { createReadTools } = await imp('agent-tools-read.mjs');
const { createWriteTools } = await imp('agent-tools-write.mjs');
const { createLgTools } = await imp('agent-tools-lg.mjs');
const { createWorkspaceTools } = await imp('agent-workspace.mjs');
const { createSkillCatalog } = await imp('agent-skills.mjs');
const { createAgentEvents } = await imp('agent-events.mjs');
const { createJobQueue } = await imp('job-queue.mjs');
const { templateFromStore, DEFAULT_TEMPLATE, PROMPT_SLOTS } = await imp('prompt.mjs');
const { LlmScheduler } = await imp('scheduler.mjs');
const { createProxyFetch, normalizeProxyConfig } = await imp('proxy.mjs');
const { startServer } = await imp('server.mjs');

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

const DB_PATH = typeof flags.db === 'string' && flags.db !== 'true' ? path.resolve(flags.db) : path.join(here, 'daemon.db');
const store = new Store(DB_PATH);
const engine = await loadEngine();

function getWorkers() {
  const workers = store.getConfig('workers');
  if (!Array.isArray(workers) || workers.length === 0) return [];
  return workers.map((w, i) => ({ id: w.id || `w${i}`, model: w.model, endpoint: w.endpoint, key: w.key || '' }));
}

// 出网代理：配置每次请求现读（控制台保存即生效）；站点 API 与两个模型池共用同一份配置
const getProxy = () => store.getConfig('proxy');
const proxyFetch = createProxyFetch({ getProxy });

function makeClient(book) {
  const origin = book.origin || store.getConfig('origin') || 'https://n.novelia.cc';
  return new SiteClient({ origin, token: store.getConfig('token') || '', engine, fetchImpl: proxyFetch });
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
  fetchImpl: proxyFetch,
  options: {
    maxInFlight: Math.max(1, pickNum(flags['max-in-flight'], llmConfig.maxInFlight, 1)),
    rpm: pickNum(flags.rpm, llmConfig.rpm, 0),
    transportRetries: pickNum(flags['transport-retries'], llmConfig.transportRetries, 3),
    maxPromptChars: Math.max(1000, pickNum(flags['max-prompt-chars'], llmConfig.maxPromptChars, 12000)),
    strictPrompt: flags['strict-prompt'] === true || llmConfig.strictPrompt === true,
    workers: getWorkers(),
  },
});

// 助手/术语池（工具调用模型）：config.agent.workers 非空时独立成池（独立并发/限流，不与翻译互抢并发门）；
// 空/缺省 = 跟随翻译池（/auth 推送与设置页编辑都会镜像过去）
const agentCfg0 = store.getConfig('agent') || {};
const agentLlmCfg = agentCfg0.llm || {};
const agentScheduler = new LlmScheduler({
  engine, store, log,
  fetchImpl: proxyFetch,
  options: {
    maxInFlight: Math.max(1, pickNum(undefined, agentLlmCfg.maxInFlight, 1)),
    rpm: pickNum(undefined, agentLlmCfg.rpm, 0),
    transportRetries: pickNum(undefined, agentLlmCfg.transportRetries, 3),
    maxPromptChars: Math.max(1000, pickNum(undefined, agentLlmCfg.maxPromptChars, 12000)),
    strictPrompt: agentLlmCfg.strictPrompt === true,
    workers: Array.isArray(agentCfg0.workers) && agentCfg0.workers.length > 0 ? agentCfg0.workers : getWorkers(),
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
  scheduler: agentScheduler,
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

const checkPipeline = new CheckPipeline({ store, engine, makeClient, log });

// Agent（助手池 = agentScheduler；与翻译池互不抢并发门）
const lgImportRunner = createLgImportRunner({ store, makeClient, log });
const jobQueue = createJobQueue({
  resolveRunner: (job) => ({ glossary: glossaryPipeline, check: checkPipeline, translate: pipeline, 'lg-import': lgImportRunner }[job]),
  log,
});
const skillCatalog = createSkillCatalog({ roots: [path.join(repoRoot, 'skills')], log });
const readTools = createReadTools({ store, engine, makeClient, log });
const agentLlm = createAgentLlm({ scheduler: agentScheduler, log });
const agentEvents = createAgentEvents();
const agentApprovalDefault = flags.auto === true
  ? 'auto'
  : ((store.getConfig('agent') || {}).approvalMode === 'auto' ? 'auto' : 'manual');
const agentLoop = createAgentLoop({
  store,
  chat: agentLlm.chat,
  takeUsage: agentLlm.takeUsage,
  tools: [...readTools, ...createWriteTools(), ...createLgTools(), ...createWorkspaceTools(), doingTool, askUserTool],
  log,
  options: {
    approvalMode: agentApprovalDefault,
    bookKey: typeof flags.book === 'string' ? flags.book : '',
    extraSystem: skillCatalog.promptText(),
    deps: {
      engine,
      makeClient,
      getProxy,
      skills: skillCatalog,
      enqueue: (payload) => jobQueue.enqueue(payload),
      queueBusy: () => jobQueue.busy(),
      exportsDir: path.join(repoRoot, 'daemon', 'exports'),
      workspaceRoot: path.join(repoRoot, 'daemon', 'work'),
    },
  },
});

// 自愈：未捕获异常干净退出（外部看门狗拉起；状态都在 SQLite）process.on('unhandledRejection', (e) => { log.error('unhandledRejection:', e); process.exit(0); });
process.on('uncaughtException', (e) => { log.error('uncaughtException:', e); process.exit(0); });
setInterval(() => {
  const m = process.memoryUsage();
  store.addMetrics({ rss: m.rss / 1e6, heap: m.heapUsed / 1e6 });
}, 60000).unref();

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
      if (e && e.code === 'unauthorized') log.error('凭据失效：站点页面开着会在 30s 内自动重推；或点「Daemon 连接」，或 daemon auth <token> 重新写入');
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
        if (e && e.code === 'unauthorized') log.error('凭据失效：站点页面开着会在 30s 内自动重推；或点「Daemon 连接」，或 daemon auth <token> 重新写入');
      }
    }
    break;
  }
  case 'check': {
    const books = flags.book ? [store.getBook(flags.book)].filter(Boolean) : store.listBooks();
    if (books.length === 0) { log.error('没有登记的书：先 add <novel-url>'); break; }
    for (const book of books) {
      log.log(`==== check ${book.key} ====`);
      try {
        const r = await checkPipeline.runBook(book.key, {
          options: {
            propose: flags.propose === true,
            limit: Math.max(1, Number(flags.limit) || 50),
            codes: typeof flags.codes === 'string' ? flags.codes.split(',').map((s) => s.trim()).filter(Boolean) : null,
          },
        });
        log.log(`==== ${book.key} 质检完成：配对 ${r.stats.pairs}，命中 ${r.stats.hits}`, JSON.stringify(r.stats.codes));
        if (flags.tsv === true && r.stats.samples.length > 0) log.log(samplesToTsv(r.stats.samples));
      } catch (e) {
        log.error(`==== ${book.key} 失败: ${(e && e.message) || e}`);
        if (e && e.code === 'unauthorized') log.error('凭据失效：站点页面开着会在 30s 内自动重推；或点「Daemon 连接」，或 daemon auth <token> 重新写入');
      }
    }
    break;
  }
  case 'rules': {
    const sub = args[1] || 'list';
    if (sub === 'list') {
      const rows = store.listRules(typeof flags.book === 'string' ? flags.book : '');
      rows.forEach((r) => log.log(`#${r.id} [${r.enabled ? 'on' : 'off'}] ${r.kind} prio=${r.priority} ${r.regex ? 're' : 'lit'}${r.case_sensitive ? ' cs' : ''} ${r.bookKey || '(全局)'} :: ${r.pattern} → ${r.replacement}`));
      log.log(`共 ${rows.length} 条`);
    } else if (sub === 'add') {
      if (typeof flags.kind !== 'string' || flags.kind === 'true' || typeof flags.pattern !== 'string' || flags.pattern === 'true') { log.error('用法: rules add --kind text_preserve|pre_replacement|post_replacement --pattern <文本/正则> [--replace <替换>] [--book key] [--regex] [--cs] [--priority N]'); break; }
      const id = store.addRule({
        bookKey: typeof flags.book === 'string' ? flags.book : '',
        kind: flags.kind,
        pattern: flags.pattern,
        replacement: typeof flags.replace === 'string' ? flags.replace : '',
        regex: flags.regex === true ? 1 : 0,
        case_sensitive: flags.cs === true ? 1 : 0,
        priority: Number(flags.priority) || 100,
      });
      log.log(`已添加规则 #${id}`);
    } else if (sub === 'rm') {
      const id = Number(args[2]) || Number(flags.id) || 0;
      store.deleteRule(id);
      log.log(`已删除规则 #${id}`);
    } else if (sub === 'enable' || sub === 'disable') {
      const id = Number(args[2]) || Number(flags.id) || 0;
      store.setRuleEnabled(id, sub === 'enable');
      log.log(`规则 #${id} 已${sub === 'enable' ? '启用' : '禁用'}`);
    } else {
      log.error('用法: rules list|add|rm|enable|disable');
    }
    break;
  }
  case 'prompt': {
    const sub = args[1] || 'show';
    const promptBook = typeof flags.book === 'string' ? flags.book : '';
    if (sub === 'show') {
      const template = templateFromStore(store, promptBook);
      for (const slot of PROMPT_SLOTS) {
        const isDefault = template[slot] === DEFAULT_TEMPLATE[slot];
        log.log(`[${slot}]${isDefault ? '（默认）' : ''}`);
        log.log(template[slot] || '(空)');
      }
    } else if (sub === 'set') {
      const slot = typeof flags.slot === 'string' ? flags.slot : '';
      if (!PROMPT_SLOTS.includes(slot)) { log.error('用法: prompt set --slot prefix|base|thinking|suffix --text <文本> | --file <path> [--book key]'); break; }
      let text = typeof flags.text === 'string' ? flags.text : null;
      if (text === null && typeof flags.file === 'string' && flags.file !== 'true') text = fs.readFileSync(flags.file, 'utf8');
      if (text === null) { log.error('缺少 --text 或 --file'); break; }
      store.setPrompt(promptBook, slot, text);
      log.log(`已设置 ${promptBook || '(全局)'} 的 ${slot}（${text.length} 字符）`);
      if (slot === 'base' && !text.includes('{format_rules}')) log.error('警告：base 未包含 {format_rules}，运行时会回退默认模板');
    } else if (sub === 'clear') {
      if (typeof flags.slot === 'string') { store.clearPrompt(promptBook, flags.slot); log.log(`已清除 ${promptBook || '(全局)'} 的 ${flags.slot}`); }
      else { for (const slot of PROMPT_SLOTS) store.clearPrompt(promptBook, slot); log.log(`已清除 ${promptBook || '(全局)'} 的全部槽`); }
    } else {
      log.error('用法: prompt show|set|clear');
    }
    break;
  }
  case 'glossary-io': {
    const sub = args[1] || '';
    const file = args[2];
    const ioBookKey = typeof flags.book === 'string' ? flags.book : '';
    const ioBook = ioBookKey ? store.getBook(ioBookKey) : null;
    if (!ioBook) { log.error(`用法: glossary-io <import|export> --book <key>（book 不存在: ${ioBookKey || '(缺 --book)'}）`); break; }
    const ioClient = makeClient(ioBook);
    if (sub === 'import') {
      if (!file) { log.error('用法: glossary-io import <file.json> --book <key> [--apply] [--propose]'); break; }
      const parsed = parseLgGlossary(fs.readFileSync(file, 'utf8'));
      const current = await ioClient.getGlossary(ioBook);
      const plan = planImport({ entries: parsed.entries, currentGlossary: current, engine });
      log.log(`解析 ${parsed.entries.length} 条（重复覆盖 ${parsed.duplicates.length}）：新增 ${plan.additions.length}、更新 ${plan.updates.length}、已存在相同 ${plan.same.length}、门槛拦截 ${plan.skipped.length}、regex 分流 ${plan.regexRules.length}`);
      plan.skipped.slice(0, 10).forEach((s) => log.log(`  拦截 ${s.src}：${s.reasons.join('、')}`));
      if (plan.noteIgnored.length > 0) log.log(`  注意：${plan.noteIgnored.length} 条带 case_sensitive 标记（站点术语表为纯文本匹配，标记已忽略）`);
      if (plan.regexRules.length > 0) {
        if (flags.apply === true) {
          for (const r of plan.regexRules) store.addRule({ bookKey: '', kind: 'pre_replacement', pattern: r.src, replacement: r.dst, regex: 1, enabled: 0, note: 'LG 导入（默认禁用，确认后启用）' });
          log.log(`regex 条目已入 rules（默认禁用）${plan.regexRules.length} 条`);
        } else {
          log.log(`regex 条目 ${plan.regexRules.length} 条未入库（--apply 时写入，默认禁用）`);
        }
      }
      if (flags.propose === true && (plan.skipped.length > 0 || plan.updates.length > 0)) {
        const id = store.addProposal({
          bookKey: ioBook.key,
          kind: 'import',
          entries: [
            ...plan.skipped.map((s) => ({ src: s.src, dst: s.dst, type: s.info, suspect: s.reasons })),
            ...plan.updates.map((u) => ({ src: u.src, dst: u.value, type: '', suspect: [`覆盖现值「${u.before}」`] })),
          ],
          note: `LG 导入待审（新增 ${plan.additions.length} 条可直接应用）`,
        });
        log.log(`已生成提案 #${id}`);
      }
      if (flags.apply !== true) { log.log('dry-run：未写站点（加 --apply 执行）'); break; }
      const result = await applyImport({ store, client: ioClient, book: ioBook, plan, currentGlossary: current, note: `LG 导入 ${file}` });
      log.log(`已应用 ${result.applied} 条（新增 ${result.added} / 更新 ${result.updated}，快照 #${result.snapshotId}，回读校验${result.verified ? '通过' : '失败'}，现 ${result.afterCount} 条）`);
      if (!result.verified) log.error('回读校验失败：站点内容与预期不一致，可用快照回滚');
    } else if (sub === 'export') {
      const current = await ioClient.getGlossary(ioBook);
      const list = toLgGlossary(current, engine);
      const text = JSON.stringify(list, null, 2);
      if (typeof flags.out === 'string' && flags.out !== 'true') {
        fs.writeFileSync(flags.out, text);
        log.log(`已导出 ${list.length} 条 → ${flags.out}`);
      } else {
        log.log(text);
      }
    } else {
      log.error('用法: glossary-io import <file.json> | export [--out <file>]（均需 --book <key>）');
    }
    break;
  }
  case 'agent': {
    const agentBook = typeof flags.book === 'string' ? flags.book : '';
    let sessionId = typeof flags.session === 'string' ? flags.session : '';
    const firstMessage = typeof flags.message === 'string' ? flags.message : '';
    let pinnedSkills = [];
    if (firstMessage && skillCatalog.mentions) {
      const m = skillCatalog.mentions(firstMessage);
      pinnedSkills = m.skills;
      if (m.unknown.length > 0) { log.error(`未知技能：${m.unknown.join('、')}（可用：${skillCatalog.list().map((x) => x.name).join('、')}）`); break; }
    }
    if (sessionId) {
      if (!store.getAgentSession(sessionId)) { log.error(`会话不存在：${sessionId}`); break; }
    } else {
      sessionId = store.createAgentSession({ bookKey: agentBook, title: (firstMessage || 'agent').slice(0, 40) });
      log.log(`新会话：${sessionId}${agentBook ? `（${agentBook}）` : ''}${flags.auto === true ? '（auto 审批）' : ''}`);
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const onEvent = (ev) => {
      if (ev.type === 'assistant_message') {
        if (ev.text) log.log(`\n${ev.text}`);
        (ev.toolCalls || []).forEach((tc) => log.log(`[工具] ${tc.name} ${JSON.stringify(tc.args)}`));
      }
      if (ev.type === 'tool_result') log.log(`[结果] ${ev.tool}${ev.ok ? '' : ` 失败：${ev.error}`}`);
      if (ev.type === 'doing') log.log(`[进度] ${ev.text}`);
      if (ev.type === 'question') {
        const lines = [`[提问] ${ev.question}`];
        (ev.options || []).forEach((o, i) => lines.push(`  ${i + 1}) ${o.label}（${o.id}）`));
        log.log(lines.join('\n'));
        rl.question('选择编号，或直接输入回答 > ').then((ans) => {
          const idx = Number(ans.trim());
          const picked = Number.isInteger(idx) && idx >= 1 && idx <= (ev.options || []).length ? ev.options[idx - 1] : null;
          agentLoop.resolveDecision(ev.decisionId, 'allowed', picked ? { selected: picked.id } : { custom: ans.trim() });
        }).catch(() => agentLoop.resolveDecision(ev.decisionId, 'cancelled'));
      }
      if (ev.type === 'decision') {
        log.log(`[审批] ${ev.tool} ${JSON.stringify(ev.preview || ev.args || {}).slice(0, 300)}`);
        rl.question('允许本次写入？(y/N) > ').then((ans) => {
          const yes = /^(y|yes)$/i.test(ans.trim());
          agentLoop.resolveDecision(ev.decisionId, yes ? 'allowed' : 'rejected', { via: 'cli' });
        }).catch(() => agentLoop.resolveDecision(ev.decisionId, 'rejected'));
      }
    };
    try {
      if (firstMessage) {
        const result = await agentLoop.runTurn(sessionId, firstMessage, { onEvent, pinnedSkills });
        log.log(`\n[一轮结束] ${result.ok ? `ok（${result.steps} 步）` : `失败：${result.error}`}`);
      } else {
        log.log('交互模式：输入消息回车发送；/stop 中止当前轮；/exit 退出');
        for (;;) {
          const line = (await rl.question('› ')).trim();
          if (line === '/exit' || line === '/quit') break;
          if (line === '') continue;
          if (line === '/stop') { agentLoop.stop(sessionId); continue; }
          const m = skillCatalog.mentions ? skillCatalog.mentions(line) : { skills: [], unknown: [] };
          if (m.unknown.length > 0) { log.error(`未知技能：${m.unknown.join('、')}`); continue; }
          const result = await agentLoop.runTurn(sessionId, line, { onEvent, pinnedSkills: m.skills });
          if (!result.ok) log.log(`[一轮结束] 失败：${result.error}`);
        }
      }
    } finally {
      rl.close();
    }
    break;
  }
  case 'export-src': {
    const srcBookKey = typeof flags.book === 'string' ? flags.book : '';
    const srcBook = store.getBook(srcBookKey);
    if (!srcBook) { log.error(`book 不存在：${srcBookKey || '(缺 --book)'}`); break; }
    if (jobQueue.busy()) { log.error('有翻译任务正在运行（单队列占用中），请等它结束再导出'); break; }
    const srcClient = makeClient(srcBook);
    const outFile = (typeof flags.out === 'string' && flags.out !== 'true') ? path.resolve(flags.out) : '';
    try {
      const exported = await exportBookSource(srcClient, srcBook, {
        outFile,
        exportsDir: path.join(repoRoot, 'daemon', 'exports'),
        onProgress: (n, t) => log.log(`  取得 ${n}：${t}`),
      });
      log.log(`已导出 ${exported.linesTotal} 行（${exported.chapters} 章）→ ${exported.file}`);
      log.log(`清单 → ${exported.manifestFile}（交给 LG 翻译后用 import-lg 导回）`);
    } catch (e) {
      log.error((e && e.message) || String(e));
    }
    break;
  }
  case 'import-lg': {
    const ioBookKey = typeof flags.book === 'string' ? flags.book : '';
    const ioBook = store.getBook(ioBookKey);
    if (!ioBook) { log.error(`book 不存在：${ioBookKey || '(缺 --book)'}`); break; }
    if (typeof flags.txt !== 'string' || flags.txt === 'true' || typeof flags.manifest !== 'string' || flags.manifest === 'true') {
      log.error('用法: import-lg --book <key> --txt <LG结果.txt> --manifest <清单.json> [--apply] [--limit N]（不带 --apply 只校验）');
      break;
    }
    if (flags.apply === true && jobQueue.busy()) { log.error('有翻译任务正在运行（单队列占用中），请等它结束再导入'); break; }
    const ioClient = makeClient(ioBook);
    const ioLines = splitResultLines(fs.readFileSync(path.resolve(flags.txt), 'utf8'));
    const ioManifest = JSON.parse(fs.readFileSync(path.resolve(flags.manifest), 'utf8'));
    const ioReport = await verifyImport({
      resultLines: ioLines,
      manifest: ioManifest,
      getChapter: (chapterId, volumeId) => ioClient.getChapterTask(ioBook, chapterId, 'gpt', volumeId),
    });
    if (ioReport.globalError) { log.error(ioReport.globalError); break; }
    for (const c of ioReport.chapters) {
      log.log(`  ${c.ok ? '✓' : '✗'} ${c.title || c.chapterId}（${c.count} 段）${c.ok ? '' : '：' + c.reason}`);
    }
    log.log(`校验：${ioReport.okCount}/${ioReport.total} 章通过；疑似未翻译 ${ioReport.untranslated} 行`);
    if (flags.apply !== true) { log.log('dry-run：未提交（加 --apply 上传到 gpt 端）'); break; }
    const applied = await applyImportReport(ioClient, ioBook, ioReport, {
      limit: Math.max(0, Number(flags.limit) || 0),
      onProgress: (n, c) => log.log(`  已提交 ${n}：${c.title || c.chapterId}`),
    });
    for (const r of applied.results) {
      if (r.status === 'failed') log.error(`  提交失败：${r.title || r.chapterId}：${r.error}`);
    }
    log.log(`提交完成：成功 ${applied.uploaded}，失败 ${applied.failed}，未过校验 ${ioReport.total - ioReport.okCount}`);
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
    // 端口：--port 旗标 > config.serve.port > 7331；实际端口写 .serve-port 供托盘/脚本探测
    const cfgServe = store.getConfig('serve') || {};
    const port = Math.max(1, Number(flags.port) || Number(cfgServe.port) || 7331);
    try { fs.writeFileSync(path.join(here, '.serve-port'), String(port), 'utf8'); } catch { }
    await startServer({ store, pipeline, glossaryPipeline, checkPipeline, scheduler, agentScheduler, queue: jobQueue, makeClient, engine, agentLoop, agentEvents, port, log, lgImportRunner });
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
    const ag = agentScheduler.stats();
    const agExplicit = (store.getConfig('agent') || {}).workers || [];
    log.log(`llm(助手/术语池): maxInFlight=${ag.maxInFlight} workers=${ag.workers}${agExplicit.length > 0 ? `（显式 ${agExplicit.length} 个）` : '（跟随翻译池）'} 请求=${ag.requests} 在途峰值=${ag.maxObservedInFlight}`);
    const u = store.usageTotals();
    log.log(`usage: 轮次=${u.rows} 请求=${u.requests} prompt=${u.promptTokens} completion=${u.completionTokens}`);
    const px = normalizeProxyConfig(getProxy());
    log.log(`proxy: ${px.enabled && px.url ? `已启用 ${px.url}（直连列表 ${px.noProxy}）` : '未启用（全部直连）'}`);
    log.log('控制台: node daemon/index.mjs serve 后打开 http://127.0.0.1:7331/ui（设置/规则/提示词/任务都在页面里）');
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
    log.error(`未知命令: ${command}（可用 auth/add/export-src/import-lg/run/check/rules/prompt/glossary-io/agent/translate/watch/serve/status/forget）`);
    process.exit(2);
}
