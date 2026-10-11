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

// ---- 站点导出格式（mode=jp）自动对齐 ----
// 另一种常见来路：站点简介页「下载原文」拿到的是 mode=jp 整本导出——头部（书名/作者/标签/统计）→
// `############` → 简介，之后每章 = `# 标题` + 1 结构空行 + 逐段正文，章块之间还有结构空行；
// 卷/分组标题自身也占「# 标题 + 空行」两行（它们没有对应章条目，靠下面的 ±2 偏移窗口兜住）。
// LG 翻完仍是同格式（LG 保行数），所以可以按「站点原文与译文逐行同构」把它折回契约行数组。

// 离线可判：像站点导出格式（有 `############` 分隔行或 `# ` 标题行）
export function looksLikeSiteFormat(lines) {
  const list = lines || [];
  return list.some((l) => String(l).trim() === '############') || list.some((l) => /^#\s/.test(String(l)));
}

// 站点格式译文 → 契约行数组。逐章 sha1 硬校验 + 逐段空/非空模式校验，任一章不过即失败（宁可拒绝，不导错位数据）。
// 返回 { ok:true, lines, chapters:[{chapterId,title,count,fileStart,titlePos,untranslated}], untranslated }
//    | { ok:false, reason }
export function convertSiteFormat({ zhLines, jpLines, manifest }) {
  const zh = zhLines || [];
  const jp = jpLines || [];
  const entries = (manifest && manifest.chapters) || [];
  const fail = (reason) => ({ ok: false, reason });
  if (entries.length === 0) return fail('清单没有章节条目');
  let pos = jp.findIndex((l) => /^#\s/.test(String(l)));
  if (pos < 0) return fail('站点原文里没有「# 」标题行（不是 mode=jp 整本导出？）');
  const chapters = [];
  const lines = [];
  let untranslated = 0;
  for (const entry of entries) {
    if (!/^#\s/.test(String(jp[pos] ?? ''))) {
      return fail(`清单第 ${entry.chapterId} 章（${entry.title || ''}）前找不到标题行（站点原文与清单不同步？）`);
    }
    const titlePos = pos;
    pos += 2;                       // 标题行 + 紧随其后的结构空行
    let hit = -1;                   // 规则偏移；卷/分组标题顶掉两行时在 ±2 窗口内找回
    for (const cand of [pos, pos - 1, pos + 1, pos - 2, pos + 2]) {
      if (cand < 0) continue;
      const block = jp.slice(cand, cand + entry.count);
      if (block.length === entry.count && sha1(block.join('\n')) === entry.jpSha1) { hit = cand; break; }
    }
    if (hit < 0) return fail(`清单第 ${entry.chapterId} 章（${entry.title || ''}）原文块对不上（站点原文已更新，或文件与导出时不是同一份）`);
    if (zh.length < hit + entry.count) return fail(`译文文件行数不足（第 ${entry.chapterId} 章要到第 ${hit + entry.count} 行，实有 ${zh.length} 行）`);
    const jpBlock = jp.slice(hit, hit + entry.count);
    const zhBlock = zh.slice(hit, hit + entry.count);
    for (let i = 0; i < entry.count; i += 1) {
      const jpEmpty = String(jpBlock[i] || '').trim() === '';
      const zhEmpty = String(zhBlock[i] || '').trim() === '';
      if (jpEmpty !== zhEmpty) return fail(`清单第 ${entry.chapterId} 章第 ${i + 1} 段空/非空模式与原文不符（译文与站点原文不是同一份导出？）`);
      if (!jpEmpty && zhBlock[i] === jpBlock[i]) untranslated += 1;
    }
    chapters.push({ chapterId: entry.chapterId, title: entry.title || '', count: entry.count, fileStart: hit, titlePos, untranslated });
    for (const l of zhBlock) lines.push(l);
    pos = hit + entry.count;
    while (pos < jp.length && String(jp[pos]) === '') pos += 1;   // 章块之间的结构空行
  }
  if (manifest.linesTotal && lines.length !== manifest.linesTotal) {
    return fail(`对齐后行数 ${lines.length} 与清单 ${manifest.linesTotal} 不符`);
  }
  return { ok: true, lines, chapters, untranslated };
}

// 站点整本原文（mode=jp）→ 行数组（站点格式译文的对齐基准；web 版可用，文库版站点没这个接口）
export async function fetchSiteExportLines(client, book) {
  const q = new URLSearchParams({ mode: 'jp', translationsMode: 'parallel', type: 'txt', filename: `jp.${book.novelId}.txt` });
  const pathname = book.kind === 'web'
    ? `/api/novel/${book.providerId}/${book.novelId}/file?${q}`
    : `/api/wenku/${book.novelId}/file?${q}`;
  return splitResultLines(await client.getText(pathname));
}

// 结果行 → 契约行：行数已符直接返回（零额外请求）；否则「像站点格式」时抓站点原文自动对齐。
// 对齐失败不抛错，原样返回 → 由 verifyImport 报原本的「行数不符」，行为可预期。
// 抓整本原文是一次 2MB 级请求，代理链路抖动时容易整场失败——用 rounds 轮次 + 轮间歇再试，
// 全轮失败时把原因放进 alignError（调用方拼进错误消息，别让用户只看到「行数不符」）。
// 返回 { lines, converted, note, sitefmt?, fatal?, alignError? }
export async function alignLgResult({ client, book, manifest, resultLines, log = null, rounds = 3, roundDelayMs = 2000 }) {
  const lines = resultLines || [];
  const say = (m) => { try { log && log(m); } catch { } };
  const expectedKey = manifest && manifest.book && manifest.book.key;
  if (expectedKey && book && book.key && expectedKey !== book.key) {
    return { lines, converted: false, note: '', fatal: `清单属于 ${expectedKey}，与当前项目 ${book.key} 不一致（选错了清单文件？）` };
  }
  if (lines.length === (manifest.linesTotal || 0)) return { lines, converted: false, note: '' };
  if (!looksLikeSiteFormat(lines)) return { lines, converted: false, note: '' };
  const total = Math.max(1, Math.floor(Number(rounds) || 1));
  let lastError = '';
  for (let round = 1; round <= total; round += 1) {
    try {
      const jpLines = await fetchSiteExportLines(client, book);
      const conv = convertSiteFormat({ zhLines: lines, jpLines, manifest });
      if (!conv.ok) {
        say(`  · 站点格式自动对齐未通过：${conv.reason}`);
        return { lines, converted: false, note: '', alignError: conv.reason };
      }
      const note = `已识别站点导出格式（mode=jp），并抓站点原文逐章 sha1 对齐 ${conv.chapters.length} 章`;
      return { lines: conv.lines, converted: true, note, sitefmt: { chapters: conv.chapters.length, untranslated: conv.untranslated } };
    } catch (e) {
      lastError = (e && e.message) || String(e);
      say(`  · 站点格式对齐第 ${round}/${total} 轮失败：${lastError}${round < total ? '（稍后重试）' : ''}`);
      if (round < total) await new Promise((r) => setTimeout(r, Math.max(0, Number(roundDelayMs) || 0) * round));
    }
  }
  return { lines, converted: false, note: '', alignError: lastError };
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
        const aligned = await alignLgResult({ client, book, manifest, resultLines: lines, log: (m) => log.log(m) });
        if (aligned.fatal) throw new Error(aligned.fatal);
        if (aligned.converted) report({ phase: 'verify', message: `${aligned.note}，逐章校验…` });
        const verified = await verifyImport({
          resultLines: aligned.lines,
          manifest,
          getChapter: (chapterId, volumeId) => client.getChapterTask(book, chapterId, 'gpt', volumeId),
        });
        if (verified.globalError) {
          throw new Error(aligned.alignError
            ? `${verified.globalError}（站点格式自动对齐失败：${aligned.alignError}——代理链路抖动时稍后重跑）`
            : verified.globalError);
        }
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
          converted: aligned.converted,
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
