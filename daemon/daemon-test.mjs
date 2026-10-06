// daemon/daemon-test.mjs —— 翻译 worker 冒烟（对 mock：需 PORT=8790 node mock-llm/server.mjs）
// 覆盖：全管线上传/站点跳过/断点续跑/段缓存复用/控制面
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOCK = process.env.MOCK_ORIGIN || 'http://127.0.0.1:8790';
const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(here, '.test.db');
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suffix); } catch { } }

const imp = (name) => import(pathToFileURL(path.join(here, name)).href);
const { Store } = await imp('store.mjs');
const { loadEngine, repoRoot } = await imp('engine.mjs');
const { SiteClient } = await imp('site-client.mjs');
const { TranslationPipeline } = await imp('translate-pipeline.mjs');
const { GlossaryPipeline } = await imp('glossary-pipeline.mjs');
const { CheckPipeline } = await imp('check-pipeline.mjs');
const { createAgentLlm } = await imp('agent-llm.mjs');
const { createAgentLoop } = await imp('agent-loop.mjs');
const { doingTool, askUserTool } = await imp('agent-tools.mjs');
const { createReadTools } = await imp('agent-tools-read.mjs');
const { createWriteTools } = await imp('agent-tools-write.mjs');
const { createSkillCatalog } = await imp('agent-skills.mjs');
const { createAgentEvents } = await imp('agent-events.mjs');
const { createJobQueue } = await imp('job-queue.mjs');
const { parseLgGlossary, planImport, applyImport, toLgGlossary } = await imp('glossary-io.mjs');
const { collectChapters, buildSourceExport, manifestOf, splitResultLines, verifyImport } = await imp('lg-align.mjs');
const { createWorkspaceTools } = await imp('agent-workspace.mjs');
const { LlmScheduler } = await imp('scheduler.mjs');
const { startServer } = await imp('server.mjs');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { pass++; console.log('  ok  ' + name); })
        .catch((e) => { fail++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); });
    }
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message));
  }
  return Promise.resolve();
};

const store = new Store(TEST_DB);
const engine = await loadEngine();
const RUN = Date.now().toString(36);   // 每次运行独立书 id：对暖 mock 幂等
const TRANS_BOOK = `mock-trans-${RUN}`;
const TRANS_R_BOOK = `mock-trans-r-${RUN}`;
const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: `${MOCK}/v1`, key: 'x' }];
store.setConfig('token', 'test-token');
store.setConfig('workers', workers);
const makeClient = (book) => new SiteClient({ origin: book.origin || MOCK, token: store.getConfig('token'), engine });
const mkPipeline = (options) => new TranslationPipeline({
  store, engine, workers, makeClient,
  log: { log: () => { }, error: () => { } },
  options: { level: 'expire', concurrency: 2, ...options },
});

console.log('== 全管线：expire 档翻译 + 站点跳过 ==');
let run1 = null;
await t('runBook：t1/t2 翻译上传、t3（已用当前术语表）被跳过', async () => {
  store.upsertBook({ key: `web:mock/${TRANS_BOOK}`, kind: 'web', providerId: 'mock', novelId: TRANS_BOOK, origin: MOCK, title: '' });
  run1 = await mkPipeline({}).runBook(`web:mock/${TRANS_BOOK}`);
  assert.equal(run1.stats.uploaded, 2, JSON.stringify(run1.stats));
  assert.equal(run1.stats.targets, 2, 't3 在任务 toc 上已是当前术语表 → 不进入目标');
  assert.ok(run1.stats.requests >= 2);
});
await t('上传体：章节段落数正确、带当前 glossaryId、内容来自翻译协议', async () => {
  const stats = await fetch(`${MOCK}/__stats`).then((r) => r.json());
  const up = stats.lastChapterUpload;
  assert.ok(up && up.chapterId === 't2', JSON.stringify(up));
  assert.equal(up.glossaryId, 'g-current');
  assert.equal(up.count, 4, 't2 为 4 段');
  assert.ok(String(up.preview[0]).includes('模拟译'), up.preview[0]);
});
await t('进度与段缓存落库', () => {
  const progress = store.listProgress(`web:mock/${TRANS_BOOK}`);
  assert.equal(progress.length, 2);
  assert.ok(progress.every((p) => p.state === 'done' && p.glossaryUuid === 'g-current'));
  assert.ok(store.segCount(`web:mock/${TRANS_BOOK}`) >= 2);
});
await t('重跑：toc 已标记当前术语表 → 无目标、零请求', async () => {
  const run2 = await mkPipeline({}).runBook(`web:mock/${TRANS_BOOK}`);
  assert.equal(run2.stats.uploaded, 0);
  assert.equal(run2.stats.targets, 0);
  assert.equal(run2.stats.requests, 0);
});

console.log('== 断点续跑：maxChapters 中途停止 → 再跑只补剩余 ==');
await t('首个半程：只上传 1 章（停止时后续章不进入）', async () => {
  store.upsertBook({ key: `web:mock/${TRANS_R_BOOK}`, kind: 'web', providerId: 'mock', novelId: TRANS_R_BOOK, origin: MOCK, title: '' });
  const half = await mkPipeline({ maxChapters: 1 }).runBook(`web:mock/${TRANS_R_BOOK}`);
  assert.equal(half.stats.uploaded, 1, JSON.stringify(half.stats));
});
await t('续跑：仅补剩余 2 章，段缓存复用（已完成章的段不再请求）', async () => {
  const rest = await mkPipeline({}).runBook(`web:mock/${TRANS_R_BOOK}`);
  assert.equal(rest.stats.uploaded, 2, JSON.stringify(rest.stats));
  const again = await mkPipeline({}).runBook(`web:mock/${TRANS_R_BOOK}`);
  assert.equal(again.stats.uploaded, 0);
  assert.equal(again.stats.requests, 0, '全部完成 + toc 已当前 → 零请求');
});

console.log('== 调度器（P1：全局并发门 / key 池 / 限流 / 用量） ==');
const quiet = { log: () => { }, error: () => { } };
const mkW = (id, key, extra = '') => ({ id, model: 'mock-glossary-1', endpoint: `${MOCK}/v1${extra}`, key });
const mockStats = () => fetch(`${MOCK}/__stats`).then((r) => r.json());
const resetMock = () => fetch(`${MOCK}/v1/chat/completions?reset=1`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer reset-key' },
  body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'reset' }] }),
});
const HELLO = [{ role: 'user', content: 'hello' }];

