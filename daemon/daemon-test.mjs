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
const makeClient = (book) => new SiteClient({ origin: book.origin || MOCK, token: store.getConfig('token') });
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
