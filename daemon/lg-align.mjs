// daemon/lg-align.mjs —— LG 译文结果对齐导入（导出源文 / 校验 / 行号映射）
// 兼容事实：LG 的 TXT 格式一行一条 item、解析保留原始行号（空行也是条目）、
// 写出 effective_dst() 逐行 join（空译文回退原文）→ 结果行数与行号和输入天然一致。
// 对齐保证 = 配对使用 export-src（清单）→ LG 翻译 → import-lg（总行数 + 每章行数 + 空模式 + 源 sha1 校验）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha1 = (text) => crypto.createHash('sha1').update(String(text == null ? '' : text), 'utf8').digest('hex');

export const MANIFEST_VERSION = 1;

// 收集逐章原文（需要 SiteClient；translatorId 固定 gpt——段落与翻译器无关）
export async function collectChapters(client, book, onProgress = null) {
  const tasks = await client.getTranslateTasks(book, 'gpt');
  const chapters = [];
  for (const task of tasks) {
    for (const item of task.toc || []) {
      if (!item.chapterId) continue;
      const dto = await client.getChapterTask(book, item.chapterId, 'gpt', task.volumeId);
      chapters.push({
        chapterId: item.chapterId,
        volumeId: task.volumeId || '',
        title: item.titleJp || '',
        paragraphs: (dto.paragraphJp || []).map((p) => String(p == null ? '' : p)),
      });
      if (onProgress) onProgress(chapters.length, item.titleJp || item.chapterId);
    }
  }
  return chapters;
}

// chapters → { text, linesTotal, chapters: [条目] }；行号从 0 基 start 起
export function buildSourceExport(chapters) {
  const entries = [];
  const lines = [];
  let cursor = 0;
  for (const ch of chapters || []) {
    const paragraphs = (ch.paragraphs || []).map((p) => String(p == null ? '' : p));
    entries.push({
      chapterId: ch.chapterId,
      volumeId: ch.volumeId || '',
      title: ch.title || '',
      start: cursor,
      count: paragraphs.length,
      jpSha1: sha1(paragraphs.join('\n')),
    });
    for (const p of paragraphs) lines.push(p);
    cursor += paragraphs.length;
  }
  return { text: lines.join('\n'), linesTotal: lines.length, chapters: entries };
}

export function manifestOf(book, built) {
  return {
    version: MANIFEST_VERSION,
    book: { key: book.key, kind: book.kind, providerId: book.providerId || '', novelId: book.novelId },
    linesTotal: built.linesTotal,
    chapters: built.chapters,
    exportedAt: Date.now(),
  };
}

// LG 结果 txt → 行数组：容忍 BOM / CRLF / 末尾换行
export function splitResultLines(text) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (s === '') return [];
  return s.split('\n');
}

// 校验 + 行号映射：
//   getChapter(chapterId, volumeId) → 章节 DTO（paragraphJp + glossaryId）
//   返回 { ok, globalError, chapters:[{...entry, ok, reason, paragraphsZh, glossaryId}], untranslated, okCount, total }
export async function verifyImport({ resultLines, manifest, getChapter }) {
  const lines = resultLines || [];
  const total = manifest.linesTotal || 0;
  if (lines.length !== total) {
    return { ok: false, globalError: `行数不符：结果 ${lines.length} 行，清单 ${total} 行（行号无法对齐，拒绝导入）`, chapters: [], untranslated: 0, okCount: 0, total: (manifest.chapters || []).length };
  }
  const out = [];
  let untranslated = 0;
  let okCount = 0;
  for (const entry of manifest.chapters || []) {
    const range = lines.slice(entry.start, entry.start + entry.count);
    let reason = '';
    let dto = null;
    try {
      dto = await getChapter(entry.chapterId, entry.volumeId);
    } catch (e) {
      reason = `章节获取失败：${String((e && e.message) || e).slice(0, 160)}`;
    }
    if (!reason) {
      const jp = (dto && dto.paragraphJp) || null;
      if (!Array.isArray(jp) || jp.length !== entry.count) {
        reason = `段落行数不符：站点 ${jp ? jp.length : '?'} 段，清单 ${entry.count} 段`;
      } else if (sha1(jp.join('\n')) !== entry.jpSha1) {
        reason = '站点原文与导出时不一致（源站更新/漂移）';
      } else {
        for (let i = 0; i < entry.count; i += 1) {
          const srcEmpty = String(jp[i] || '').trim() === '';
          const dstEmpty = String(range[i] || '').trim() === '';
          if (srcEmpty !== dstEmpty) { reason = `第 ${entry.start + i + 1} 行空/非空模式不一致（疑似行错位）`; break; }
          if (!srcEmpty && range[i] === jp[i]) untranslated += 1;
        }
      }
    }
    const ok = reason === '';
    if (ok) okCount += 1;
    out.push({
      ...entry,
      ok,
      reason,
      glossaryId: dto && dto.glossaryId ? dto.glossaryId : '',
      paragraphsZh: ok ? range : null,
    });
  }
  return { ok: okCount === out.length, globalError: '', chapters: out, untranslated, okCount, total: out.length };
}