await t('调度器：全局并发峰值 = 1（5 个并发请求）', async () => {
  await resetMock();
  const sch = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW('s1', 'sk1', '?slow=250')], maxInFlight: 1, transportRetries: 0 } });
  await Promise.all(Array.from({ length: 5 }, () => sch.call(HELLO)));
  const stats = await mockStats();
  assert.equal(stats.maxInflight, 1, JSON.stringify({ maxInflight: stats.maxInflight }));
  assert.equal(sch.stats().maxObservedInFlight, 1);
});
await t('调度器：对照组 maxInFlight=2 时峰值为 2（探针有效）', async () => {
  await resetMock();
  const sch = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW('s2', 'sk2', '?slow=250')], maxInFlight: 2, transportRetries: 0 } });
  await Promise.all(Array.from({ length: 4 }, () => sch.call(HELLO)));
  const stats = await mockStats();
  assert.equal(stats.maxInflight, 2, JSON.stringify({ maxInflight: stats.maxInflight }));
});
await t('调度器：key 冷却轮换（k1 被限流 → 重试换 k2）', async () => {
  await resetMock();
  const sch = new LlmScheduler({
    engine, store, log: quiet,
    options: { workers: [mkW('a', 'k1', '?failkey=k1&fail=429ra&n=1'), { ...mkW('b', 'k2', '?failkey=k1&fail=429ra&n=1') }], maxInFlight: 1, transportRetries: 1, cooldownSteps: [60000] },
  });
  const res = await sch.call(HELLO);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.workerId, 'b', '限流后应换到 k2');
  const stats = await mockStats();
  assert.equal(stats.keys.k1, 1, JSON.stringify(stats.keys));
  assert.equal(stats.keys.k2, 1, JSON.stringify(stats.keys));
  assert.equal(sch.stats().byWorker.a.failures, 1, JSON.stringify(sch.stats().byWorker));
});
await t('调度器：遵循 Retry-After（429ra 一次 → 等待后重试成功）', async () => {
  const sch = new LlmScheduler({
    engine, store, log: quiet,
    options: { workers: [mkW('r', 'rk', '?fail=429ra&n=1')], maxInFlight: 1, transportRetries: 2, cooldownSteps: [1500] },
  });
  const t0 = Date.now();
  const res = await sch.call(HELLO);
  const ms = Date.now() - t0;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(ms >= 900, `应等待 Retry-After（实测 ${ms}ms）`);
  assert.equal(sch.stats().transportRetries, 1, JSON.stringify(sch.stats()));
});
await t('调度器：传输重试耗尽即失败（不无限重试）', async () => {
  const sch = new LlmScheduler({
    engine, store, log: quiet,
    options: { workers: [mkW('x', 'xk', '?fail=429ra')], maxInFlight: 1, transportRetries: 1, cooldownSteps: [800] },
  });
  const res = await sch.call(HELLO);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(/429/.test(res.error || ''), JSON.stringify(res));
  assert.equal(sch.stats().transportRetries, 1, JSON.stringify(sch.stats()));
});
await t('调度器：RPM 节流（120 rpm → 两次派发间隔 ≥ 0.35s）', async () => {
  const sch = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW('p', 'pk')], maxInFlight: 1, rpm: 120 } });
  await sch.call(HELLO);
  const t0 = Date.now();
  await sch.call(HELLO);
  const ms = Date.now() - t0;
  assert.ok(ms >= 350, `节流未生效（实测 ${ms}ms）`);
});
await t('调度器：提示词超限（严格模式直接失败、不发请求）', async () => {
  await resetMock();
  const before = (await mockStats()).requests;
  const sch = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW('g', 'gk')], maxInFlight: 1, maxPromptChars: 100, strictPrompt: true } });
  const res = await sch.call([{ role: 'user', content: 'x'.repeat(500) }]);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(/prompt-too-long/.test(res.error || ''), JSON.stringify(res));
  assert.equal((await mockStats()).requests, before, '严格模式不应发出请求');
  assert.ok(sch.stats().promptTooLong >= 1);
});
await t('调度器：用量按 run 落库（usage 表）', async () => {
  const bookKey = `web:mock/mock-trans-u-${RUN}`;
  store.upsertBook({ key: bookKey, kind: 'web', providerId: 'mock', novelId: `mock-trans-u-${RUN}`, origin: MOCK, title: '' });
  const p = mkPipeline({});
  await p.runBook(bookKey);
  const rows = store.usageSummary(bookKey);
  assert.ok(rows.length >= 1 && rows[0].requests > 0 && rows[0].promptTokens > 0, JSON.stringify(rows));
  const totals = store.usageTotals(bookKey);
  assert.ok(totals.rows >= 1 && totals.requests > 0, JSON.stringify(totals));
});
await t('控制面：/auth 热更新 workers、/run 单队列串行', async () => {
  const sch = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW('z', 'zk')], maxInFlight: 1 } });
  const server = await startServer({ store, pipeline: mkPipeline({}), glossaryPipeline: null, scheduler: sch, port: 7346, log: quiet });
  const auth = await fetch('http://127.0.0.1:7346/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'test-token', workers: [mkW('h1', 'hk1'), mkW('h2', 'hk2')] }),
  }).then((r) => r.json());
  assert.equal(auth.workers, 2);
  assert.equal(sch.stats().workers, 2, '热更新立即生效');
  const bookKey = `web:mock/${TRANS_BOOK}`;
  const post = (b) => fetch('http://127.0.0.1:7346/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then((r) => r.json());
  const r1 = await post({ bookKey, job: 'translate' });
  const r2 = await post({ bookKey, job: 'translate' });
  assert.ok(r1.id > 0 && r2.id > r1.id, JSON.stringify({ r1, r2 }));
  let states = [];
  for (let i = 0; i < 100; i += 1) {
    const list = await fetch('http://127.0.0.1:7346/runs').then((r) => r.json());
    const items = list.runs.filter((x) => x.id === r1.id || x.id === r2.id);
    if (items.length === 2 && items.every((x) => x.state === 'done' || x.state === 'failed')) { states = items.map((x) => x.state); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(states.length, 2, '两个 run 都应到达终态（队列串行执行）');
  server.close();
});

console.log('== 质检（check job） ==');
const CHECK_KEY = `web:mock/mock-check-${RUN}`;
await t('check：mock-check 出报告（七码计数与样例）', async () => {
  store.upsertBook({ key: CHECK_KEY, kind: 'web', providerId: 'mock', novelId: `mock-check-${RUN}`, origin: MOCK, title: '' });
  const cp = new CheckPipeline({ store, engine, makeClient, log: quiet });
  const r = await cp.runBook(CHECK_KEY);
  assert.equal(r.stats.pairs, 6, JSON.stringify(r.stats));
  assert.deepEqual(r.stats.codes, {
    GLOSSARY: 1,
    FOREIGN_CHAR_RESIDUE: 1,
    SIMILARITY: 1,
    PUNCTUATION_MISMATCH: 1,
    LINE_COUNT_MISMATCH: 1,
  }, JSON.stringify(r.stats.codes));
  assert.ok(r.stats.samples.length >= 5, JSON.stringify(r.stats.samples.length));
  const runs = store.listRuns(10).filter((x) => x.job === 'check');
  assert.ok(runs.length >= 1 && runs[0].stats.codes, JSON.stringify(runs.map((x) => x.job)));
});
await t('check：--propose 出 quality 提案、--codes 过滤', async () => {
  const cp = new CheckPipeline({ store, engine, makeClient, log: quiet });
  const r = await cp.runBook(CHECK_KEY, { options: { propose: true, codes: ['GLOSSARY'], limit: 10 } });
  assert.deepEqual(r.stats.codes, { GLOSSARY: 1 }, JSON.stringify(r.stats.codes));
  assert.ok(r.proposalId > 0, JSON.stringify(r));
  assert.ok(store.listProposals(CHECK_KEY).some((x) => x.kind === 'quality'));
});
await t('控制面：/run 支持 job=check', async () => {
  const cp = new CheckPipeline({ store, engine, makeClient, log: quiet });
  const server = await startServer({ store, pipeline: null, glossaryPipeline: null, checkPipeline: cp, scheduler: null, port: 7347, log: quiet });
  const r = await fetch('http://127.0.0.1:7347/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookKey: CHECK_KEY, job: 'check' }),
  }).then((x) => x.json());
  assert.equal(r.job, 'check', JSON.stringify(r));
  let state = '';
  for (let i = 0; i < 60; i += 1) {
    const list = await fetch('http://127.0.0.1:7347/runs').then((x) => x.json());
    const item = list.runs.find((x) => x.id === r.id);
    if (item && (item.state === 'done' || item.state === 'failed')) { state = item.state; break; }
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(state, 'done');
  server.close();
});

console.log('== 文本处理链（P3：规则接线） ==');
await t('后替换规则在翻译落库前生效（【模拟译】→【译】）', async () => {
  const key = `web:mock/mock-trans-proc-${RUN}`;
  store.upsertBook({ key, kind: 'web', providerId: 'mock', novelId: `mock-trans-proc-${RUN}`, origin: MOCK, title: '' });
  const ruleId = store.addRule({ bookKey: '', kind: 'post_replacement', pattern: '【模拟译】', replacement: '【译】', regex: 0, enabled: 1, priority: 10 });
  try {
    const p = mkPipeline({});
    const r = await p.runBook(key);
    assert.ok(r.stats.uploaded >= 1, JSON.stringify(r.stats));
    const stats = await mockStats();
    const preview = (stats.lastChapterUpload && stats.lastChapterUpload.preview) || [];
    assert.ok(preview.length > 0 && preview.every((line) => line.includes('【译】') && !line.includes('【模拟译】')), JSON.stringify(preview));
  } finally {
    store.deleteRule(ruleId);
  }
});
console.log('== 提示词模板（P4） ==');
await t('全局 base 覆盖生效（协议段仍由代码注入），clear 后回默认', async () => {
  const key = `web:mock/mock-trans-prompt-${RUN}`;
  store.upsertBook({ key, kind: 'web', providerId: 'mock', novelId: `mock-trans-prompt-${RUN}`, origin: MOCK, title: '' });
  store.setPrompt('', 'base', '【自定义风格】{format_rules}');
  try {
    await mkPipeline({}).runBook(key);
    const stats = await mockStats();
    assert.ok(stats.lastTranslate.system.includes('【自定义风格】'), stats.lastTranslate.system);
    assert.ok(stats.lastTranslate.system.includes('行数必须要和原文相等'), stats.lastTranslate.system);
  } finally {
    store.clearPrompt('', 'base');
  }
  const key2 = `web:mock/mock-trans-prompt2-${RUN}`;
  store.upsertBook({ key: key2, kind: 'web', providerId: 'mock', novelId: `mock-trans-prompt2-${RUN}`, origin: MOCK, title: '' });
  await mkPipeline({}).runBook(key2);
  const stats2 = await mockStats();
  assert.ok(!stats2.lastTranslate.system.includes('【自定义风格】'), stats2.lastTranslate.system);
  assert.ok(stats2.lastTranslate.system.includes('轻小说翻译者'), stats2.lastTranslate.system);
});
await t('thinking 槽注入用户消息（mock 侧可见）', async () => {
  const key = `web:mock/mock-trans-prompt3-${RUN}`;
  store.upsertBook({ key, kind: 'web', providerId: 'mock', novelId: `mock-trans-prompt3-${RUN}`, origin: MOCK, title: '' });
  store.setPrompt('', 'thinking', '先在心里分析，不要输出分析过程。');
  try {
    await mkPipeline({}).runBook(key);
    const stats = await mockStats();
    assert.ok(stats.lastTranslate.userHead.includes('思考指引'), stats.lastTranslate.userHead);
    assert.ok(stats.lastTranslate.userHead.includes('#1:'), stats.lastTranslate.userHead);
  } finally {
    store.clearPrompt('', 'thinking');
  }
});

console.log('== LG 术语表互通（P5） ==');
const IMPORT_KEY = `web:mock/mock-import-${RUN}`;
await t('import：分辨率/门槛/regex 分流；dry-run 不写站点', async () => {
  const book = { key: IMPORT_KEY, kind: 'web', providerId: 'mock', novelId: `mock-import-${RUN}`, origin: MOCK, title: '' };
  store.upsertBook(book);
  const client = makeClient(book);
  const file = path.join(here, '.tmp-lg-import.json');
  fs.writeFileSync(file, JSON.stringify([
    { src: 'アルテ', dst: '阿尔蒂', info: '女性' },
    { src: 'ローズ', dst: '罗丝琳', info: '女性', case_sensitive: true },
    { src: 'rem0', dst: 'XX', info: '' },
    { src: 'レ.*ス', dst: '替换', regex: true },
  ]), 'utf8');
  try {
    const parsed = parseLgGlossary(fs.readFileSync(file, 'utf8'));
    const current = await client.getGlossary(book);
    const plan = planImport({ entries: parsed.entries, currentGlossary: current, engine });
    assert.equal(plan.additions.length, 2, JSON.stringify(plan));
    assert.equal(plan.skipped.length, 1, JSON.stringify(plan.skipped));
    assert.equal(plan.regexRules.length, 1, JSON.stringify(plan.regexRules));
    const stats = await mockStats();
    assert.notEqual(stats.lastGlossaryPut && stats.lastGlossaryPut.path, `/api/novel/mock/mock-import-${RUN}/glossary`, 'dry-run 不应写站点');
  } finally {
    fs.unlinkSync(file);
  }
});
await t('import：apply 快照 + PUT + 回读校验（值带 #备注）', async () => {
  const book = store.getBook(IMPORT_KEY);
  const client = makeClient(book);
  const file = path.join(here, '.tmp-lg-import2.json');
  fs.writeFileSync(file, JSON.stringify([
    { src: 'アルテ', dst: '阿尔蒂', info: '女性' },
    { src: 'ローズ', dst: '罗丝琳', info: '女性', case_sensitive: true },
  ]), 'utf8');
  try {
    const parsed = parseLgGlossary(fs.readFileSync(file, 'utf8'));
    const current = await client.getGlossary(book);
    const plan = planImport({ entries: parsed.entries, currentGlossary: current, engine });
    const result = await applyImport({ store, client, book, plan, currentGlossary: current, note: 'e2e' });
    assert.equal(result.applied, 2, JSON.stringify(result));
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.ok(store.listSnapshots(IMPORT_KEY).length >= 1);
    const stats = await mockStats();
    assert.equal(stats.lastGlossaryPut.body['アルテ'], '阿尔蒂 #女性', JSON.stringify(stats.lastGlossaryPut.body));
  } finally {
    fs.unlinkSync(file);
  }
});
await t('export：现术语表 → LG JSON，往返导入 diff 为空', async () => {
  const book = store.getBook(IMPORT_KEY);
  const client = makeClient(book);
  const current = await client.getGlossary(book);
  const list = toLgGlossary(current, engine);
  const alice = list.find((x) => x.src === 'アルテ');
  assert.ok(alice && alice.dst === '阿尔蒂' && alice.info === '女性', JSON.stringify(list));
  const { entries } = parseLgGlossary(JSON.stringify(list));
  const plan = planImport({ entries, currentGlossary: current, engine });
  assert.equal(plan.additions.length + plan.updates.length, 0, JSON.stringify(plan));
});

console.log('== 控制台 GUI（/ui + 设置/规则/提示词/书籍 CRUD + CORS 白名单） ==');
await t('/ui 返回页面；设置读写热更新调度器', async () => {
  const sch = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW('u1', 'uk1')], maxInFlight: 1 } });
  const server = await startServer({ store, pipeline: mkPipeline({}), glossaryPipeline: null, checkPipeline: null, scheduler: sch, port: 7348, log: quiet });
  try {
    const ui = await fetch('http://127.0.0.1:7348/ui');
    assert.equal(ui.status, 200);
    assert.ok((await ui.text()).includes('NTR Daemon'), '页面内容');
    const settings = await fetch('http://127.0.0.1:7348/settings').then((r) => r.json());
    assert.equal(settings.ok, true);
    assert.ok(Array.isArray(settings.settings.workers) && settings.settings.workers[0].key.includes('…'), JSON.stringify(settings.settings.workers));
    const saved = await fetch('http://127.0.0.1:7348/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { maxInFlight: 3, transportRetries: 2, maxPromptChars: 9000, strictPrompt: false, rpm: 0 } }),
    }).then((r) => r.json());
    assert.equal(saved.ok, true);
    assert.equal(sch.stats().maxInFlight, 3, '调度器热更新');
    assert.equal(store.getConfig('llm').maxPromptChars, 9000);
  } finally { server.close(); }
});
await t('规则 / 提示词 / 书籍 的 HTTP CRUD', async () => {
  const server = await startServer({ store, pipeline: mkPipeline({}), glossaryPipeline: null, checkPipeline: null, scheduler: null, port: 7349, log: quiet });
  const base = 'http://127.0.0.1:7349';
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const added = await post('/rules', { action: 'add', kind: 'post_replacement', pattern: 'GUI_X', replacement: 'GUI_Y' });
    assert.ok(added.id > 0);
    let rules = (await fetch(base + '/rules').then((r) => r.json())).rules;
    assert.ok(rules.some((x) => x.id === added.id && x.enabled === 1));
    await post('/rules', { action: 'toggle', id: added.id, enabled: false });
    rules = (await fetch(base + '/rules').then((r) => r.json())).rules;
    assert.equal(rules.find((x) => x.id === added.id).enabled, 0);
    await post('/rules', { action: 'delete', id: added.id });
    rules = (await fetch(base + '/rules').then((r) => r.json())).rules;
    assert.ok(!rules.some((x) => x.id === added.id));

    await post('/prompts', { bookKey: '', slot: 'base', text: '界面风格。{format_rules}' });
    const prompts = await fetch(base + '/prompts?book=').then((r) => r.json());
    assert.ok(prompts.rows.some((x) => x.slot === 'base' && x.text.includes('界面风格')));
    assert.ok(prompts.formatRules && prompts.defaults.base.includes('{format_rules}'));
    await post('/prompts', { action: 'clear', bookKey: '', slot: 'base' });
    assert.ok(!(await fetch(base + '/prompts?book=').then((r) => r.json())).rows.some((x) => x.slot === 'base'));

    const bad = await post('/prompts', { bookKey: '', slot: 'nope', text: 'x' });
    assert.equal(bad.ok, false, '非法 slot 拒绝');

    const bookAdded = await post('/books', { action: 'add', url: 'https://n.novelia.cc/novel/syosetu/n0000gui' });
    assert.equal(bookAdded.key, 'web:syosetu/n0000gui');
    assert.ok(store.getBook('web:syosetu/n0000gui'), '登记落库');
    await post('/books', { action: 'forget', key: 'web:syosetu/n0000gui' });
    assert.equal(store.getBook('web:syosetu/n0000gui'), null, '忘记生效');
  } finally { server.close(); }
});
await t('CORS 白名单：站点/本机放行，其它 Origin 的写请求 403', async () => {
  const server = await startServer({ store, pipeline: mkPipeline({}), glossaryPipeline: null, checkPipeline: null, scheduler: null, port: 7350, log: quiet });
  const base = 'http://127.0.0.1:7350';
  try {
    const allowed = await fetch(base + '/settings', { headers: { Origin: 'https://n.novelia.cc' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://n.novelia.cc');
    const denied = await fetch(base + '/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}',
    });
    assert.equal(denied.status, 403, JSON.stringify(await denied.json()));
    const pre = await fetch(base + '/run', {
      method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(pre.status, 403);
    const okRead = await fetch(base + '/ui');
    assert.equal(okRead.status, 200, '同源/无 Origin 直连不受影响');
  } finally { server.close(); }
});

console.log('== Agent（A1：循环 / 工具派发 / 审批 / 中止，真实 HTTP） ==');
await t('agent：模型返回 tool_calls → 执行工具 → 最终答复（用量落库、mock 记录 tools 请求体）', async () => {
  const scheduler = new LlmScheduler({
    engine, store, log: quiet,
    options: { workers: [mkW('ag1', 'agkey1', `?toolcall=doing&toolargs=${encodeURIComponent('{"text":"mock 进度"}')}`)], maxInFlight: 1 },
  });
  const llm = createAgentLlm({ scheduler, log: quiet });
  const loop = createAgentLoop({ store, chat: llm.chat, takeUsage: llm.takeUsage, tools: [doingTool], log: quiet });
  const sessionId = store.createAgentSession({ bookKey: '', title: 'e2e' });
  const events = [];
  const r = await loop.runTurn(sessionId, '打个招呼', { onEvent: (e) => events.push(e) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(String(r.content).includes('完成（mock）'), r.content);
  const stats = await mockStats();
  assert.equal(stats.lastToolTurn.hasTools, true, JSON.stringify(stats.lastToolTurn));
  assert.ok(stats.lastTools.includes('doing'), JSON.stringify(stats.lastTools));
  assert.equal(stats.lastToolCall.name, 'doing');
  const doingEvent = events.find((e) => e.type === 'doing');
  assert.ok(doingEvent && doingEvent.text === 'mock 进度', JSON.stringify(events.map((e) => e.type)));
  const roles = store.listAgentMessages(sessionId).map((x) => x.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant'], JSON.stringify(roles));
  assert.ok(store.agentSessionUsage(sessionId).requests >= 1, JSON.stringify(store.agentSessionUsage(sessionId)));
});
await t('agent：审批 allow → 执行；reject → approval_denied 且不执行', async () => {
  let executed = 0;
  const writeTool = {
    name: 'write_probe', description: '写探针', parameters: { type: 'object', properties: {} },
    requiresApproval: true, preview: () => ({ diff: 'probe' }),
    async execute() { executed += 1; return { ok: true, wrote: 1 }; },
  };
  const scheduler = new LlmScheduler({
    engine, store, log: quiet,
    options: { workers: [mkW('ag2', 'agkey2', '?toolcall=write_probe')], maxInFlight: 1 },
  });
  const llm = createAgentLlm({ scheduler, log: quiet });
  const loop = createAgentLoop({ store, chat: llm.chat, takeUsage: llm.takeUsage, tools: [writeTool], log: quiet });
  const allowSession = store.createAgentSession({ bookKey: '', title: 'allow' });
  const allowEvents = [];
  await loop.runTurn(allowSession, '写一下', {
    onEvent: (e) => { allowEvents.push(e.type); if (e.type === 'decision') setTimeout(() => loop.resolveDecision(e.decisionId, 'allowed'), 0); },
  });
  assert.equal(executed, 1, JSON.stringify(allowEvents));
  const rejectSession = store.createAgentSession({ bookKey: '', title: 'reject' });
  await loop.runTurn(rejectSession, '再写', {
    onEvent: (e) => { if (e.type === 'decision') setTimeout(() => loop.resolveDecision(e.decisionId, 'rejected'), 0); },
  });
  assert.equal(executed, 1, '拒绝后不应执行');
  const toolRow = store.listAgentMessages(rejectSession).find((x) => x.role === 'tool');
  assert.ok(toolRow.content.includes('approval_denied'), toolRow.content);
  assert.ok(!allowEvents.includes('question'));
});
await t('agent：stop() 中止挂起中的追问（decision 取消 + 轮次 aborted）', async () => {
  const scheduler = new LlmScheduler({
    engine, store, log: quiet,
    options: { workers: [mkW('ag3', 'agkey3', '?toolcall=ask_user&toolargs=' + encodeURIComponent('{"question":"选哪个？","options":[{"id":"a","label":"A"}]}'))], maxInFlight: 1 },
  });
  const llm = createAgentLlm({ scheduler, log: quiet });
  const loop = createAgentLoop({ store, chat: llm.chat, takeUsage: llm.takeUsage, tools: [askUserTool], log: quiet });
  const sessionId = store.createAgentSession({ bookKey: '', title: 'abort' });
  let questionId = null;
  const pending = loop.runTurn(sessionId, '问一下', { onEvent: (e) => { if (e.type === 'question') questionId = e.decisionId; } });
  for (let i = 0; i < 50 && questionId === null; i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.ok(questionId, '应产生提问');
  assert.equal(loop.stop(sessionId), true);
  const r = await pending;
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(/abort/i.test(r.error), JSON.stringify(r));
  assert.equal(store.getPendingAgentDecision(sessionId), null, '决定应被取消');
  assert.equal(store.getAgentSession(sessionId).state, 'idle');
});

console.log('== Agent 只读工具（A2：技能目录 + 书/正文/译文/质检，真实 HTTP） ==');
const readToolSet = [...createReadTools({ store, engine, makeClient, log: quiet }), doingTool, askUserTool];
const skillCatalog = createSkillCatalog({ roots: [path.join(repoRoot, 'skills')], log: quiet });
const runToolOnce = async (toolName, args, { books = null } = {}) => {
  const q = `?toolcall=${toolName}&toolargs=${encodeURIComponent(JSON.stringify(args || {}))}`;
  const scheduler = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW(`rt-${toolName}`, 'rtkey', q)], maxInFlight: 1 } });
  const llm = createAgentLlm({ scheduler, log: quiet });
  const loop = createAgentLoop({
    store, chat: llm.chat, takeUsage: llm.takeUsage, tools: readToolSet, log: quiet,
    options: { deps: { engine, makeClient, skills: skillCatalog } },
  });
  const sessionId = store.createAgentSession({ bookKey: '', title: `tool:${toolName}` });
  const r = await loop.runTurn(sessionId, `执行 ${toolName}`, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  const toolRow = store.listAgentMessages(sessionId).find((x) => x.role === 'tool');
  const parsed = JSON.parse(toolRow.content);
  if (books) assert.ok(parsed.ok === true, JSON.stringify(parsed));
  return parsed;
};
await t('list_books：返回已登记书目（含 key/进度）', async () => {
  const parsed = await runToolOnce('list_books', {}, { books: true });
  assert.ok(parsed.result.count >= 1, JSON.stringify(parsed));
  assert.ok(parsed.result.books.some((b) => b.key === `web:mock/${TRANS_BOOK}`), JSON.stringify(parsed.result.books.map((b) => b.key)));
});
await t('read_book：文库逐章取文并按行窗口返回（带总行数/截断标记）', async () => {
  store.upsertBook({ key: 'wenku:mock-src', kind: 'wenku', providerId: '', novelId: 'mock-src', origin: MOCK, title: '' });
  const parsed = await runToolOnce('read_book', { book: 'wenku:mock-src', offset: 0, limit: 5, maxChars: 4000 }, { books: true });
  assert.ok(parsed.result.totalLines >= 30, JSON.stringify(parsed.result));
  assert.equal(parsed.result.lines[0].n, 1);
  assert.ok(parsed.result.lines[0].text.includes('アリス'), JSON.stringify(parsed.result.lines[0]));
  assert.ok(parsed.result.count >= 1 && parsed.result.count <= 5);
});
await t('read_translations：返回对齐对窗口（原文+译文）', async () => {
  const parsed = await runToolOnce('read_translations', { book: 'wenku:mock-src', offset: 0, limit: 3 }, { books: true });
  assert.ok(parsed.result.total >= 20, JSON.stringify(parsed.result));
  assert.equal(parsed.result.pairs.length, 3);
  assert.ok(parsed.result.pairs[0].jp && parsed.result.pairs[0].zh, JSON.stringify(parsed.result.pairs[0]));
});
await t('quality_report：对 mock-check 出七码报告（只读）', async () => {
  const parsed = await runToolOnce('quality_report', { book: CHECK_KEY, limit: 5 }, { books: true });
  assert.ok(parsed.result.codes.GLOSSARY >= 1, JSON.stringify(parsed.result.codes));
  assert.ok(parsed.result.samples.length >= 1);
});
await t('read_skill / list_skills：技能目录注入与读取（含 references 防护）', async () => {
  const list = await runToolOnce('list_skills', {}, { books: true });
  assert.ok(list.result.skills.some((s) => s.name === 'glossary-workflow'), JSON.stringify(list.result.skills.map((s) => s.name)));
  const read = await runToolOnce('read_skill', { name: 'glossary-workflow' }, { books: true });
  assert.ok(read.result.content.includes('写入门槛'), read.result.content.slice(0, 200));
  const escape = await runToolOnce('read_skill', { name: 'glossary-workflow', path: '../x' });
  assert.equal(escape.ok, false, JSON.stringify(escape));
  assert.equal(escape.error, 'bad_path');
});
await t('list_snapshots：返回某书快照列表', async () => {
  store.upsertBook({ key: 'wenku:mock-boost', kind: 'wenku', providerId: '', novelId: 'mock-boost', origin: MOCK, title: '' });
  store.addSnapshot('wenku:mock-boost', { 'テスト': '测试' }, 'a2-e2e');
  const parsed = await runToolOnce('list_snapshots', { book: 'wenku:mock-boost' }, { books: true });
  assert.ok(parsed.result.count >= 1, JSON.stringify(parsed.result));
});

console.log('== Agent 执行/写入工具（A3：审批 + 单队列 + 快照/回读） ==');
const writeTools = createWriteTools();
const qTranslate = mkPipeline({});
const qCheck = new CheckPipeline({ store, engine, makeClient, log: quiet });
const qGlossary = new GlossaryPipeline({ store, engine, workers, makeClient, log: quiet });
const agentQueue = createJobQueue({
  resolveRunner: (job) => ({ translate: qTranslate, check: qCheck, glossary: qGlossary }[job]),
  log: quiet,
});
const agentSkills = createSkillCatalog({ roots: [path.join(repoRoot, 'skills')], log: quiet });
const runWriteToolOnce = async (toolName, args, { approve = true, tools = writeTools } = {}) => {
  const q = `?toolcall=${toolName}&toolargs=${encodeURIComponent(JSON.stringify(args))}`;
  const scheduler = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW(`wt-${toolName}`, 'wtkey', q)], maxInFlight: 1 } });
  const llm = createAgentLlm({ scheduler, log: quiet });
  const loop = createAgentLoop({
    store, chat: llm.chat, takeUsage: llm.takeUsage, tools: [...tools, doingTool], log: quiet,
    options: {
      deps: { engine, makeClient, skills: agentSkills, enqueue: (payload) => agentQueue.enqueue(payload) },
    },
  });
  const sessionId = store.createAgentSession({ bookKey: '', title: `wt:${toolName}` });
  const events = [];
  const r = await loop.runTurn(sessionId, `执行 ${toolName}`, {
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'decision') setTimeout(() => loop.resolveDecision(e.decisionId, approve ? 'allowed' : 'rejected'), 0);
    },
  });
  const toolRow = store.listAgentMessages(sessionId).find((x) => x.role === 'tool');
  return { r, parsed: JSON.parse(toolRow.content), events, sessionId };
};
await t('run_check：只读质检经单队列执行（无需审批）', async () => {
  const { parsed, events } = await runWriteToolOnce('run_check', { book: CHECK_KEY, limit: 5 });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.result.state, 'done', JSON.stringify(parsed.result));
  assert.ok(parsed.result.stats.codes.GLOSSARY >= 1, JSON.stringify(parsed.result.stats));
  assert.ok(!events.some((e) => e.type === 'decision'), '只读工具不应产生审批');
});
await t('run_translate：拒绝审批 → 不入队、不执行', async () => {
  const key = `web:mock/mock-trans-w-${RUN}`;
  store.upsertBook({ key, kind: 'web', providerId: 'mock', novelId: `mock-trans-w-${RUN}`, origin: MOCK, title: '' });
  const before = agentQueue.list().length;
  const { parsed, events } = await runWriteToolOnce('run_translate', { book: key, level: 'expire', maxChapters: 1 }, { approve: false });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'approval_denied', JSON.stringify(parsed));
  assert.equal(agentQueue.list().length, before, '拒绝后不应入队');
  assert.ok(events.some((e) => e.type === 'decision' && e.preview && e.preview.action === '翻译并上传译文'));
});
await t('run_translate：放行 → 入队执行并回传 stats', async () => {
  const key = `web:mock/mock-trans-w-${RUN}`;
  const { parsed } = await runWriteToolOnce('run_translate', { book: key, level: 'expire', maxChapters: 1 });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.result.state, 'done', JSON.stringify(parsed.result));
  assert.ok(parsed.result.stats.uploaded >= 1, JSON.stringify(parsed.result.stats));
});
await t('glossary_apply：preview 给出真实 diff；放行后快照+写入+回读校验；拦截条目跳过', async () => {
  const key = `web:mock/mock-import-w-${RUN}`;
  store.upsertBook({ key, kind: 'web', providerId: 'mock', novelId: `mock-import-w-${RUN}`, origin: MOCK, title: '' });
  const { parsed, events } = await runWriteToolOnce('glossary_apply', {
    book: key,
    entries: [
      { src: 'アルテ', dst: '阿尔蒂', info: '女性' },
      { src: 'rem0', dst: '不该写', info: '' },
    ],
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.result.applied, 1, JSON.stringify(parsed.result));
  assert.equal(parsed.result.verified, true, JSON.stringify(parsed.result));
  assert.equal(parsed.result.skipped.length, 1, JSON.stringify(parsed.result.skipped));
  const decision = events.find((e) => e.type === 'decision');
  assert.ok(decision && decision.preview && decision.preview.additionsTotal === 1, JSON.stringify(decision && decision.preview));
  const stats = await mockStats();
  assert.ok(/mock-import-w/.test(stats.lastGlossaryPut.path) && stats.lastGlossaryPut.body['アルテ'] === '阿尔蒂 #女性', JSON.stringify(stats.lastGlossaryPut.body));
});
await t('glossary_rollback：回滚到先前快照（写前自动再存一份）', async () => {
  const key = `web:mock/mock-import-w-${RUN}`;
  const client = makeClient(store.getBook(key));
  const applied = await runWriteToolOnce('glossary_apply', { book: key, entries: [{ src: 'ローズ', dst: '罗丝琳', info: '' }] });
  assert.equal(applied.parsed.result.applied, 1, JSON.stringify(applied.parsed));
  const beforeRollback = await client.getGlossary(store.getBook(key));
  assert.ok(Object.keys(beforeRollback).includes('ローズ') && beforeRollback['アルテ'], JSON.stringify(beforeRollback));
  const targetId = store.listSnapshots(key)[0].id;   // 「ローズ」写入前的快照 = { アルテ }
  const rolled = await runWriteToolOnce('glossary_rollback', { book: key, snapshotId: targetId });
  assert.equal(rolled.parsed.ok, true, JSON.stringify(rolled.parsed));
  assert.equal(rolled.parsed.result.verified, true, JSON.stringify(rolled.parsed.result));
  assert.ok(rolled.parsed.result.autoSnapshotId > 0, '回滚前应自动存快照');
  const now = await client.getGlossary(store.getBook(key));
  assert.ok(!Object.keys(now).includes('ローズ'), JSON.stringify(now));
  assert.equal(now['アルテ'], '阿尔蒂 #女性', JSON.stringify(now));
});
await t('set_prompt / set_rule / delete_rule / close_proposal：本地写操作走审批或自动', async () => {
  const promptRun = await runWriteToolOnce('set_prompt', { bookKey: '', slot: 'thinking', text: '先自查一遍再回答。' });
  assert.equal(promptRun.parsed.ok, true, JSON.stringify(promptRun.parsed));
  assert.ok(store.listPrompts('').some((r) => r.slot === 'thinking' && r.text.includes('自查')), JSON.stringify(store.listPrompts('')));
  store.clearPrompt('', 'thinking');

  const ruleRun = await runWriteToolOnce('set_rule', { kind: 'post_replacement', pattern: '统一检查词', replacement: '统一检查词' });
  assert.ok(ruleRun.parsed.result.id > 0, JSON.stringify(ruleRun.parsed));
  const ruleId = ruleRun.parsed.result.id;
  assert.ok(store.listRules('').some((r) => r.id === ruleId));
  const delRun = await runWriteToolOnce('delete_rule', { id: ruleId });
  assert.equal(delRun.parsed.ok, true, JSON.stringify(delRun.parsed));
  assert.ok(!store.listRules('').some((r) => r.id === ruleId));

  const proposalId = store.addProposal({ bookKey: 'wenku:mock-boost', kind: 'glossary', entries: [{ src: 'x', dst: 'y' }], note: 'a3' });
  const closeRun = await runWriteToolOnce('close_proposal', { id: proposalId });
  assert.equal(closeRun.parsed.ok, true, JSON.stringify(closeRun.parsed));
  assert.equal(store.getProposal(proposalId).status, 'closed');
  assert.ok(!closeRun.events.some((e) => e.type === 'decision'), 'close_proposal 为本地状态，自动执行');
});
await t('控制面：/snapshots/restore 与 /proposals/close|apply', async () => {
  const bookKey = `web:mock/mock-import-h-${RUN}`;
  store.upsertBook({ key: bookKey, kind: 'web', providerId: 'mock', novelId: `mock-import-h-${RUN}`, origin: MOCK, title: '' });
  const client = makeClient(store.getBook(bookKey));
  await client.putGlossaryRaw(store.getBook(bookKey), { '基': '基准值' });
  const snapId = store.addSnapshot(bookKey, { '基': '基准值' }, 'http-e2e');
  await client.putGlossaryRaw(store.getBook(bookKey), { '基': '被改' });
  const proposalId = store.addProposal({ bookKey, kind: 'glossary', entries: [{ src: '追加', dst: '追加译', type: '女性人名' }], note: 'http' });
  const server = await startServer({
    store, pipeline: mkPipeline({}), glossaryPipeline: null, checkPipeline: null, scheduler: null,
    queue: agentQueue, makeClient, engine, port: 7351, log: quiet,
  });
  const post = (path, body) => fetch(`http://127.0.0.1:7351${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  try {
    const restored = await post('/snapshots/restore', { book: bookKey, snapshotId: snapId });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.verified, true, JSON.stringify(restored));
    assert.deepEqual(await client.getGlossary(store.getBook(bookKey)), { '基': '基准值' });

    const applied = await post('/proposals/apply', { id: proposalId });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.applied, 1, JSON.stringify(applied));
    assert.equal(store.getProposal(proposalId).status, 'applied');
    assert.ok(Object.keys(await client.getGlossary(store.getBook(bookKey))).includes('追加'));

    const closed = await post('/proposals/close', { id: proposalId, status: 'closed' });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(store.getProposal(proposalId).status, 'closed');
  } finally { server.close(); }
});

console.log('== Agent 控制台（A4：HTTP/SSE/审批/停止） ==');
const pollUntil = async (fn, ms = 12000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
};
const mkAgentServer = async (port, toolcallQuery, tools) => {
  const scheduler = new LlmScheduler({
    engine, store, log: quiet,
    options: { workers: [mkW(`au${port}`, 'aukey', toolcallQuery)], maxInFlight: 1 },
  });
  const llm = createAgentLlm({ scheduler, log: quiet });
  const events = createAgentEvents();
  const loop = createAgentLoop({
    store, chat: llm.chat, takeUsage: llm.takeUsage, tools, log: quiet,
    options: { deps: { engine, makeClient, skills: agentSkills, enqueue: (p) => agentQueue.enqueue(p) } },
  });
  const server = await startServer({
    store, pipeline: null, glossaryPipeline: null, checkPipeline: null, scheduler: null,
    queue: agentQueue, makeClient, engine, agentLoop: loop, agentEvents: events, port, log: quiet,
  });
  return { server, loop, events };
};
const agentFetch = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, body === undefined
  ? undefined
  : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

await t('HTTP：建会话 → 发消息 → 轮询到终态（工具调用与用量可见）', async () => {
  const { server } = await mkAgentServer(7360, '?toolcall=doing', [...writeTools, doingTool]);
  try {
    const cfg = await agentFetch(7360, '/agent/config');
    assert.equal(cfg.ok, true);
    assert.ok(Array.isArray(cfg.tools) && cfg.tools.includes('doing') && cfg.tools.includes('glossary_apply'), JSON.stringify(cfg.tools));
    const created = await agentFetch(7360, '/agent/session', { title: 'a4' });
    const sessionId = created.sessionId;
    assert.ok(sessionId);
    const accepted = await agentFetch(7360, '/agent/message', { session: sessionId, message: '你好', approvalMode: 'auto' });
    assert.equal(accepted.accepted, true, JSON.stringify(accepted));
    const snap = await pollUntil(async () => {
      const s = await agentFetch(7360, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
      return (!s.running && s.messages.length >= 4) ? s : null;
    });
    assert.ok(snap, '应到达终态');
    assert.deepEqual(snap.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.ok(String(snap.messages[3].content).includes('完成（mock）'), snap.messages[3].content);
    assert.ok(snap.usage.requests >= 1, JSON.stringify(snap.usage));
    const sessions = await agentFetch(7360, '/agent/sessions');
    assert.ok(sessions.sessions.some((x) => x.id === sessionId));
  } finally { server.close(); }
});
await t('SSE：/agent/events 重放历史事件（含 user/assistant/tool 事件）', async () => {
  const { server } = await mkAgentServer(7361, '?toolcall=doing', [...writeTools, doingTool]);
  try {
    const { sessionId } = await agentFetch(7361, '/agent/session', { title: 'sse' });
    await agentFetch(7361, '/agent/message', { session: sessionId, message: '走一遍', approvalMode: 'auto' });
    await pollUntil(async () => {
      const s = await agentFetch(7361, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
      return !s.running && s.messages.length >= 4;
    });
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:7361/agent/events?session=${encodeURIComponent(sessionId)}&since=0`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.ok(String(res.headers.get('content-type')).includes('text/event-stream'), res.headers.get('content-type'));
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const chunk = Buffer.from(value || []).toString('utf8');
    controller.abort();
    assert.ok(chunk.includes('"type":"user_message"'), chunk.slice(0, 300));
    assert.ok(chunk.includes('"type":"assistant_message"'), chunk.slice(0, 300));
    assert.ok(chunk.includes('"type":"tool_result"'), chunk.slice(0, 300));
  } finally { server.close(); }
});
await t('审批：manual 模式挂起 → GUI 决定 allowed 后执行，rejected 不执行', async () => {
  let executed = 0;
  const probe = {
    name: 'write_probe', description: '写探针', parameters: { type: 'object', properties: {} },
    requiresApproval: true, preview: () => ({ action: '写探针', diff: 'probe' }),
    async execute() { executed += 1; return { ok: true, wrote: 1 }; },
  };
  const { server } = await mkAgentServer(7362, '?toolcall=write_probe', [probe]);
  try {
    const { sessionId } = await agentFetch(7362, '/agent/session', { title: 'approve' });
    await agentFetch(7362, '/agent/message', { session: sessionId, message: '写一下', approvalMode: 'manual' });
    const pending = await pollUntil(async () => {
      const s = await agentFetch(7362, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
      return s.pendingDecision || null;
    });
    assert.ok(pending && pending.kind === 'write', JSON.stringify(pending));
    assert.equal(pending.payload.preview.action, '写探针');
    const resolved = await agentFetch(7362, '/agent/decision', { id: pending.id, status: 'allowed', resolution: { via: 'test' } });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    const done = await pollUntil(async () => {
      const s = await agentFetch(7362, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
      return (!s.running && s.pendingDecision === null && s.messages.some((m) => m.role === 'tool')) ? s : null;
    });
    assert.ok(done, '审批后应执行完成');
    assert.equal(executed, 1);
    assert.ok(done.messages.some((m) => m.role === 'tool' && m.content.includes('"wrote":1')), JSON.stringify(done.messages.map((m) => m.content)));

    const { sessionId: s2 } = await agentFetch(7362, '/agent/session', { title: 'reject' });
    await agentFetch(7362, '/agent/message', { session: s2, message: '再写', approvalMode: 'manual' });
    const pending2 = await pollUntil(async () => {
      const s = await agentFetch(7362, `/agent/snapshot?session=${encodeURIComponent(s2)}`);
      return s.pendingDecision || null;
    });
    await agentFetch(7362, '/agent/decision', { id: pending2.id, status: 'rejected' });
    const done2 = await pollUntil(async () => {
      const s = await agentFetch(7362, `/agent/snapshot?session=${encodeURIComponent(s2)}`);
      return (!s.running && s.pendingDecision === null && s.messages.some((m) => m.role === 'tool')) ? s : null;
    });
    assert.ok(done2, '拒绝后也应结束');
    assert.equal(executed, 1, '拒绝后不应执行');
    assert.ok(done2.messages.some((m) => m.role === 'tool' && m.content.includes('approval_denied')), JSON.stringify(done2.messages.map((m) => m.content)));
  } finally { server.close(); }
});
await t('停止：/agent/stop 取消挂起追问与当前轮', async () => {
  const question = '{"question":"选哪个？","options":[{"id":"a","label":"A"}]}';
  const { server } = await mkAgentServer(7363, `?toolcall=ask_user&toolargs=${encodeURIComponent(question)}`, [askUserTool]);
  try {
    const { sessionId } = await agentFetch(7363, '/agent/session', { title: 'stop' });
    await agentFetch(7363, '/agent/message', { session: sessionId, message: '问一下', approvalMode: 'manual' });
    const pending = await pollUntil(async () => {
      const s = await agentFetch(7363, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
      return s.pendingDecision || null;
    });
    assert.ok(pending && pending.kind === 'question', JSON.stringify(pending));
    const stopped = await agentFetch(7363, '/agent/stop', { session: sessionId });
    assert.equal(stopped.stopped, true);
    const after = await pollUntil(async () => {
      const s = await agentFetch(7363, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
      return (!s.running && s.pendingDecision === null) ? s : null;
    });
    assert.ok(after, '停止后应回到空闲');
  } finally { server.close(); }
});

console.log('== Agent 输入框指令（@技能 / 系统指令） ==');
await t('/agent/skills 列出目录；未知 @ → 400 带清单', async () => {
  const { server } = await mkAgentServer(7364, '', [...writeTools, doingTool]);
  try {
    const skills = await agentFetch(7364, '/agent/skills');
    assert.equal(skills.ok, true);
    assert.ok(skills.skills.some((x) => x.name === 'glossary-workflow'), JSON.stringify(skills.skills.map((x) => x.name)));
    const { sessionId } = await agentFetch(7364, '/agent/session', { title: 'bad' });
    const bad = await agentFetch(7364, '/agent/message', { session: sessionId, message: '@nope-skill 看看' });
    assert.equal(bad.ok, false, JSON.stringify(bad));
    assert.ok(bad.error.includes('nope-skill') && Array.isArray(bad.knownSkills), JSON.stringify(bad));
    const snap = await agentFetch(7364, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
    assert.equal(snap.messages.length, 0, '400 时不落消息');
  } finally { server.close(); }
});
await t('@技能名：该轮系统提示注入技能正文（mock lastSystem 断言）', async () => {
  const { server } = await mkAgentServer(7365, '', [...writeTools, doingTool]);
  try {
    const { sessionId } = await agentFetch(7365, '/agent/session', { title: 'pin' });
    await agentFetch(7365, '/agent/message', { session: sessionId, message: '@glossary-workflow 看一眼', approvalMode: 'auto' });
    await pollUntil(async () => {
      const s = await agentFetch(7365, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
      return !s.running && s.messages.length >= 2;
    });
    const stats = await mockStats();
    assert.ok(stats.lastSystem.includes('【用户点名技能：glossary-workflow】'), stats.lastSystem);
    assert.ok(stats.lastSystem.includes('写入门槛') || stats.lastSystem.includes('术语表工作流'), stats.lastSystem.slice(0, 200));
  } finally { server.close(); }
});
await t('系统指令：保存 → 下一轮系统提示携带【用户系统指令】', async () => {
  const { server } = await mkAgentServer(7366, '', [...writeTools, doingTool]);
  try {
    const { sessionId } = await agentFetch(7366, '/agent/session', { title: 'sys' });
    const saved = await agentFetch(7366, '/agent/personality', { session: sessionId, text: '回答要短，先结论。' });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const snap0 = await agentFetch(7366, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
    assert.equal(snap0.session.personality, '回答要短，先结论。');
    await agentFetch(7366, '/agent/message', { session: sessionId, message: '普通消息', approvalMode: 'auto' });
    await pollUntil(async () => {
      const s = await agentFetch(7366, `/agent/snapshot?session=${encodeURIComponent(sessionId)}`);
      return !s.running && s.messages.length >= 2;
    });
    const stats = await mockStats();
    assert.ok(stats.lastSystem.includes('【用户系统指令】'), stats.lastSystem);
    assert.ok(stats.lastSystem.includes('先结论'), stats.lastSystem);
  } finally { server.close(); }
});

console.log('== 控制面 ==');
await t('server：/status 有书与进度、/auth 更新凭据', async () => {
  const server = await startServer({ store, pipeline: mkPipeline({}), port: 7342, log: { log: () => { }, error: () => { } } });
  const status = await fetch('http://127.0.0.1:7342/status').then((r) => r.json());
  assert.equal(status.ok, true);
  const book = status.books.find((b) => b.key === `web:mock/${TRANS_BOOK}`);
  assert.ok(book && book.progress === 2, JSON.stringify(status.books));
  const auth = await fetch('http://127.0.0.1:7342/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'fresh-token', workers }),
  }).then((r) => r.json());
  assert.equal(auth.ok, true);
  assert.equal(store.getConfig('token'), 'fresh-token');
  server.close();
});

console.log('== 术语管线：全流程（提取→核实→指南门槛→直写/提案） ==');
const glossaryPipeline = new GlossaryPipeline({
  store, engine, workers, makeClient,
  log: { log: () => { }, error: () => { } },
  options: {
    budgetChars: 3000, maxRounds: 2, concurrency: 2,
    seedPolish: true, maxSeedRounds: 3, verify: true,
    // 测试钩子：塞一条「改原文」条目驱动提案分支
    testExtraEntries: [{ src: 'rem0', dst: '真白萌有翻译', type: '' }],
  },
});
let gResult = null;
await t('runBook 端到端（SCAN→EXTRACT→VERIFY→MERGE→ACCEPT→PUBLISH|PROPOSE）', async () => {
  store.upsertBook({ key: 'wenku:mock-boost', kind: 'wenku', providerId: '', novelId: 'mock-boost', origin: MOCK, title: '' });
  gResult = await glossaryPipeline.runBook('wenku:mock-boost');
  assert.ok(gResult.stats.requests >= 2, JSON.stringify(gResult.stats));
  assert.ok(gResult.stats.added >= 2, JSON.stringify(gResult.stats));
});
await t('种子账本落库（可序列化续跑）', () => {
  const ledger = store.getLedger('wenku:mock-boost');
  assert.ok(ledger && Array.isArray(ledger.rounds), JSON.stringify(ledger));
});
await t('指南门槛：改原文条目进提案、不进站点写入', async () => {
  const stats = await fetch(`${MOCK}/__stats`).then((r) => r.json());
  const put = stats.lastGlossaryPut;
  assert.ok(put && /mock-boost/.test(put.path), 'PUT 已发生');
  assert.equal(put.body['rem0'], undefined, '改原文条目不写入');
  const proposals = store.listProposals('wenku:mock-boost').filter((x) => x.status === 'open');
  assert.ok(proposals.some((x) => x.entries.some((e) => e.src === 'rem0')), JSON.stringify(proposals.map((x) => x.entries)));
});
await t('写入值带指南备注格式（非空字符串）', async () => {
  const stats = await fetch(`${MOCK}/__stats`).then((r) => r.json());
  const values = Object.values(stats.lastGlossaryPut.body);
  assert.ok(values.length >= 2 && values.every((v) => typeof v === 'string' && v.trim() !== ''), JSON.stringify(values));
});
await t('无译文时 ACCEPT 自动跳过（mock-boost 无 oldParagraphZh）', () => {
  assert.equal(gResult.stats.acceptRate, null, JSON.stringify(gResult.stats));
});
await t('写入前快照落库（可回滚）', () => {
  assert.ok(store.listSnapshots('wenku:mock-boost').length >= 1);
});
console.log('== 术语管线：断点续跑 ==');
await t('中途停止：分块缓存与账本保留', async () => {
  const small = new GlossaryPipeline({
    store, engine, workers, makeClient, log: { log: () => { }, error: () => { } },
    options: { budgetChars: 200, maxRequests: 1, seedPolish: true, maxSeedRounds: 3, verify: false },
  });
  await small.runBook('wenku:mock-boost');
  assert.ok(store.chunkCount('wenku:mock-boost') >= 1, '分块缓存已落库');
});
await t('续跑：缓存复用，请求量远小于全量重跑', async () => {
  const resume = new GlossaryPipeline({
    store, engine, workers, makeClient, log: { log: () => { }, error: () => { } },
    options: { budgetChars: 200, seedPolish: true, maxSeedRounds: 3, verify: true },
  });
  const r = await resume.runBook('wenku:mock-boost');
  assert.ok(r.stats.requests < 12, JSON.stringify(r.stats));
});
await t('控制面：/proposals 可见提案、/run 支持 job=glossary', async () => {
  const server = await startServer({ store, pipeline: mkPipeline({}), glossaryPipeline, port: 7344, log: { log: () => { }, error: () => { } } });
  const props = await fetch('http://127.0.0.1:7344/proposals?book=wenku:mock-boost').then((r) => r.json());
  assert.equal(props.ok, true);
  assert.ok(props.proposals.length >= 1);
  const run = await fetch('http://127.0.0.1:7344/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookKey: 'wenku:mock-boost', job: 'glossary' }),
  }).then((r) => r.json());
  assert.equal(run.job, 'glossary');
  server.close();
});

console.log('== LG 译文对齐导入（export-src → LG 结果 → import-lg --apply） ==');
const LG_TXT = path.join(here, 'exports', `lg-src-${RUN}.txt`);
const uploadSnapshot = async () => (await fetch(`${MOCK}/__stats`).then((r) => r.json())).lastChapterUpload || null;
await t('导出：collectChapters 3 章 12 段，txt + 清单落盘（CLI 同路径）', async () => {
  const key = `web:mock/mock-trans-lg-${RUN}`;
  store.upsertBook({ key, kind: 'web', providerId: 'mock', novelId: `mock-trans-lg-${RUN}`, origin: MOCK, title: '' });
  const book = store.getBook(key);
  const chapters = await collectChapters(makeClient(book), book);
  assert.equal(chapters.length, 3, JSON.stringify(chapters.map((c) => c.chapterId)));
  assert.deepEqual(chapters.map((c) => c.paragraphs.length), [6, 4, 2]);
  const built = buildSourceExport(chapters);
  assert.equal(built.linesTotal, 12);
  fs.mkdirSync(path.dirname(LG_TXT), { recursive: true });
  fs.writeFileSync(LG_TXT, built.text, 'utf8');
  fs.writeFileSync(`${LG_TXT}.manifest.json`, JSON.stringify(manifestOf(book, built), null, 2), 'utf8');
  assert.equal(splitResultLines(fs.readFileSync(LG_TXT, 'utf8')).length, 12, '导出文本按行读取行数一致');
});
await t('dry-run：LG 结果行（逐行替换、行号不变）校验逐章 ✓、glossaryId 带出、不上传', async () => {
  const book = store.getBook(`web:mock/mock-trans-lg-${RUN}`);
  const client = makeClient(book);
  const resultText = fs.readFileSync(LG_TXT, 'utf8').split('\n').map((l) => `【LG译】${l}`).join('\n');
  fs.writeFileSync(`${LG_TXT}.result.txt`, resultText, 'utf8');
  const before = await uploadSnapshot();
  const report = await verifyImport({
    resultLines: splitResultLines(resultText),
    manifest: JSON.parse(fs.readFileSync(`${LG_TXT}.manifest.json`, 'utf8')),
    getChapter: (chapterId, volumeId) => client.getChapterTask(book, chapterId, 'gpt', volumeId),
  });
  assert.equal(report.ok, true, JSON.stringify(report.chapters.filter((c) => !c.ok)));
  assert.equal(report.untranslated, 0);
  assert.ok(report.chapters.every((c) => c.glossaryId === 'g-current'), JSON.stringify(report.chapters.map((c) => c.glossaryId)));
  assert.deepEqual(await uploadSnapshot(), before, 'dry-run 不产生章节上传');
});
await t('--apply：通过章逐章提交 GPT 槽（glossaryId + 段数严格一致）→ 站点视为已译', async () => {
  const book = store.getBook(`web:mock/mock-trans-lg-${RUN}`);
  const client = makeClient(book);
  const report = await verifyImport({
    resultLines: splitResultLines(fs.readFileSync(`${LG_TXT}.result.txt`, 'utf8')),
    manifest: JSON.parse(fs.readFileSync(`${LG_TXT}.manifest.json`, 'utf8')),
    getChapter: (chapterId, volumeId) => client.getChapterTask(book, chapterId, 'gpt', volumeId),
  });
  let uploaded = 0;
  for (const c of report.chapters) {
    if (!c.ok) continue;
    await client.uploadChapter(book, c.chapterId, { glossaryId: c.glossaryId, paragraphsZh: c.paragraphsZh }, 'gpt', c.volumeId);
    uploaded += 1;
    const up = await uploadSnapshot();
    assert.equal(up.chapterId, c.chapterId, `第 ${uploaded} 次提交落错章`);
    assert.equal(up.glossaryId, 'g-current');
    assert.equal(up.count, c.count, '段落数与站点原文严格一致');
    assert.ok(String(up.preview[0]).startsWith('【LG译】'), up.preview[0]);
  }
  assert.equal(uploaded, 3);
  const rerun = await mkPipeline({}).runBook(`web:mock/mock-trans-lg-${RUN}`);
  assert.equal(rerun.stats.uploaded + rerun.stats.targets + rerun.stats.requests, 0, `导入后站点视为已译：管线零目标 ${JSON.stringify(rerun.stats)}`);
});
await t('源漂移章跳过：t2 清单 sha1 过期 → 该章 ✗ 不提交，其余正常入站', async () => {
  const key = `web:mock/mock-trans-lg2-${RUN}`;
  store.upsertBook({ key, kind: 'web', providerId: 'mock', novelId: `mock-trans-lg2-${RUN}`, origin: MOCK, title: '' });
  const book = store.getBook(key);
  const client = makeClient(book);
  const built = buildSourceExport(await collectChapters(client, book));
  const manifest = JSON.parse(JSON.stringify(manifestOf(book, built)));
  manifest.chapters.find((c) => c.chapterId === 't2').jpSha1 = '0'.repeat(40);
  const resultLines = splitResultLines(built.text.split('\n').map((l) => `【LG译】${l}`).join('\n'));
  const report = await verifyImport({ resultLines, manifest, getChapter: (chapterId, volumeId) => client.getChapterTask(book, chapterId, 'gpt', volumeId) });
  assert.equal(report.okCount, 2, JSON.stringify(report.chapters.map((c) => [c.chapterId, c.ok, c.reason])));
  const t2 = report.chapters.find((c) => c.chapterId === 't2');
  assert.equal(t2.ok, false);
  assert.ok(/不一致（源站更新|漂移）/.test(t2.reason), t2.reason);
  assert.equal(t2.paragraphsZh, null);
  for (const c of report.chapters) {
    if (!c.ok) continue;
    await client.uploadChapter(book, c.chapterId, { glossaryId: c.glossaryId, paragraphsZh: c.paragraphsZh }, 'gpt', c.volumeId);
  }
  const rerun = await mkPipeline({}).runBook(key);
  assert.equal(rerun.stats.targets, 1, JSON.stringify(rerun.stats), '只剩漂移的 t2 需要翻译');
});
await t('清理：exports 测试文件', () => {
  for (const f of [LG_TXT, `${LG_TXT}.manifest.json`, `${LG_TXT}.result.txt`]) { try { fs.unlinkSync(f); } catch { } }
  assert.ok(!fs.existsSync(LG_TXT));
});

console.log('== 设置页 v2：worker 管理 / 分角色模型池 / 助手参数 ==');
const setSched = new LlmScheduler({ engine, store, log: quiet, options: { workers: [{ id: 'tl0', model: 'mock-glossary-1', endpoint: `${MOCK}/v1`, key: 'key-AAAA1111' }] } });
const setAgSched = new LlmScheduler({ engine, store, log: quiet, options: { workers: [{ id: 'tl0', model: 'mock-glossary-1', endpoint: `${MOCK}/v1`, key: 'key-AAAA1111' }] } });
const setServer = await startServer({ store, pipeline: mkPipeline({}), glossaryPipeline, scheduler: setSched, agentScheduler: setAgSched, makeClient, engine, port: 7367, log: quiet });
const sGet = async (p) => fetch(`http://127.0.0.1:7367${p}`).then((r) => r.json());
const sPost = async (p, body) => fetch(`http://127.0.0.1:7367${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const TLW = (id, key) => ({ id, model: 'mock-glossary-1', endpoint: `${MOCK}/v1`, key });
await t('key 合并：/auth 推送 → GUI 编辑（同 id 留空保 key、新行写新 key）→ 掩码回显、明文不漏', async () => {
  await sPost('/auth', { workers: [TLW('tl0', 'key-AAAA1111')] });
  await sPost('/settings', { workers: [TLW('tl0', ''), TLW('tl1', 'key-CCCC3333')] });
  const s = await sGet('/settings');
  assert.equal(s.settings.workers.length, 2, JSON.stringify(s.settings.workers));
  assert.equal(s.settings.workers[0].key, 'key-…11', 'tl0 留空 → 沿用原 key 的掩码');
  assert.equal(s.settings.workers[1].key, 'key-…33', 'tl1 新 key 的掩码');
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes('key-AAAA1111') && !raw.includes('key-CCCC3333'), '明文 key 不得出现在 GET /settings');
});
await t('显式助手池：/auth 再推送不覆盖；agent 调用路由到助手池（mock key 计数）', async () => {
  const r1 = await sPost('/settings', { agent: { workers: [TLW('ag0', 'key-BBBB2222')] } });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  await sPost('/auth', { workers: [TLW('tl0', 'key-AAAA1111')] });
  const s = await sGet('/settings');
  assert.equal(s.settings.agent.workers.length, 1, '显式助手池不被 /auth 覆盖');
  assert.equal(s.settings.agent.workers[0].key, 'key-…22');
  assert.equal(s.settings.workers[0].key, 'key-…11', '翻译池被 /auth 覆盖（油猴语义）');
  const agLlm = createAgentLlm({ scheduler: setAgSched, log: quiet });
  const chat = await agLlm.chat({ messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(chat.ok, true, JSON.stringify(chat));
  const stats = await fetch(`${MOCK}/__stats`).then((r) => r.json());
  assert.ok((stats.keys['key-BBBB2222'] || 0) >= 1, '助手池请求应带 ag0 的 key：' + JSON.stringify(stats.keys));
});
await t('跟随模式：助手池清空 → 回到镜像，/auth 推送同步 llmAgent', async () => {
  await sPost('/settings', { agent: { workers: [] } });
  const st0 = await sGet('/status');
  assert.equal(st0.llmAgent.workers, 1, '清空后跟随翻译池（1 个）');
  await sPost('/auth', { workers: [TLW('tl9', 'key-DDDD4444'), TLW('tl10', 'key-EEEE5555')] });
  const st1 = await sGet('/status');
  assert.equal(st1.llm.workers, 2);
  assert.equal(st1.llmAgent.workers, 2, '跟随模式下 /auth 推送镜像到助手池');
});
await t('助手参数：agent.llm 热更新 + maxSteps/toolResultMaxChars/approvalMode 回读', async () => {
  await sPost('/settings', { agent: { llm: { maxInFlight: 3 } } });
  const st = await sGet('/status');
  assert.equal(st.llmAgent.maxInFlight, 3, '助手池并发上限热更新');
  await sPost('/settings', { agent: { maxSteps: 13, toolResultMaxChars: 999, approvalMode: 'auto' } });
  const s2 = await sGet('/settings');
  assert.equal(s2.settings.agent.maxSteps, 13);
  assert.equal(s2.settings.agent.toolResultMaxChars, 999);
  assert.equal(s2.settings.agent.approvalMode, 'auto');
  const cfg = await sGet('/agent/config');
  assert.equal(cfg.approvalMode, 'auto');
});
await t('清理：设置页 v2 服务器', () => { setServer.close(); });

console.log('== 项目化：会话绑定项目 + 系统提示注入 ==');
const projBook = `web:mock/${TRANS_BOOK}`;
const projSched = new LlmScheduler({ engine, store, log: quiet, options: { workers: [mkW('proj', 'projkey', '')], maxInFlight: 1 } });
const projLlm = createAgentLlm({ scheduler: projSched, log: quiet });
const projLoop = createAgentLoop({ store, chat: projLlm.chat, takeUsage: projLlm.takeUsage, tools: [doingTool], log: quiet });
const projServer = await startServer({ store, pipeline: mkPipeline({}), glossaryPipeline, scheduler: projSched, agentScheduler: projSched, agentLoop: projLoop, makeClient, engine, port: 7368, log: quiet });
await t('会话绑书：创建带 bookKey → /agent/config 回读', async () => {
  const r = await fetch('http://127.0.0.1:7368/agent/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'proj-session', bookKey: projBook }) }).then((x) => x.json());
  assert.ok(r.sessionId, JSON.stringify(r));
  globalThis.__projSession = r.sessionId;
  const cfg = await fetch('http://127.0.0.1:7368/agent/config').then((x) => x.json());
  const row = (cfg.sessions || []).find((x) => x.id === r.sessionId);
  assert.ok(row, '会话应在列表中（上限 100）');
  assert.equal(row.bookKey, projBook, JSON.stringify(row));
});
await t('绑书会话系统提示含【当前项目】；无书会话不含', async () => {
  const r1 = await projLoop.runTurn(globalThis.__projSession, '你好', {});
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const st1 = await fetch(`${MOCK}/__stats`).then((x) => x.json());
  assert.ok(String(st1.lastSystem || '').includes('【当前项目】'), String(st1.lastSystem || '').slice(0, 240));
  assert.ok(String(st1.lastSystem).includes(projBook), '应含项目 key');
  const sid2 = store.createAgentSession({ title: 'plain-session' });
  const r2 = await projLoop.runTurn(sid2, '你好', {});
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const st2 = await fetch(`${MOCK}/__stats`).then((x) => x.json());
  assert.ok(!String(st2.lastSystem || '').includes('【当前项目】'), String(st2.lastSystem || '').slice(0, 240));
});
await t('清理：项目化测试服务器', () => { projServer.close(); });

console.log('== Agent 工作区（workspace_run / workspace_apply） ==');
const WS_ROOT = path.join(here, '.tmp-ws-root');
const WS_BOOK_KEY = `web:mock/mock-import-ws-${RUN}`;
store.upsertBook({ key: WS_BOOK_KEY, kind: 'web', providerId: 'mock', novelId: `mock-import-ws-${RUN}`, origin: MOCK, title: '工作区测试书' });
const wsDoing = [];
const wsCtx = {
  store,
  sessionId: 'ws-test-session',
  bookKey: WS_BOOK_KEY,
  book: store.getBook(WS_BOOK_KEY),
  onEvent: (e) => { if (e.type === 'doing') wsDoing.push(e.text); },
  options: {},
  approvalMode: 'auto',
  deps: { engine, makeClient, workspaceRoot: WS_ROOT, queueBusy: () => false },
};
const [wsRunTool, wsApplyTool] = createWorkspaceTools();
const wsApplyPreviewAndExecute = async () => {
  const preview = await wsApplyTool.preview({}, wsCtx);
  const result = await wsApplyTool.execute({}, wsCtx);
  return { preview, result };
};
await t('run：脚本读数据集 + ws.doing + ws.read 章节 + 写变更文件', async () => {
  const record = await wsRunTool.execute({ script: [
    'const fs = await import("node:fs");',
    'const rules = fs.readFileSync("rules/entries.jsonl", "utf8").trim().split("\\n").filter(Boolean);',
    'await ws.doing("已读 " + rules.length + " 条规则");',
    'const ch = await ws.read({ kind: "read", subkind: "chapter", chapterId: "ch1" });',
    'console.log("WS-OK rules=" + rules.length + " jpLines=" + ch.paragraphJp.length);',
    'fs.writeFileSync("changes/rules/creates.jsonl", JSON.stringify({ kind: "post_replacement", pattern: "【工作区】", replacement: "【译】" }) + "\\n");',
  ].join('\n') }, wsCtx);
  assert.equal(record.exitCode, 0, JSON.stringify(record));
  assert.equal(record.stderr.bytes, 0, JSON.stringify(record.stderr));
  assert.ok(String(record.stdout.content).includes('WS-OK'), JSON.stringify(record.stdout));
  assert.ok(wsDoing.some((t) => t.includes('条规则')), JSON.stringify(wsDoing));
  assert.ok(fs.existsSync(path.join(WS_ROOT, 'ws-test-session', 'changes', 'rules', 'creates.jsonl')), '变更文件已写');
  assert.ok(fs.existsSync(path.join(WS_ROOT, 'ws-test-session', 'contract.json')), '契约已落盘');
  assert.ok(fs.existsSync(path.join(WS_ROOT, 'ws-test-session', 'reference', 'workspace.md')), '参考文档已生成');
});
await t('沙箱：写工作区外 / 子进程 被权限模型拒绝', async () => {
  const record = await wsRunTool.execute({ script: [
    'const fs = await import("node:fs");',
    'try { fs.writeFileSync("../outside.txt", "x"); console.log("WROTE-OUTSIDE"); } catch (e) { console.log("FS-DENIED"); }',
    'try { const cp = await import("node:child_process"); cp.execSync("echo hi"); console.log("CHILD-OK"); } catch (e) { console.log("CHILD-DENIED"); }',
  ].join('\n') }, wsCtx);
  assert.equal(record.exitCode, 0, JSON.stringify(record));
  const text = String(record.stdout.content || '');
  assert.ok(text.includes('FS-DENIED'), text);
  assert.ok(text.includes('CHILD-DENIED'), text);
  assert.ok(!text.includes('WROTE-OUTSIDE') && !text.includes('CHILD-OK'), text);
});
await t('apply 全绿批（auto）：规则 + 术语 + 提示词 → applied、回读校验过', async () => {
  const root = path.join(WS_ROOT, 'ws-test-session');
  const promptFp = JSON.parse(fs.readFileSync(path.join(root, 'prompts.json'), 'utf8')).thinking.fp;
  fs.writeFileSync(path.join(root, 'changes', 'rules', 'creates.jsonl'), JSON.stringify({ kind: 'post_replacement', pattern: '【工作区】', replacement: '【译】' }) + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'changes', 'glossary', 'creates.jsonl'), JSON.stringify({ src: 'アルテ', dst: '阿尔缇', info: '主角' }) + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'changes', 'prompts', 'updates.jsonl'), JSON.stringify({ kind: 'thinking', fp: promptFp, text: '{format_rules} 工作区测试' }) + '\n', 'utf8');
  const { preview, result } = await wsApplyPreviewAndExecute();
  assert.equal(preview.counts.rules, 1, JSON.stringify(preview));
  assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.ok(result.applied.rules === 1 && result.applied.glossary === 1 && result.applied.prompts === 1, JSON.stringify(result.applied));
  assert.ok((store.listRules(WS_BOOK_KEY) || []).some((r) => r.pattern === '【工作区】'), '规则已入库');
  const stats = await fetch(`${MOCK}/__stats`).then((r) => r.json());
  assert.equal(stats.lastGlossaryPut.body['アルテ'], '阿尔缇 #主角', JSON.stringify(stats.lastGlossaryPut));
  assert.ok((store.listPrompts('') || []).some((p) => p.slot === 'thinking' && p.text.includes('工作区测试')), '提示词已写入');
});
await t('apply fp 漂移：rejected + destroyed + changes 清空', async () => {
  const root = path.join(WS_ROOT, 'ws-test-session');
  fs.writeFileSync(path.join(root, 'changes', 'glossary', 'updates.jsonl'), JSON.stringify({ src: 'アルテ', fp: 'zzzz', dst: '错译' }) + '\n', 'utf8');
  const { result } = await wsApplyPreviewAndExecute();
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.destroyed, true);
  assert.ok(result.rejected.some((r) => r.reason === 'fp_mismatch'), JSON.stringify(result.rejected));
  assert.equal(fs.readFileSync(path.join(root, 'changes', 'glossary', 'updates.jsonl'), 'utf8'), '', 'changes 已清空');
});
await t('apply partial：合法规则 + 漂移提示词 → 部分提交', async () => {
  const root = path.join(WS_ROOT, 'ws-test-session');
  fs.writeFileSync(path.join(root, 'changes', 'rules', 'creates.jsonl'), JSON.stringify({ kind: 'pre_replacement', pattern: '部分提交', replacement: 'OK' }) + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'changes', 'prompts', 'updates.jsonl'), JSON.stringify({ kind: 'base', fp: 'aaaa', text: '{format_rules} 漂移' }) + '\n', 'utf8');
  const { result } = await wsApplyPreviewAndExecute();
  assert.equal(result.status, 'partial', JSON.stringify(result));
  assert.ok((store.listRules(WS_BOOK_KEY) || []).some((r) => r.pattern === '部分提交'), '合法规则已入库');
  assert.equal(result.destroyed, true);
});
await t('apply 坏 JSONL：invalid_change 行被拒、好行照常', async () => {
  const root = path.join(WS_ROOT, 'ws-test-session');
  fs.writeFileSync(path.join(root, 'changes', 'rules', 'creates.jsonl'), 'not-json\n' + JSON.stringify({ kind: 'post_replacement', pattern: '坏行邻居' }) + '\n', 'utf8');
  const { result } = await wsApplyPreviewAndExecute();
  assert.equal(result.status, 'partial', JSON.stringify(result));
  assert.ok(result.rejected.some((r) => r.reason === 'invalid_change'), JSON.stringify(result.rejected));
  assert.ok((store.listRules(WS_BOOK_KEY) || []).some((r) => r.pattern === '坏行邻居'), '好行已入库');
});
await t('清理：工作区测试目录 + 工具元数据', () => {
  fs.rmSync(WS_ROOT, { recursive: true, force: true });
  assert.ok(wsRunTool.requiresApproval !== true, 'workspace_run 自动执行');
  assert.equal(wsApplyTool.requiresApproval, true, 'workspace_apply 需审批');
  assert.ok(!fs.existsSync(WS_ROOT));
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
store.close();
process.exit(fail === 0 ? 0 : 1);
