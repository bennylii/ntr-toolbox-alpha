// daemon/lg-align.mjs —— LG 译文结果对齐导入（导出源文 / 校验 / 行号映射）
// 兼容事实：LG 的 TXT 格式一行一条 item、解析保留原始行号（空行也是条目）、
// 写出 effective_dst() 逐行 join（空译文回退原文）→ 结果行数与行号和输入天然一致。
// 对齐保证 = 配对使用 export-src（清单）→ LG 翻译 → import-lg（总行数 + 每章行数 + 空模式 + 源 sha1 校验）。
import crypto from 'node:crypto';

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
