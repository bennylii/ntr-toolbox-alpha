// daemon/lg-align.mjs —— LG 译文结果对齐导入（导出源文 / 校验 / 行号映射）
// 兼容事实：LG 的 TXT 格式一行一条 item、解析保留原始行号（空行也是条目）、
// 写出 effective_dst() 逐行 join（空译文回退原文）→ 结果行数与行号和输入天然一致。
// 对齐保证 = 配对使用 export-src（清单）→ LG 翻译 → import-lg（总行数 + 每章行数 + 空模式 + 源 sha1 校验）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha1 = (text) => crypto.createHash('sha1').update(String(text == null ? '' : text), 'utf8').digest('hex');

// 401（SiteClient 的 unauthorized/noRetry）：站点会话抖动也会偶发 401，先原地退避重试几次；
// 仍失败才算「凭据失效」，由调用方中止本批并转 need-auth（别把它当普通单章失败吞掉）。
// 注意只认「凭据」类 401：SiteClient 会把权限/封禁类的 401 标成 forbidden，那类重试与重推凭据都没用。
const isUnauthorized = (e) => !!(e && (e.code === 'unauthorized'
  || (!e.code && /401\s*(?:未授权|凭据失效)/.test(String(e.message || '')))));
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
const AUTH_RETRY_ATTEMPTS = 2;
const AUTH_RETRY_DELAY_MS = 8000;
// 断点续跑的稳定性口径：清单指纹（章 id/段数/原文 sha1）+ 逐章译文内容 sha
export function manifestFingerprint(manifest) {
  const entries = (manifest && manifest.chapters) || [];
  return sha1(entries.map((e) => `${e.chapterId}:${e.count}:${e.jpSha1}`).join('|'));
}
export function chapterContentSha(paragraphsZh) {
  return sha1((paragraphsZh || []).map((p) => String(p == null ? '' : p)).join('\u0000'));
}

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

