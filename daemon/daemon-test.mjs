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
const { loadEngine } = await imp('engine.mjs');
const { SiteClient } = await imp('site-client.mjs');
const { TranslationPipeline } = await imp('translate-pipeline.mjs');
const { GlossaryPipeline } = await imp('glossary-pipeline.mjs');
const { CheckPipeline } = await imp('check-pipeline.mjs');
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

console.log(`\n通过 ${pass}，失败 ${fail}`);
store.close();
process.exit(fail === 0 ? 0 : 1);
