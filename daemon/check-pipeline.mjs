// daemon/check-pipeline.mjs —— 质检 job：对站点对齐对跑七码检查
// 规格：docs/cleanroom/spec-07-translation-quality-check.md
// 只读站点数据；报告落 runs.statsJson；--propose 时把样例汇总成一条提案；不自动改站点。
import { checkAligned, QUALITY_CODES } from './quality.mjs';

export function samplesToTsv(samples) {
  const rows = [['code', 'chapter', 'jp', 'zh', 'detail']];
  for (const s of samples || []) {
    rows.push([s.code, s.chapter || s.chapterId || '', s.jp, s.zh, s.detail || '']);
  }
  return rows
    .map((r) => r.map((c) => String(c).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'))
    .join('\n');
}

export class CheckPipeline {
  constructor({ store, engine, makeClient, log = console, options = {} }) {
    this.store = store;
    this.engine = engine;
    this.makeClient = makeClient;
    this.log = log;
    this.options = {
      translator: 'gpt',
      limit: 50,       // 样例上限
      propose: false,  // 是否把样例汇总成提案
      codes: null,     // 只保留指定码（null = 全部）
      ...options,
    };
  }

  async runBook(bookKey, { signal, options } = {}) {
    const opt = { ...this.options, ...(options || {}) };
    const holder = `daemon:${process.pid}:check`;
    if (!this.store.acquireLock(bookKey, holder)) throw new Error('同书已有运行器在跑（锁被占用）');
    const runId = this.store.startRun(bookKey, 'check');
    const t0 = Date.now();
    try {
      const book = this.store.getBook(bookKey);
      if (!book) throw new Error(`book 不存在: ${bookKey}`);
      const client = this.makeClient(book);
      this.log.log(`[check] ${book.key}（${book.kind} @ ${book.origin}）`);

      const glossary = await client.getGlossary(book);
      const aligned = await client.getAlignedPairs(book, (m) => this.log.log(`[check] ${m}`));
      const retriesByChapter = {};
      for (const row of this.store.listChapterMeta(bookKey)) {
        if ((row.retries || 0) >= 2) retriesByChapter[row.chapterKey] = row.retries;
      }
      // TEXT_PRESERVE 实装后需要真实规则（全局 + 本书；enabled 由 compileRules 过滤由 collectPreserveSegments 内部完成）
      const preserveRules = this.store.listRules(bookKey).filter((r) => r.kind === 'text_preserve');
      // 警告落库：行号 = 该章内配对序号（1 基）；-1 表示整书级（如缺译标记）
      const lineNos = [];
      const perChapter = {};
      for (const p of aligned.pairs || []) {
        const ch = p.chapterId || '';
        perChapter[ch] = (perChapter[ch] || 0) + 1;
        lineNos.push(perChapter[ch]);
      }
      const warningRows = [];
      const report = checkAligned({
        pairs: aligned.pairs,
        glossary,
        engine: this.engine,
        rules: preserveRules,
        translationMissing: aligned.translationMissing || 0,
        retriesByChapter,
        limit: Math.max(1, Number(opt.limit) || 50),
        codes: Array.isArray(opt.codes) && opt.codes.length > 0 ? opt.codes : null,
        onHit: (pairIndex, hit, pair) => {
          warningRows.push({
            chapterId: pairIndex >= 0 ? ((pair && pair.chapterId) || '') : '',
            lineNo: pairIndex >= 0 ? (lineNos[pairIndex] || 0) : 0,
            code: hit.code,
            detail: hit.detail || '',
            evidence: hit.evidence || null,
          });
        },
      });
      const stored = this.store.replaceWarnings(bookKey, runId, warningRows);
      const hits = Object.values(report.codes).reduce((a, b) => a + b, 0);
      const summary = Object.entries(report.codes).map(([k, v]) => `${k}=${v}`).join(' ') || '无';
      this.log.log(`[check] 配对 ${report.pairs}（缺译 ${report.translationMissing}）：命中 ${hits}（${summary}）；警告落库 ${stored} 条`);

      const stats = {
        translator: opt.translator,
        pairs: report.pairs,
        translationMissing: report.translationMissing,
        codes: report.codes,
        hits,
        warningsStored: stored,
        samples: report.samples,
        requests: 0,
        ms: Date.now() - t0,
      };
      let proposalId = null;
      if (opt.propose && report.samples.length > 0) {
        proposalId = this.store.addProposal({
          bookKey,
          kind: 'quality',
          entries: report.samples,
          note: `质检报告：命中 ${hits} 处（${Object.keys(report.codes).join('、')}）`,
        });
        this.log.log(`[propose] 质检样例进提案（id=${proposalId}）`);
      }
      this.store.finishRun(runId, 'done', stats);
      this.store.setBookState(bookKey, 'done');
      return { stats, proposalId };
    } catch (e) {
      const state = e && e.code === 'unauthorized' ? 'need-auth' : 'failed';
      this.store.finishRun(runId, state, { error: String((e && e.message) || e) });
      this.store.setBookState(bookKey, state);
      throw e;
    } finally {
      this.store.releaseLock(bookKey, holder);
    }
  }
}

export { QUALITY_CODES };
