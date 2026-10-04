// daemon/glossary-io.mjs —— LG 术语表互通（规格 docs/cleanroom/spec-10-glossary-interop.md）
// 导入：LG JSON（数组 [{src,dst,info,regex,case_sensitive}] 或 {src: dst} 映射）
//   - regex 条目 → rules 表（kind=pre_replacement，默认禁用，人工确认后启用）
//   - 其余 → 站点术语表候选（值 = dst + " #备注"）；指南门槛拦截的条目默认跳过（--propose 时进提案）
// 导出：站点术语表 → LG JSON（info 取自 " #备注"）
// 站点写入一律：快照 → 全量替换 → 回读校验。

export function parseLgGlossary(text) {
  let data;
  try { data = JSON.parse(String(text == null ? '' : text)); } catch (e) { throw new Error(`JSON 解析失败：${(e && e.message) || e}`); }
  const out = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const src = String(item.src == null ? '' : item.src).trim();
      const dst = String(item.dst == null ? '' : item.dst).trim();
      if (src === '' || dst === '') continue;
      out.push({
        src,
        dst,
        info: String(item.info == null ? '' : item.info).trim(),
        regex: item.regex === true,
        caseSensitive: item.case_sensitive === true,
      });
    }
  } else if (data && typeof data === 'object') {
    for (const [src, dst] of Object.entries(data)) {
      const s = String(src).trim();
      const d = String(dst == null ? '' : dst).trim();
      if (s === '' || d === '') continue;
      out.push({ src: s, dst: d, info: '', regex: false, caseSensitive: false });
    }
  } else {
    throw new Error('无法解析的 LG 术语表：需要 JSON 数组或 {src: dst} 映射');
  }
  const dedup = new Map();
  const duplicates = [];
  for (const entry of out) {
    if (dedup.has(entry.src)) duplicates.push(entry.src);
    dedup.set(entry.src, entry);   // 同 src 后者覆盖
  }
  return { entries: [...dedup.values()], duplicates };
}

// 站点术语表 → LG JSON 数组
export function toLgGlossary(glossary, engine) {
  const split = engine && typeof engine.splitGlossaryValue === 'function'
    ? engine.splitGlossaryValue
    : (raw) => ({ dst: String(raw == null ? '' : raw), note: '' });
  return Object.entries(glossary || {}).map(([src, raw]) => {
    const { dst, note } = split(raw);
    return { src, dst: String(dst || ''), info: String(note || ''), regex: false, case_sensitive: false };
  });
}

// 导入计划：分流 + 指南门槛 + 与现表 diff（不触网、不写库）
export function planImport({ entries, currentGlossary, engine }) {
  const current = currentGlossary || {};
  const additions = [];
  const updates = [];
  const same = [];
  const skipped = [];
  const regexRules = [];
  const noteIgnored = [];
  for (const entry of entries || []) {
    if (entry.regex) { regexRules.push(entry); continue; }
    if (entry.caseSensitive) noteIgnored.push(entry.src);
    const reasons = engine.suspectReasons(entry.src);
    if (engine.looksLikeSourceTampering(entry.src)) reasons.push('疑似改原文');
    if (reasons.length > 0) { skipped.push({ ...entry, reasons }); continue; }
    const value = engine.formatGlossaryValue(entry.dst, entry.info);
    if (!value) { skipped.push({ ...entry, reasons: ['值清洗后为空'] }); continue; }
    if (Object.prototype.hasOwnProperty.call(current, entry.src)) {
      if (current[entry.src] === value) same.push(entry.src);
      else updates.push({ src: entry.src, value, before: current[entry.src] });
    } else {
      additions.push({ src: entry.src, value });
    }
  }
  return { additions, updates, same, skipped, regexRules, noteIgnored };
}

// 应用：快照 → 全量替换 → 回读校验
export async function applyImport({ store, client, book, plan, currentGlossary, note = '' }) {
  const next = { ...(currentGlossary || {}) };
  for (const a of plan.additions) next[a.src] = a.value;
  for (const u of plan.updates) next[u.src] = u.value;
  const snapshotId = store.addSnapshot(book.key, currentGlossary || {}, note || `LG 导入：新增 ${plan.additions.length} / 更新 ${plan.updates.length}`);
  await client.putGlossaryRaw(book, next);
  const after = await client.getGlossary(book);
  const expectedKeys = Object.keys(next);
  const afterKeys = Object.keys(after || {});
  const verified = expectedKeys.length === afterKeys.length
    && expectedKeys.every((k) => after[k] === next[k]);
  return {
    snapshotId,
    applied: plan.additions.length + plan.updates.length,
    verified,
    afterCount: afterKeys.length,
    added: plan.additions.length,
    updated: plan.updates.length,
  };
}

// 回滚到快照：先存一份"回滚前"快照 → 全量替换 → 回读校验
export async function restoreSnapshot({ store, client, book, snapshotId, note = '' }) {
  const snap = store.getSnapshot(Number(snapshotId));
  if (!snap) throw new Error(`快照不存在：${snapshotId}`);
  const current = await client.getGlossary(book);
  const autoSnapshotId = store.addSnapshot(book.key, current, note || `回滚前自动快照（目标 #${snap.id}）`);
  const target = snap.glossary || {};
  await client.putGlossaryRaw(book, target);
  const after = await client.getGlossary(book);
  const keys = Object.keys(target);
  const verified = keys.length === Object.keys(after || {}).length && keys.every((k) => after[k] === target[k]);
  return { snapshotId: snap.id, autoSnapshotId, verified, count: keys.length };
}

// 应用提案（人工批准后）：verifyDrop 条目跳过，其余按值格式写入（快照 → 全量替换 → 回读校验）
export async function applyProposal({ store, client, book, proposal, engine, note = '' }) {
  const current = await client.getGlossary(book);
  const next = { ...current };
  let applied = 0;
  const skipped = [];
  for (const entry of (proposal && proposal.entries) || []) {
    if (entry && entry.verifyDrop === true) { skipped.push(String((entry && entry.src) || '')); continue; }
    const src = String((entry && entry.src) || '').trim();
    const dst = String((entry && entry.dst) || '').trim();
    const value = src !== '' && dst !== '' ? engine.formatGlossaryValue(dst, (entry && (entry.type || entry.info)) || '') : '';
    if (!value) { skipped.push(src || '(空)'); continue; }
    next[src] = value;
    applied += 1;
  }
  if (applied === 0) return { applied: 0, skipped, verified: true, snapshotId: 0, count: Object.keys(current).length };
  const snapshotId = store.addSnapshot(book.key, current, note || `应用提案 #${proposal.id}`);
  await client.putGlossaryRaw(book, next);
  const after = await client.getGlossary(book);
  const keys = Object.keys(next);
  const verified = keys.length === Object.keys(after || {}).length && keys.every((k) => after[k] === next[k]);
  return { applied, skipped, snapshotId, verified, count: keys.length };
}
