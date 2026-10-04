// daemon/store.mjs —— SQLite 封装（node:sqlite，零依赖；接口做薄，必要时可换存储）
// 原则：进程内不驻留章节正文（工作区内存问题的正面修复）；进度/段缓存/指标全部落库。
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  key TEXT PRIMARY KEY, kind TEXT, providerId TEXT, novelId TEXT, origin TEXT,
  title TEXT, sourceLanguage TEXT DEFAULT 'JA',
  lastTextHash TEXT, state TEXT DEFAULT 'idle', lastRunAt INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bookKey TEXT, job TEXT, startedAt INTEGER,
  finishedAt INTEGER, state TEXT, statsJson TEXT
);
CREATE TABLE IF NOT EXISTS progress (
  bookKey TEXT, chapterKey TEXT, glossaryUuid TEXT, state TEXT, updateAt INTEGER,
  PRIMARY KEY (bookKey, chapterKey)
);
CREATE TABLE IF NOT EXISTS segcache (
  bookKey TEXT, segKey TEXT, zhJson TEXT, updateAt INTEGER,
  PRIMARY KEY (bookKey, segKey)
);
CREATE TABLE IF NOT EXISTS chunks (
  bookKey TEXT, id TEXT, json TEXT, PRIMARY KEY (bookKey, id)
);
CREATE TABLE IF NOT EXISTS ledger (bookKey TEXT PRIMARY KEY, json TEXT, updateAt INTEGER);
CREATE TABLE IF NOT EXISTS chaptermeta (
  bookKey TEXT, chapterKey TEXT, retries INTEGER, updateAt INTEGER,
  PRIMARY KEY (bookKey, chapterKey)
);
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, bookKey TEXT, at INTEGER, glossaryJson TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bookKey TEXT, at INTEGER, kind TEXT,
  entriesJson TEXT, note TEXT, status TEXT DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS metrics (ts INTEGER PRIMARY KEY, rss REAL, heap REAL);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bookKey TEXT, runId INTEGER, job TEXT,
  requests INTEGER, promptTokens INTEGER, completionTokens INTEGER, at INTEGER
);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS locks (bookKey TEXT PRIMARY KEY, holder TEXT, at INTEGER);
`;

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;   // 锁超过 6 小时视为残留（崩溃遗留），可被接管

export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  // ---- config（token / workers） ----
  getConfig(key) {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row === undefined ? undefined : JSON.parse(row.value);
  }
  setConfig(key, value) {
    this.db.prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ---- books ----
  upsertBook(book) {
    this.db.prepare(`
      INSERT INTO books(key, kind, providerId, novelId, origin, title, sourceLanguage, state)
      VALUES(?, ?, ?, ?, ?, ?, ?, 'idle')
      ON CONFLICT(key) DO UPDATE SET title = excluded.title, origin = excluded.origin
    `).run(book.key, book.kind, book.providerId, book.novelId, book.origin || '', book.title || '', book.sourceLanguage || 'JA');
  }
  getBook(key) { return this.db.prepare('SELECT * FROM books WHERE key = ?').get(key) || null; }
  listBooks() { return this.db.prepare('SELECT * FROM books ORDER BY key').all(); }
  setBookTitle(key, title) { this.db.prepare('UPDATE books SET title = ? WHERE key = ?').run(title, key); }
  setTextHash(key, hash) { this.db.prepare('UPDATE books SET lastTextHash = ? WHERE key = ?').run(hash, key); }
  setBookState(key, state) { this.db.prepare('UPDATE books SET state = ?, lastRunAt = ? WHERE key = ?').run(state, Date.now(), key); }
  forgetBook(key) {
    for (const sql of [
      'DELETE FROM books WHERE key = ?',
      'DELETE FROM progress WHERE bookKey = ?',
      'DELETE FROM segcache WHERE bookKey = ?',
      'DELETE FROM chunks WHERE bookKey = ?',
      'DELETE FROM ledger WHERE bookKey = ?',
      'DELETE FROM chaptermeta WHERE bookKey = ?',
      'DELETE FROM locks WHERE bookKey = ?',
    ]) this.db.prepare(sql).run(key);
  }

  // ---- 章节进度（断点续跑） ----
  getProgress(bookKey, chapterKey) {
    return this.db.prepare('SELECT * FROM progress WHERE bookKey = ? AND chapterKey = ?').get(bookKey, chapterKey) || null;
  }
  listProgress(bookKey) {
    return this.db.prepare('SELECT * FROM progress WHERE bookKey = ? ORDER BY chapterKey').all(bookKey);
  }
  setProgress(bookKey, chapterKey, { glossaryUuid, state }) {
    this.db.prepare(`
      INSERT INTO progress(bookKey, chapterKey, glossaryUuid, state, updateAt) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(bookKey, chapterKey) DO UPDATE SET glossaryUuid = excluded.glossaryUuid, state = excluded.state, updateAt = excluded.updateAt
    `).run(bookKey, chapterKey, glossaryUuid || '', state || 'done', Date.now());
  }

  // ---- 段级翻译缓存 ----
  getSeg(bookKey, segKey) {
    const row = this.db.prepare('SELECT zhJson FROM segcache WHERE bookKey = ? AND segKey = ?').get(bookKey, segKey);
    return row ? JSON.parse(row.zhJson) : undefined;
  }
  putSeg(bookKey, segKey, zhLines) {
    this.db.prepare('INSERT INTO segcache(bookKey, segKey, zhJson, updateAt) VALUES(?, ?, ?, ?) ON CONFLICT(bookKey, segKey) DO UPDATE SET zhJson = excluded.zhJson, updateAt = excluded.updateAt')
      .run(bookKey, segKey, JSON.stringify(zhLines), Date.now());
  }
  segCount(bookKey) { return this.db.prepare('SELECT COUNT(*) c FROM segcache WHERE bookKey = ?').get(bookKey).c; }

  // ---- 分块缓存（daemon 侧断点续跑） ----
  getChunk(bookKey, id) {
    const row = this.db.prepare('SELECT json FROM chunks WHERE bookKey = ? AND id = ?').get(bookKey, id);
    return row ? JSON.parse(row.json) : undefined;
  }
  putChunk(bookKey, id, value) {
    this.db.prepare('INSERT INTO chunks(bookKey, id, json) VALUES(?, ?, ?) ON CONFLICT(bookKey, id) DO UPDATE SET json = excluded.json')
      .run(bookKey, id, JSON.stringify(value));
  }
  chunkCount(bookKey) { return this.db.prepare('SELECT COUNT(*) c FROM chunks WHERE bookKey = ?').get(bookKey).c; }

  // ---- 种子账本 ----
  getLedger(bookKey) {
    const row = this.db.prepare('SELECT json FROM ledger WHERE bookKey = ?').get(bookKey);
    return row ? JSON.parse(row.json) : null;
  }
  setLedger(bookKey, ledger) {
    this.db.prepare('INSERT INTO ledger(bookKey, json, updateAt) VALUES(?, ?, ?) ON CONFLICT(bookKey) DO UPDATE SET json = excluded.json, updateAt = excluded.updateAt')
      .run(bookKey, JSON.stringify(ledger), Date.now());
  }

  // ---- 章节级元数据（质检 RETRY_THRESHOLD 用；只有 daemon 自己翻的章才有记录） ----
  setChapterMeta(bookKey, chapterKey, { retries = 0 } = {}) {
    this.db.prepare(`
      INSERT INTO chaptermeta(bookKey, chapterKey, retries, updateAt) VALUES(?, ?, ?, ?)
      ON CONFLICT(bookKey, chapterKey) DO UPDATE SET retries = excluded.retries, updateAt = excluded.updateAt
    `).run(bookKey, chapterKey, retries || 0, Date.now());
  }
  getChapterMeta(bookKey, chapterKey) {
    return this.db.prepare('SELECT * FROM chaptermeta WHERE bookKey = ? AND chapterKey = ?').get(bookKey, chapterKey) || null;
  }
  listChapterMeta(bookKey) {
    return this.db.prepare('SELECT * FROM chaptermeta WHERE bookKey = ?').all(bookKey);
  }

  // ---- 快照（写回前自动留存，回滚用） ----
  addSnapshot(bookKey, glossary, note) {
    const r = this.db.prepare('INSERT INTO snapshots(bookKey, at, glossaryJson, note) VALUES(?, ?, ?, ?)')
      .run(bookKey, Date.now(), JSON.stringify(glossary), note || '');
    return Number(r.lastInsertRowid);
  }
  listSnapshots(bookKey) {
    return this.db.prepare('SELECT id, at, note FROM snapshots WHERE bookKey = ? ORDER BY id DESC').all(bookKey);
  }
  getSnapshot(id) {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
    return row ? { ...row, glossary: JSON.parse(row.glossaryJson) } : null;
  }

  // ---- 提案（未达标条目：人工复核通道） ----
  addProposal({ bookKey, kind, entries, note }) {
    const r = this.db.prepare('INSERT INTO proposals(bookKey, at, kind, entriesJson, note) VALUES(?, ?, ?, ?, ?)')
      .run(bookKey, Date.now(), kind || 'glossary', JSON.stringify(entries || []), note || '');
    return Number(r.lastInsertRowid);
  }
  listProposals(bookKey) {
    const rows = bookKey
      ? this.db.prepare("SELECT * FROM proposals WHERE bookKey = ? ORDER BY id DESC LIMIT 50").all(bookKey)
      : this.db.prepare("SELECT * FROM proposals ORDER BY id DESC LIMIT 50").all();
    return rows.map((r) => ({ ...r, entries: JSON.parse(r.entriesJson || '[]') }));
  }
  closeProposal(id) {
    this.db.prepare("UPDATE proposals SET status = 'closed' WHERE id = ?").run(id);
  }

  // ---- runs / metrics ----
  startRun(bookKey, job) {
    const r = this.db.prepare('INSERT INTO runs(bookKey, job, startedAt, state) VALUES(?, ?, ?, ?)').run(bookKey, job || '', Date.now(), 'running');
    return Number(r.lastInsertRowid);
  }
  finishRun(id, state, stats) {
    this.db.prepare('UPDATE runs SET finishedAt = ?, state = ?, statsJson = ? WHERE id = ?')
      .run(Date.now(), state, JSON.stringify(stats || {}), id);
  }
  listRuns(limit = 10) {
    return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, stats: JSON.parse(r.statsJson || '{}') }));
  }
  addMetrics({ rss, heap }) {
    this.db.prepare('INSERT OR REPLACE INTO metrics(ts, rss, heap) VALUES(?, ?, ?)').run(Date.now(), rss, heap);
    this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }
  metricsSummary() {
    return this.db.prepare('SELECT ts, rss, heap FROM metrics ORDER BY ts DESC LIMIT 24').all().reverse();
  }

  // ---- 用量（调度器记账；每轮 run 落一行） ----
  addUsage({ bookKey, runId = 0, job = '', requests = 0, promptTokens = 0, completionTokens = 0 }) {
    this.db.prepare('INSERT INTO usage(bookKey, runId, job, requests, promptTokens, completionTokens, at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(bookKey || '', runId || 0, job || '', requests || 0, promptTokens || 0, completionTokens || 0, Date.now());
  }
  usageSummary(bookKey, limit = 20) {
    return bookKey
      ? this.db.prepare('SELECT * FROM usage WHERE bookKey = ? ORDER BY id DESC LIMIT ?').all(bookKey, limit)
      : this.db.prepare('SELECT * FROM usage ORDER BY id DESC LIMIT ?').all(limit);
  }
  usageTotals(bookKey) {
    const sql = 'SELECT COUNT(*) rows, COALESCE(SUM(requests), 0) requests, COALESCE(SUM(promptTokens), 0) promptTokens, COALESCE(SUM(completionTokens), 0) completionTokens FROM usage';
    return bookKey ? this.db.prepare(`${sql} WHERE bookKey = ?`).get(bookKey) : this.db.prepare(sql).get();
  }

  // ---- 锁（同书互斥；崩溃遗留超时自动失效） ----
  acquireLock(bookKey, holder) {
    const now = Date.now();
    const row = this.db.prepare('SELECT holder, at FROM locks WHERE bookKey = ?').get(bookKey);
    if (row && now - row.at < LOCK_TTL_MS && row.holder !== holder) return false;
    this.db.prepare('INSERT INTO locks(bookKey, holder, at) VALUES(?, ?, ?) ON CONFLICT(bookKey) DO UPDATE SET holder = excluded.holder, at = excluded.at')
      .run(bookKey, holder, now);
    return true;
  }
  releaseLock(bookKey, holder) {
    const row = this.db.prepare('SELECT holder FROM locks WHERE bookKey = ?').get(bookKey);
    if (row && row.holder === holder) this.db.prepare('DELETE FROM locks WHERE bookKey = ?').run(bookKey);
  }

  close() { this.db.close(); }
}