// ---- GUI / CLI 共用：导出 / 应用 / 队列 runner ----
// 导出原文+清单（outFile 缺省 = <exportsDir>/lg-src-<书名>.txt；同名覆盖）
export async function exportBookSource(client, book, { outFile = '', exportsDir = '', onProgress = null } = {}) {
  const chapters = await collectChapters(client, book, onProgress);
  if (chapters.length === 0) throw Object.assign(new Error('没有可导出的章节'), { code: 'no_chapters' });
  const built = buildSourceExport(chapters);
  const safe = String(book.title || book.novelId).replace(/[/|\:*?"<>]/g, '').slice(0, 60) || book.novelId;
  const file = outFile || path.join(exportsDir, `lg-src-${safe}.txt`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, built.text, 'utf8');
  const manifestFile = `${file}.manifest.json`;
  fs.writeFileSync(manifestFile, JSON.stringify(manifestOf(book, built), null, 2), 'utf8');
  return {
    file, manifestFile, linesTotal: built.linesTotal, chapters: built.chapters.length,
    titles: chapters.map((c) => c.title || c.chapterId).slice(0, 50),
  };
}

// 逐章提交（只传 ok 章；limit>0 限量）；上传契约与站点 GPT 工作区一致
export async function applyImportReport(client, book, report, { limit = 0, onProgress = null } = {}) {
  let uploaded = 0;
  let failed = 0;
  const results = [];
  const okTotal = report.chapters.filter((c) => c.ok).length;
  for (const c of report.chapters) {
    if (!c.ok) continue;
    if (limit > 0 && uploaded >= limit) break;
    try {
      await client.uploadChapter(book, c.chapterId, { glossaryId: c.glossaryId, paragraphsZh: c.paragraphsZh }, 'gpt', c.volumeId);
      uploaded += 1;
      results.push({ chapterId: c.chapterId, title: c.title || '', status: 'uploaded', count: c.count });
      if (onProgress) onProgress(uploaded, c, { failed });
    } catch (e) {
      failed += 1;
      results.push({ chapterId: c.chapterId, title: c.title || '', status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
      if (onProgress) onProgress(uploaded, { ...c, failed: true }, { failed });
    }
  }
  return { uploaded, failed, pending: okTotal - uploaded - failed, results };
}

// 队列 runner：读文件 → 校验 → 逐章提交；run 记录落库（任务页可见）
export function createLgImportRunner({ store, makeClient, log = console }) {
  return {
    async runBook(bookKey, { options = {}, progress = null } = {}) {
      const { txtPath, manifestPath, limit = 0 } = options;
      const report = (p) => { try { progress && progress(p); } catch { } };
      if (!txtPath || !manifestPath) throw Object.assign(new Error('lg-import 需要 options.txtPath 与 options.manifestPath'), { code: 'bad_options' });
      const book = store.getBook(bookKey);
      if (!book) throw new Error(`book 不存在：${bookKey}`);
      const runId = store.startRun(bookKey, 'lg-import');
      try {
        report({ phase: 'verify', message: '读取文件并逐章校验…' });
        const lines = splitResultLines(fs.readFileSync(txtPath, 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const client = makeClient(book);
        const verified = await verifyImport({
          resultLines: lines,
          manifest,
          getChapter: (chapterId, volumeId) => client.getChapterTask(book, chapterId, 'gpt', volumeId),
        });
        if (verified.globalError) throw new Error(verified.globalError);
        for (const c of verified.chapters) {
          if (!c.ok) log.log(`  ✗ ${c.title || c.chapterId}：${c.reason}`);
        }
        const okTotal = verified.chapters.filter((c) => c.ok).length;
        const effectiveTotal = limit > 0 ? Math.min(limit, okTotal) : okTotal;
        report({ phase: 'apply', uploaded: 0, failed: 0, total: effectiveTotal, okTotal, untranslated: verified.untranslated, message: `校验通过 ${verified.okCount}/${verified.total} 章，开始提交…` });
        const applied = await applyImportReport(client, book, verified, {
          limit: Math.max(0, Number(limit) || 0),
          onProgress: (n, c, extra) => {
            const processed = n + ((extra && extra.failed) || 0);
            log.log(`  已提交 ${n}：${c.title || c.chapterId}${c.failed ? '（失败）' : ''}`);
            report({
              phase: 'apply', uploaded: n, failed: (extra && extra.failed) || 0, processed, total: effectiveTotal, okTotal,
              current: c.title || c.chapterId,
              message: `提交中 ${processed}/${effectiveTotal}：${c.title || c.chapterId}${c.failed ? '（失败，继续）' : ''}`,
            });
          },
        });
        const stats = {
          total: verified.total, ok: verified.okCount, untranslated: verified.untranslated,
          uploaded: applied.uploaded, failed: applied.failed, pending: applied.pending,
        };
        report({ phase: 'done', uploaded: applied.uploaded, failed: applied.failed, total: effectiveTotal, okTotal, untranslated: verified.untranslated, message: `完成：上传 ${applied.uploaded}，失败 ${applied.failed}，未过校验 ${verified.total - verified.okCount}` });
        store.finishRun(runId, applied.uploaded === 0 && applied.failed > 0 ? 'failed' : 'done', stats);
        return {
          stats: { ...stats, results: applied.results.slice(0, 100) },
        };
      } catch (e) {
        report({ phase: 'error', message: '失败：' + ((e && e.message) || e) });
        store.finishRun(runId, 'failed', { error: (e && e.message) || String(e) });
        throw e;
      }
    },
  };
}