// 站点导出里的「这章没有译文」标记——不是正文，是导出器写的占位行（出处见 docs/upstream-sync.md ④）：
//   web（makeTxt.kt）：该译者的译文整章缺失 → `GPT翻译缺失。` 等，后跟一个空行，正文一行不写；
//                      站点连原文都没了 → `该章节缺失。`
//   文库（WenkuNovelVolumeRepository.kt）：整章无译文 → `// 该分段翻译缺失。`（一行顶掉整章）
// 命中即按「该章译文全空」处理：按清单 count 行原位铺空串，未译章不再把整本对齐带崩
// （随后 verifyImport 的空/非空模式校验会把它判成不可提交，只跳过这一章）。
const MISSING_TRANSLATION_MARKER = /^(?:(?:百度|有道|GPT|Sakura)翻译缺失。|该章节缺失。|\/\/\s*该分段翻译缺失。)$/;
export const isMissingTranslationMarker = (line) => MISSING_TRANSLATION_MARKER.test(String(line == null ? '' : line).trim());
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
// 按 `# 标题` 切块（块 = 标题行 + 其后直到下一个标题行的所有行）。站点整本导出（jp/zh 两侧）与
// 「折叠空行版」译文都用它定位章节；块序号在两侧一一对应（卷/分组标题自身也占一块）。
// 返回 [{ title, titlePos, lines }]
export function splitBlocks(lines) {
  const list = lines || [];
  const out = [];
  let cur = null;
  for (let i = 0; i < list.length; i += 1) {
    if (/^#\s/.test(String(list[i]))) {
      if (cur) out.push(cur);
      cur = { title: String(list[i]).replace(/^#\s*/, '').trim(), titlePos: i, lines: [] };
    } else if (cur) cur.lines.push(String(list[i]));
  }
  if (cur) out.push(cur);
  return out;
}

// 严格模式失败时的回落：有些来路的站点格式译文把连续空行折叠成了单个空行（行数与站点原文不同构），
// 绝对行号切片必然错位。这里改用「块序号一一对应 + 非空行顺序映射」：
//   原文块仍按标题后的 count 行 sha1 硬定位（与严格模式同一套窗口），译文块按块序号取，
//   要求两侧非空行数一致，再把译文非空行按序铺回原文段落数组（空段落原位回填空串）。
// 硬校验不打折：块数一致、逐章原文 sha1、逐章非空行数一致、重建行数 == 清单行数；任一章不过即整体拒绝。
// 返回 { ok:true, lines, chapters, untranslated, blankCollapsed:true } | { ok:false, reason }
export function convertSiteFormatLoose({ zhLines, jpLines, manifest }) {
  const zh = zhLines || [];
  const jp = jpLines || [];
  const entries = (manifest && manifest.chapters) || [];
  const fail = (reason) => ({ ok: false, reason });
  if (entries.length === 0) return fail('清单没有章节条目');
  const jpBlocks = splitBlocks(jp);
  const zhBlocks = splitBlocks(zh);
  if (jpBlocks.length === 0) return fail('站点原文里没有「# 」标题行（不是 mode=jp 整本导出？）');
  if (zhBlocks.length !== jpBlocks.length) {
    return fail(`块数不一致：译文 ${zhBlocks.length} 块 / 站点原文 ${jpBlocks.length} 块（译文与站点原文不是同一份导出？）`);
  }
  const nonEmpty = (arr) => (arr || []).filter((l) => String(l).trim() !== '');
  // 块内锚定：标题后第 1/2 行起（第 1 行是结构空行，若首段本身是空段则要退到第 2 行），
  // 取 count 行且 sha1 命中，并要求块内剩余行全空（否则说明探进了下一块——卷标题块正文为空，窗口搜索会越界）。
  const matchChapterBlock = (block, entry) => {
    const end = block.titlePos + 1 + block.lines.length;   // 下一个标题行的位置（或文件尾）
    for (const start of [block.titlePos + 2, block.titlePos + 1, block.titlePos + 3, block.titlePos + 4]) {
      if (start < block.titlePos + 1 || start + entry.count > end) continue;   // 起始位置与切片都必须落在本块内
      const slice = jp.slice(start, start + entry.count);
      if (slice.length !== entry.count) continue;
      if (sha1(slice.join('\n')) !== entry.jpSha1) continue;
      if (jp.slice(start + entry.count, end).some((l) => String(l).trim() !== '')) continue;
      return slice;
    }
    return null;
  };
  const chapters = [];
  const lines = [];
  let untranslated = 0;
  let ei = 0;
  for (let k = 0; k < jpBlocks.length && ei < entries.length; k += 1) {
    const entry = entries[ei];
    const jpBlock = matchChapterBlock(jpBlocks[k], entry);
    if (!jpBlock) continue;   // 不对应章节的块（卷/分组标题）；整本对不齐时由下面的「还有 N 章没找到」兜住
    const zhBody = zhBlocks[k].lines;
    const zhNE = nonEmpty(zhBody);
    const jpNE = nonEmpty(jpBlock);
    // 该块整章是「缺译标记」→ 视为零行译文，按原文段落数原位铺空串
    const marked = zhNE.length === 1 && isMissingTranslationMarker(zhNE[0]);
    if (!marked && zhNE.length !== jpNE.length) {
      return fail(`清单第 ${entry.chapterId} 章（${entry.title || ''}）译文非空行数 ${zhNE.length} 与原文非空段落数 ${jpNE.length} 不符（译文与站点原文不是同一份导出？）`);
    }
    if (marked) untranslated += jpNE.length;
    else for (let i = 0; i < zhNE.length; i += 1) if (zhNE[i] === jpNE[i]) untranslated += 1;
    let cur = 0;
    for (const p of jpBlock) lines.push(String(p).trim() === '' || marked ? '' : zhNE[cur++]);
    chapters.push({ chapterId: entry.chapterId, title: entry.title || '', count: entry.count, fileStart: zhBlocks[k].titlePos, titlePos: jpBlocks[k].titlePos, untranslated, missing: marked });
    ei += 1;
  }
  if (ei !== entries.length) {
    const miss = entries[ei];
    return fail(`清单第 ${miss.chapterId} 章（${miss.title || ''}）在导出里找不到对应原文块（站点原文已更新，或文件与导出时不是同一份）`);
  }
  if (manifest.linesTotal && lines.length !== manifest.linesTotal) {
    return fail(`对齐后行数 ${lines.length} 与清单 ${manifest.linesTotal} 不符`);
  }
  return { ok: true, lines, chapters, untranslated, blankCollapsed: true };
}
export async function fetchSiteExportLines(client, book) {
  const q = new URLSearchParams({ mode: 'jp', translationsMode: 'parallel', type: 'txt', filename: `jp.${book.novelId}.txt` });
  return splitResultLines(await client.getText(`/api/novel/${book.providerId}/${book.novelId}/file?${q}`));
}

// 结果行 → 契约行：行数已符直接返回（零额外请求）；否则「像站点格式」时抓站点原文自动对齐。
// 对齐失败不抛错，原样返回 → 由 verifyImport 报原本的「行数不符」，行为可预期。
// 抓整本原文是一次 2MB 级请求，代理链路抖动时容易整场失败——用 rounds 轮次 + 轮间歇再试，
// 全轮失败时把原因放进 alignError（调用方拼进错误消息，别让用户只看到「行数不符」）。
// 返回 { lines, converted, convertMode:'strict'|'loose'|'', note, sitefmt?, fatal?, alignError? }
export async function alignLgResult({ client, book, manifest, resultLines, log = null, rounds = 3, roundDelayMs = 2000 }) {
  const lines = resultLines || [];
  const say = (m) => { try { log && log(m); } catch { } };
  const expectedKey = manifest && manifest.book && manifest.book.key;
  if (expectedKey && book && book.key && expectedKey !== book.key) {
    return { lines, converted: false, convertMode: '', note: '', fatal: `清单属于 ${expectedKey}，与当前项目 ${book.key} 不一致（选错了清单文件？）` };
  }
  if (lines.length === (manifest.linesTotal || 0)) return { lines, converted: false, convertMode: '', note: '' };
  if (!looksLikeSiteFormat(lines)) return { lines, converted: false, convertMode: '', note: '' };
  const total = Math.max(1, Math.floor(Number(rounds) || 1));
  let lastError = '';
  for (let round = 1; round <= total; round += 1) {
    try {
      const jpLines = await fetchSiteExportLines(client, book);
      const conv = convertSiteFormat({ zhLines: lines, jpLines, manifest });
      if (conv.ok) {
        const note = `已识别站点导出格式（mode=jp），并抓站点原文逐章 sha1 对齐 ${conv.chapters.length} 章`;
        return { lines: conv.lines, converted: true, convertMode: 'strict', note, sitefmt: { chapters: conv.chapters.length, untranslated: conv.untranslated } };
      }
      // 严格模式按绝对行号切片；折叠空行版译文（连续空行被并成 1 个）必然错位 → 回落块序对齐
      const loose = convertSiteFormatLoose({ zhLines: lines, jpLines, manifest });
      if (loose.ok) {
        say(`  · 严格对齐未通过（${conv.reason}），改用折叠空行版块序对齐`);
        const note = `已识别站点导出格式（折叠空行版）：按块序 + 非空行映射对齐 ${loose.chapters.length} 章`;
        return { lines: loose.lines, converted: true, convertMode: 'loose', note, sitefmt: { chapters: loose.chapters.length, untranslated: loose.untranslated, blankCollapsed: true } };
      }
      say(`  · 站点格式自动对齐未通过：${conv.reason}；折叠空行版：${loose.reason}`);
      return { lines, converted: false, note: '', alignError: `${conv.reason}；折叠空行版：${loose.reason}` };
    } catch (e) {
      lastError = (e && e.message) || String(e);
      say(`  · 站点格式对齐第 ${round}/${total} 轮失败：${lastError}${round < total ? '（稍后重试）' : ''}`);
      if (round < total) await new Promise((r) => setTimeout(r, Math.max(0, Number(roundDelayMs) || 0) * round));
    }
  }
  return { lines, converted: false, convertMode: '', note: '', alignError: lastError };
}

// 校验 + 行号映射：
//   getChapter(chapterId, volumeId) → 章节 DTO（paragraphJp + glossaryId）
//   401 抖动自动退避重试（authRetryAttempts/authRetryDelayMs），仍 401 立即中止并返回 needAuth:true
//   返回 { ok, globalError, needAuth?, chapters:[{...entry, ok, reason, paragraphsZh, glossaryId}], untranslated, okCount, total }
export async function verifyImport({ resultLines, manifest, getChapter, authRetryAttempts = AUTH_RETRY_ATTEMPTS, authRetryDelayMs = AUTH_RETRY_DELAY_MS, onRetry = null }) {
  const lines = resultLines || [];
  const total = manifest.linesTotal || 0;
  if (lines.length !== total) {
    // 文库没有整本原文导出接口，站点格式那条自动对齐路径对它不成立——直接说清正确来路，别让用户对着「行数不符」猜
    return { ok: false, globalError: `行数不符：结果 ${lines.length} 行，清单 ${total} 行（行号无法对齐，拒绝导入）`, chapters: [], untranslated: 0, okCount: 0, total: (manifest.chapters || []).length };
  }
  const out = [];
  let untranslated = 0;
  let okCount = 0;
  const entries = manifest.chapters || [];
  for (let ei = 0; ei < entries.length; ei += 1) {
    const entry = entries[ei];
    const range = lines.slice(entry.start, entry.start + entry.count);
    let reason = '';
    let dto = null;
    for (let attempt = 0; attempt <= Math.max(0, Number(authRetryAttempts) || 0); attempt += 1) {
      try {
        dto = await getChapter(entry.chapterId, entry.volumeId);
        reason = '';
        break;
      } catch (e) {
        if (isUnauthorized(e)) {
          if (attempt < Math.max(0, Number(authRetryAttempts) || 0)) {
            if (onRetry) { try { onRetry(attempt + 1, e, entry); } catch { } }
            await sleep(authRetryDelayMs);
            continue;
          }
          return {
            ok: false, needAuth: true, chapters: out, untranslated, okCount, total: out.length,
            globalError: `401 未授权：站点凭据失效（已校验 ${out.length}/${entries.length} 章）——重新同步凭据后可续跑`,
          };
        }
        reason = `章节获取失败：${String((e && e.message) || e).slice(0, 160)}`;
        break;
      }
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

// 逐章提交（只传 ok 章；limit>0 限量）；上传契约与站点 GPT 工作区一致。
// 401：原地退避重试几次，仍失败即停止本批（stopped:'need-auth'，不再逐章发无效请求）；
// onUploaded(c) 在每章提交成功后回调（runner 用它落断点状态）。
export async function applyImportReport(client, book, report, {
  limit = 0, onProgress = null, onUploaded = null,
  authRetryAttempts = AUTH_RETRY_ATTEMPTS, authRetryDelayMs = AUTH_RETRY_DELAY_MS, onRetry = null,
} = {}) {
  let uploaded = 0;
  let failed = 0;
  let stopped = '';
  const results = [];
  const okTotal = report.chapters.filter((c) => c.ok).length;
  for (const c of report.chapters) {
    if (!c.ok) continue;
    if (limit > 0 && uploaded >= limit) break;
    let done = false;
    for (let attempt = 0; attempt <= Math.max(0, Number(authRetryAttempts) || 0); attempt += 1) {
      try {
        await client.uploadChapter(book, c.chapterId, { glossaryId: c.glossaryId, paragraphsZh: c.paragraphsZh }, 'gpt', c.volumeId);
        done = true;
        break;
      } catch (e) {
        if (isUnauthorized(e)) {
          if (attempt < Math.max(0, Number(authRetryAttempts) || 0)) {
            if (onRetry) { try { onRetry(attempt + 1, e, c); } catch { } }
            await sleep(authRetryDelayMs);
            continue;
          }
          stopped = 'need-auth';
          results.push({ chapterId: c.chapterId, title: c.title || '', status: 'failed', error: '401 未授权（已停止本批，同步凭据后可续跑）' });
          break;
        }
        failed += 1;
        results.push({ chapterId: c.chapterId, title: c.title || '', status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
        if (onProgress) onProgress(uploaded, { ...c, failed: true }, { failed });
        break;
      }
    }
    if (stopped) break;
    if (!done) continue;
    uploaded += 1;
    results.push({ chapterId: c.chapterId, title: c.title || '', status: 'uploaded', count: c.count });
    if (onUploaded) { try { onUploaded(c); } catch { } }
    if (onProgress) onProgress(uploaded, c, { failed });
  }
  return { uploaded, failed, pending: okTotal - uploaded - failed, stopped, results };
}

// 断点状态（chunks 表；forgetBook 会一并清掉）：{ manifestId, done:{ [chapterId]: {sha, at} }, updatedAt }
export const LG_IMPORT_STATE_KEY = 'lg-import-state';
export function readImportState(store, bookKey) {
  const st = store.getChunk(bookKey, LG_IMPORT_STATE_KEY);
  if (!st || typeof st !== 'object') return { manifestId: '', done: {}, updatedAt: 0 };
  return {
    manifestId: typeof st.manifestId === 'string' ? st.manifestId : '',
    done: st.done && typeof st.done === 'object' ? st.done : {},
    updatedAt: Number(st.updatedAt) || 0,
  };
}

// 队列 runner：读文件 → 校验 → 逐章提交；断点状态落 chunks（重跑跳过已提交章）；
// 401（重试仍失败）→ 置 book.state=need-auth、自动请求站点侧重推凭据、run 记 failed 并让 GUI 提示续跑。
// run 记录落库（任务页可见）
export function createLgImportRunner({ store, makeClient, log = console }) {
  return {
    async runBook(bookKey, { options = {}, progress = null } = {}) {
      const { txtPath, manifestPath, limit = 0 } = options;
      const report = (p) => { try { progress && progress(p); } catch { } };
      if (!txtPath || !manifestPath) throw Object.assign(new Error('lg-import 需要 options.txtPath 与 options.manifestPath'), { code: 'bad_options' });
      const book = store.getBook(bookKey);
      if (!book) throw new Error(`book 不存在：${bookKey}`);
      const runId = store.startRun(bookKey, 'lg-import');
      const state = readImportState(store, bookKey);
      const saveState = () => { try { store.putChunk(bookKey, LG_IMPORT_STATE_KEY, state); } catch { } };
      // 凭据失效收口：状态落库 + 帮用户发起「从站点同步」+ 进度打 need-auth，然后抛错让队列标 failed
      const finishNeedAuth = (message, stats) => {
        store.setBookState(bookKey, 'need-auth');
        try { store.setConfig('authRequest', { at: Date.now(), ua: 'daemon/lg-import' }); } catch { }
        const full = { ...stats, needAuth: true, message };
        report({ phase: 'need-auth', uploaded: stats.uploaded || 0, skipped: stats.skipped || 0, total: stats.total || 0, message: `${message}；已请求站点侧重推凭据（站点页面开着时几秒内到位），同步后点「继续提交」续跑` });
        store.finishRun(runId, 'failed', full);
        const err = new Error(message);
        err.lgFinalized = true;
        throw err;
      };
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
          authRetryAttempts: options.authRetryAttempts,
          authRetryDelayMs: options.authRetryDelayMs,
          onRetry: (n, e) => {
            log.log(`  401 抖动，重试 ${n}：${(e && e.message) || e}`);
            report({ phase: 'verify', message: `凭据 401（抖动），${Math.round(AUTH_RETRY_DELAY_MS / 1000)}s 后重试 ${n}/${AUTH_RETRY_ATTEMPTS}…` });
          },
        });
        if (verified.needAuth) return finishNeedAuth(verified.globalError, { total: verified.total, ok: verified.okCount, uploaded: 0, skipped: 0 });
        if (verified.globalError) {
          throw new Error(aligned.alignError
            ? `${verified.globalError}（站点格式自动对齐失败：${aligned.alignError}——代理链路抖动时稍后重跑）`
            : verified.globalError);
        }
        for (const c of verified.chapters) {
          if (!c.ok) log.log(`  ✗ ${c.title || c.chapterId}：${c.reason}`);
        }
        // 断点续跑：该章已按同一内容提交过 → 跳过（内容变了 sha 变，自然重传）
        state.manifestId = state.manifestId || manifestFingerprint(manifest);
        const todo = [];
        let skipped = 0;
        for (const c of verified.chapters) {
          if (!c.ok) continue;
          const prior = state.done[c.chapterId];
          if (prior && prior.sha === chapterContentSha(c.paragraphsZh)) { skipped += 1; continue; }
          todo.push(c);
        }
        const okTotal = verified.chapters.filter((c) => c.ok).length;
        const effectiveTotal = limit > 0 ? Math.min(limit, todo.length) : todo.length;
        report({
          phase: 'apply', uploaded: 0, failed: 0, total: effectiveTotal, okTotal, skipped, untranslated: verified.untranslated,
          message: `校验通过 ${verified.okCount}/${verified.total} 章，待提交 ${todo.length} 章${skipped ? `（断点跳过已完成 ${skipped} 章）` : ''}…`,
        });
        const applied = await applyImportReport(client, book, { chapters: todo }, {
          limit: Math.max(0, Number(limit) || 0),
          authRetryAttempts: options.authRetryAttempts,
          authRetryDelayMs: options.authRetryDelayMs,
          onUploaded: (c) => {
            state.done[c.chapterId] = { sha: chapterContentSha(c.paragraphsZh), at: Date.now() };
            state.updatedAt = Date.now();
            saveState();
          },
          onRetry: (n, e) => {
            log.log(`  401 抖动，重试 ${n}：${(e && e.message) || e}`);
            report({ phase: 'apply', uploaded: 0, failed: 0, total: effectiveTotal, okTotal, skipped, message: `凭据 401（抖动），${Math.round(AUTH_RETRY_DELAY_MS / 1000)}s 后重试 ${n}/${AUTH_RETRY_ATTEMPTS}…` });
          },
          onProgress: (n, c, extra) => {
            const processed = n + ((extra && extra.failed) || 0);
            log.log(`  已提交 ${n}：${c.title || c.chapterId}${c.failed ? '（失败）' : ''}`);
            report({
              phase: 'apply', uploaded: n, failed: (extra && extra.failed) || 0, processed, total: effectiveTotal, okTotal, skipped,
              current: c.title || c.chapterId,
              message: `提交中 ${processed}/${effectiveTotal}：${c.title || c.chapterId}${c.failed ? '（失败，继续）' : ''}`,
            });
          },
        });
        const stats = {
          total: verified.total, ok: verified.okCount, untranslated: verified.untranslated,
          uploaded: applied.uploaded, failed: applied.failed, pending: applied.pending,
          skipped, converted: aligned.converted,
        };
        if (applied.stopped === 'need-auth') return finishNeedAuth(`401 未授权：站点凭据失效（本批已停止，已提交 ${applied.uploaded} 章）`, stats);
        report({ phase: 'done', uploaded: applied.uploaded, failed: applied.failed, total: effectiveTotal, okTotal, skipped, untranslated: verified.untranslated, message: `完成：上传 ${applied.uploaded}，失败 ${applied.failed}，断点跳过 ${skipped}，未过校验 ${verified.total - verified.okCount}` });
        store.finishRun(runId, applied.uploaded === 0 && applied.failed > 0 ? 'failed' : 'done', stats);
        if (book.state === 'need-auth') store.setBookState(bookKey, 'done');
        return {
          stats: { ...stats, results: applied.results.slice(0, 100) },
        };
      } catch (e) {
        report({ phase: 'error', message: '失败：' + ((e && e.message) || e) });
        if (!(e && e.lgFinalized)) store.finishRun(runId, 'failed', { error: (e && e.message) || String(e) });
        throw e;
      }
    },
  };
}

// ---- 提交后回读校验：本地 txt vs 站点该译者的当前译文 ----
// 站点侧 = /file?mode=zh 整本导出（一次大请求）；本地侧 = 契约格式（按清单 start/count 切片）
// 或站点导出格式（按 `# 标题` 块序）。章节映射：站点导出里「有正文的块」按序对应章节
// （卷/分组标题块正文为空），清单缺省时用站点 TOC 取章节顺序；两侧章节数不符即拒绝。
// 返回 { ok, globalError, mode:'contract'|'site-format', okCount, total, chapters, mismatches, kanaLines }
export async function verifySubmitted({ client, book, resultLines, manifest = null, translator = 'gpt', onProgress = null }) {
  const lines = resultLines || [];
  const say = (m) => { try { onProgress && onProgress(m); } catch { } };
  const empty = (extra) => ({ ok: false, globalError: '', mode: '', okCount: 0, total: 0, chapters: [], mismatches: [], kanaLines: 0, ...extra });
  let entries = (manifest && Array.isArray(manifest.chapters) && manifest.chapters.length > 0) ? manifest.chapters : null;
  if (!entries) {
    say('读取站点章节表（TOC）…');
    const tasks = await client.getTranslateTasks(book, translator);
    entries = [];
    for (const t of tasks) for (const it of (t.toc || [])) if (it.chapterId) entries.push({ chapterId: it.chapterId, volumeId: t.volumeId || '', title: it.titleJp || '', count: 0, start: 0 });
  }
  if (entries.length === 0) return empty({ globalError: '没有可比对的章节（清单为空且站点 TOC 为空）' });
  say('拉取站点已提交译文（mode=zh 整本导出，11MB 级请求）…');
  const raw = await client.getBookZhText(book, null, { translator });
  const siteText = typeof raw === 'string' ? raw : ((raw && raw.text) || '');
  const siteChapters = splitBlocks(splitResultLines(siteText)).filter((b) => b.lines.some((l) => String(l).trim() !== ''));
  if (siteChapters.length !== entries.length) {
    return empty({ globalError: `站点导出的章节块数 ${siteChapters.length} 与章节数 ${entries.length} 不符（站点内容变化？），无法逐章比对` });
  }
  const totalLines = (manifest && manifest.linesTotal) || 0;
  const contract = totalLines > 0 && lines.length === totalLines;
  let localChapters = null;
  if (!contract) {
    if (!looksLikeSiteFormat(lines)) {
      return empty({ globalError: `本地文件既不是契约格式（行数 ${lines.length} ≠ 清单 ${totalLines || '?'}），也不像站点导出格式，无法逐章比对` });
    }
    localChapters = splitBlocks(lines).filter((b) => b.lines.some((l) => String(l).trim() !== ''));
    if (localChapters.length !== entries.length) {
      return empty({ globalError: `本地文件的章节块数 ${localChapters.length} 与章节数 ${entries.length} 不符，无法逐章比对` });
    }
  }
  const kana = /[\u3040-\u309f\u30a0-\u30ff]/;
  const ne = (a) => (a || []).filter((l) => String(l).trim() !== '');
  // 整章只有一行「翻译缺失」标记 == 该章没有译文：保留标记文本再比（同标记才算一致；
  // 「本地百度翻译缺失。 vs 站点 GPT翻译缺失。」这类不同标记要如实报不一致，不折叠成空蒙混过关）
  const neNoMarker = (a) => {
    const list = ne(a);
    return (list.length === 1 && isMissingTranslationMarker(list[0])) ? [String(list[0]).trim()] : list;
  };
  const chapters = [];
  const mismatches = [];
  let okCount = 0;
  let kanaLines = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const mine = neNoMarker(contract ? lines.slice(entry.start, entry.start + entry.count) : localChapters[i].lines);
    const theirs = neNoMarker(siteChapters[i].lines);
    let hits = 0;
    for (let k = 0; k < Math.min(mine.length, theirs.length); k += 1) if (mine[k] === theirs[k]) hits += 1;
    let first = null;
    if (hits !== mine.length || mine.length !== theirs.length) {
      for (let k = 0; k < Math.max(mine.length, theirs.length); k += 1) {
        if (mine[k] !== theirs[k]) { first = { line: k + 1, local: String(mine[k] == null ? '' : mine[k]).slice(0, 60), site: String(theirs[k] == null ? '' : theirs[k]).slice(0, 60) }; break; }
      }
    }
    const ok = hits === mine.length && mine.length === theirs.length;
    const kanaN = theirs.filter((l) => kana.test(l)).length;
    kanaLines += kanaN;
    if (ok) okCount += 1;
    const row = { chapterId: entry.chapterId, title: entry.title || '', ok, localLines: mine.length, siteLines: theirs.length, hits, kanaLines: kanaN, first };
    chapters.push(row);
    if (!ok) mismatches.push(row);
    if (onProgress && (i + 1) % 100 === 0) say(`比对中 ${i + 1}/${entries.length}…`);
  }
  return { ok: okCount === entries.length, globalError: '', mode: contract ? 'contract' : 'site-format', okCount, total: entries.length, chapters, mismatches, kanaLines };
}

// 队列 runner：拉站点已提交译文与本地 txt 逐章比对；结果落 runs（任务页可见）
export function createLgReadbackRunner({ store, makeClient, log = console }) {
  return {
    async runBook(bookKey, { options = {}, progress = null } = {}) {
      const { txtPath, manifestPath = '', translator = 'gpt' } = options;
      const report = (p) => { try { progress && progress(p); } catch { } };
      if (!txtPath) throw Object.assign(new Error('lg-readback 需要 options.txtPath（要核对的本地译文）'), { code: 'bad_options' });
      const book = store.getBook(bookKey);
      if (!book) throw new Error(`book 不存在：${bookKey}`);
      const runId = store.startRun(bookKey, 'lg-readback');
      try {
        report({ phase: 'verify', message: '读取本地译文…' });
        const lines = splitResultLines(fs.readFileSync(txtPath, 'utf8'));
        const manifest = manifestPath && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
        const client = makeClient(book);
        const result = await verifySubmitted({ client, book, resultLines: lines, manifest, translator, onProgress: (m) => report({ phase: 'verify', message: m }) });
        if (result.globalError) throw new Error(result.globalError);
        for (const m of result.mismatches.slice(0, 50)) {
          log.log(`  ✗ ${m.title || m.chapterId}：本地 ${m.localLines} 行 / 站点 ${m.siteLines} 行（命中 ${m.hits}）${m.first ? ` 首差第 ${m.first.line} 行：${m.first.local} ↔ ${m.first.site}` : ''}`);
        }
        const stats = { total: result.total, ok: result.okCount, mode: result.mode, kanaLines: result.kanaLines, mismatches: result.mismatches.slice(0, 100) };
        report({
          phase: 'done', okCount: result.okCount, total: result.total,
          message: `回读校验：${result.okCount}/${result.total} 章与本地一致${result.mismatches.length ? `，不一致 ${result.mismatches.length} 章` : ''}${result.kanaLines ? ` · 站点侧假名残留 ${result.kanaLines} 行` : ''}`,
        });
        store.finishRun(runId, result.okCount === result.total ? 'done' : 'failed', stats);
        return { stats };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (isUnauthorized(e)) {
          store.setBookState(bookKey, 'need-auth');
          try { store.setConfig('authRequest', { at: Date.now(), ua: 'daemon/lg-readback' }); } catch { }
          report({ phase: 'need-auth', message: `${msg}；已请求站点侧重推凭据，同步后重跑` });
        } else {
          report({ phase: 'error', message: '失败：' + msg });
        }
        store.finishRun(runId, 'failed', { error: msg, needAuth: isUnauthorized(e) || undefined });
        throw e;
      }
    },
  };
}
