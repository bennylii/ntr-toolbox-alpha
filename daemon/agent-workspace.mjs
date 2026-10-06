// daemon/agent-workspace.mjs —— Agent 工作区（LG CodeAct 对的零依赖移植）
// workspace_run：模型写 JS 脚本 → fork --permission 沙箱子进程，ws 全局对象经 IPC 桥接；
//                数据靠工作区文件跨调用（数据集 JSONL + contract.json + reference/*.md），
//                变更靠写 changes/**.jsonl。120s 超时；stdout/stderr 全量落盘、进上下文每流截 64KiB。
// workspace_apply：参数空对象——变更清单在 changes/ 文件里；解析 → 对照当前事实（fp 漂移/缺失/冲突）→
//                  预览摘要 → 审批（requiresApproval 走 decision broker）→ 提交 → 回执
//                  {status: applied|partial|rejected|unchanged, applied, rejected, destroyed, results}；
//                  destroyed（fp 漂移/目标缺失）→ 清空 changes（快照下轮 run 自动重建）。
// 变更域 v1 = rules / glossary / prompts；章节译文提交不在此列（走 run_translate / import_lg_result）。
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { planImport, applyImport } from './glossary-io.mjs';

const FP_LEN = 4;
const RUN_TIMEOUT_MS = 120000;
const INLINE_OUTPUT_BYTES = 64 * 1024;
const DOING_MAX = 200;
const PROMPT_SLOTS = ['prefix', 'base', 'thinking', 'suffix'];
const RULE_KINDS = ['text_preserve', 'pre_replacement', 'post_replacement'];

const fp = (value) => crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url').slice(0, FP_LEN);
const jline = (obj) => JSON.stringify(obj);
const readJsonl = (file) => {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter((l) => l.trim() !== '');
};
const cut = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ---- 契约（一份 schema 三处消费：contract.json / ws.contract / reference 文档） ----
const CHANGE_SCHEMAS = {
  rules: {
    creates: '{ kind: "text_preserve"|"pre_replacement"|"post_replacement", pattern: string, replacement?: string, regex?: boolean, case_sensitive?: boolean, priority?: number, bookKey?: string（缺省=当前项目，""=全局） }',
    updates: '{ id: number, fp: WorkspaceFingerprint, enabled?: boolean }（至少 3 个字段）',
    deletes: '{ id: number, fp: WorkspaceFingerprint }',
    identity: 'id（updates/deletes）',
  },
  glossary: {
    creates: '{ src: string, dst: string, info?: string }（src 已存在时拒绝，应改用 updates）',
    updates: '{ src: string, fp: WorkspaceFingerprint, dst?: string, info?: string }（至少 3 个字段）',
    deletes: '{ src: string, fp: WorkspaceFingerprint }',
    identity: 'src；提交时合并进当前术语表 → 快照 → 全量替换 → 回读校验',
  },
  prompts: {
    updates: '{ kind: "prefix"|"base"|"thinking"|"suffix", fp: WorkspaceFingerprint, text: string }（全局四槽）',
    deletes: '{ kind: "prefix"|"base"|"thinking"|"suffix", fp: WorkspaceFingerprint }（= 清除覆盖回退默认）',
    identity: 'kind',
  },
};
const DATASETS = {
  project_meta: { path: 'project_meta.json', format: 'json', purpose: '当前项目（书）的 key/标题/状态/进度概览' },
  progress: { path: 'progress/entries.jsonl', format: 'jsonl', purpose: '章节进度（chapterKey/state/glossaryUuid）' },
  rules: { path: 'rules/entries.jsonl', format: 'jsonl', purpose: '文本处理链规则（全局 + 当前项目，行内带 fp）' },
  glossary: { path: 'glossary/entries.jsonl', format: 'jsonl', purpose: '站点术语表快照（src/dst/info，行内带 fp）' },
  prompts: { path: 'prompts.json', format: 'json', purpose: '全局提示词模板四槽（text/fp，null=默认）' },
  runs: { path: 'runs/entries.jsonl', format: 'jsonl', purpose: '最近 50 次 run（id/job/state/stats）' },
};
const APPLY_CONTRACT = {
  freshness: '提交时用 fp 核对变更行与当前事实；不匹配 → fp_mismatch，对象不存在 → target_missing',
  transaction: '逐 op 提交并回收执；glossary 域合并后走快照+全量替换+回读校验',
  partial_success: '被拒绝行记录在 rejected（原因 + 定位字段），其余照常提交',
  rejection_reasons: ['invalid_change', 'fp_mismatch', 'target_missing', 'merge_conflict'],
  destroyed: '出现 fp_mismatch 或 target_missing 时为 true：说明快照已过期，changes 会被清空、下轮 run 自动重建',
};

function writeReferenceDocs(root) {
  const refDir = path.join(root, 'reference');
  fs.mkdirSync(refDir, { recursive: true });
  const topicRows = Object.entries(DATASETS).map(([name, d]) => `- ws.contract.datasets.${name} → ${d.path}（${d.format}）：${d.purpose}`).join('\n');
  const changeRows = Object.entries(CHANGE_SCHEMAS).map(([name, k]) => {
    return `- changes/${name}/：\n  - creates.jsonl：${k.creates}\n  - updates.jsonl：${k.updates}\n  - deletes.jsonl：${k.deletes}\n  - identity：${k.identity}`;
  }).join('\n');
  fs.writeFileSync(path.join(refDir, 'workspace.md'), [
    '# 工作区参考',
    '',
    '## 数据集（只读，行内带 fp）',
    topicRows,
    '',
    '## 变更清单（workspace_apply 提交；只写 changes/**）',
    changeRows,
    '',
    '## apply 契约',
    Object.entries(APPLY_CONTRACT).map(([k, v]) => `- ${k}：${v}`).join('\n'),
    '',
    '## ws API',
    '- ws.contract：契约对象（本文件的机器版在 contract.json）',
    '- await ws.doing(text)：向用户汇报进度（≤200 字符）',
    '- await ws.read({ kind: "chapter", chapterId, volumeId? })：读章节正文 {paragraphJp, oldParagraphZh, glossaryId}（站点数据不落快照，按需拉取）',
    '',
    '## 沙箱边界',
    '- 文件：可读整个工作区；可写 changes/ 与 work/；其余拒绝',
    '- 禁止子进程 / worker / 原生扩展（Node --permission 默认拒绝）；网络可用（fetch）',
    '- 每次调用独立进程，120s 超时 SIGKILL；跨调用数据放文件',
  ].join('\n'), 'utf8');
}

// ---- 快照（数据集每次重建；changes 只在 workspace_run 时清空重置——LG 同款"run 前重建变更目录"） ----
async function ensureWorkspace(ctx, { freshChanges = false } = {}) {
  const deps = ctx.deps || {};
  if (!deps.workspaceRoot) throw Object.assign(new Error('工作区根未装配（workspaceRoot）'), { code: 'deps_unavailable' });
  const root = path.join(deps.workspaceRoot, String(ctx.sessionId || 'anon'));
  for (const dir of ['progress', 'rules', 'glossary', 'runs', 'reference', 'changes/rules', 'changes/glossary', 'changes/prompts', path.join('work', 'runs')]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const store = ctx.store;
  const bookKey = String(ctx.bookKey || '');
  const book = bookKey ? store.getBook(bookKey) : null;
  if (bookKey && !book) throw Object.assign(new Error(`book 不存在：${bookKey}`), { code: 'book_not_found' });

  const writeJsonl = (rel, rows) => fs.writeFileSync(path.join(root, rel), rows.map(jline).join('\n') + (rows.length ? '\n' : ''), 'utf8');

  const progressRows = bookKey ? store.listProgress(bookKey).map((p) => ({ chapterKey: p.chapterKey, state: p.state, glossaryUuid: p.glossaryUuid || '', fp: fp({ chapterKey: p.chapterKey, state: p.state, glossaryUuid: p.glossaryUuid || '' }) })) : [];
  const ruleRows = store.listRules(bookKey).map((r) => ({ ...r, fp: fp(r) }));
  const runRows = store.listRuns(50).filter((r) => !bookKey || r.bookKey === bookKey);
  let glossaryRows = [];
  if (book) {
    try {
      const glossary = await deps.makeClient(book).getGlossary(book);
      glossaryRows = Object.entries(glossary || {}).map(([src, value]) => ({ src, value, fp: fp({ src, value }) }));
    } catch (e) {
      glossaryRows = [];
    }
  }
  const promptRows = {};
  for (const slot of PROMPT_SLOTS) {
    const row = (store.listPrompts('') || []).find((p) => p.slot === slot && (p.bookKey || '') === '');
    // 默认槽也给出 fp（text=null 语义），模型才能对"设置首值"核对漂移
    promptRows[slot] = row ? { text: row.text, fp: fp({ slot, text: row.text }) } : { text: null, fp: fp({ slot, text: '' }) };
  }
  const meta = {
    bookKey,
    title: book ? book.title || '' : '',
    kind: book ? book.kind : '',
    origin: book ? book.origin || '' : '',
    state: book ? book.state || '' : '',
    progressCount: progressRows.length,
    glossaryCount: glossaryRows.length,
    generatedAt: Date.now(),
  };
  fs.writeFileSync(path.join(root, 'project_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  writeJsonl('progress/entries.jsonl', progressRows);
  writeJsonl('rules/entries.jsonl', ruleRows);
  writeJsonl('glossary/entries.jsonl', glossaryRows);
  writeJsonl('runs/entries.jsonl', runRows);
  fs.writeFileSync(path.join(root, 'prompts.json'), JSON.stringify(promptRows, null, 2), 'utf8');
  const contract = {
    datasets: DATASETS,
    changes: Object.fromEntries(Object.entries(CHANGE_SCHEMAS).map(([name, k]) => [name, { creates: `changes/${name}/creates.jsonl`, updates: `changes/${name}/updates.jsonl`, deletes: `changes/${name}/deletes.jsonl`, schema: k }])),
    apply: APPLY_CONTRACT,
    note: '数据集只读；变更只写 changes/**；章节译文提交不在工作区（用 run_translate / import_lg_result）',
  };
  fs.writeFileSync(path.join(root, 'contract.json'), JSON.stringify(contract, null, 2), 'utf8');
  writeReferenceDocs(root);
  // bootstrap 拷贝进工作区根（--allow-fs-read 只给 root；不能让子进程可读 daemon/ 目录——里面有数据库）
  fs.mkdirSync(path.join(root, 'work', 'runtime'), { recursive: true });
  fs.copyFileSync(new URL('./workspace-bootstrap.mjs', import.meta.url), path.join(root, 'work', 'runtime', 'bootstrap.mjs'));
  for (const domain of ['rules', 'glossary', 'prompts']) {
    for (const op of ['creates', 'updates', 'deletes']) {
      const file = path.join(root, 'changes', domain, `${op}.jsonl`);
      if (freshChanges || !fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
    }
  }
  return { root, meta };
}

// ---- workspace_run ----
function summarizeStream(file, label, limitBytes) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { path: label, bytes: 0, content: '' }; }
  const out = { path: label, bytes: buf.length };
  if (buf.length <= limitBytes) {
    const text = buf.toString('utf8');
    try { out.content = JSON.parse(text); } catch { out.content = text; }
  } else {
    out.message = '输出超长，请按需读取记录文件。';
  }
  return out;
}

function handleChildRequest(msg, ctx, client, child) {
  const req = msg && msg.request;
  const reply = (result) => { try { child && child.send({ type: 'response', id: msg.id, result }); } catch { } };
  if (!req || typeof req.kind !== 'string') return reply({ ok: false, message: '非法 ws 请求' });
  if (req.kind === 'doing') {
    const text = cut(req.text, DOING_MAX);
    ctx.onEvent && ctx.onEvent({ type: 'doing', text });
    return reply({ ok: true, value: null });
  }
  if (req.kind === 'read') {
    if (req.subkind !== 'chapter') return reply({ ok: false, message: 'read 仅支持 { kind:"read", subkind:"chapter", chapterId }' });
    const chapterId = String(req.chapterId || '');
    if (chapterId === '') return reply({ ok: false, message: 'read chapter 需要 chapterId' });
    client.getChapterTask(ctx.book, chapterId, 'gpt', String(req.volumeId || ''))
      .then((dto) => reply({ ok: true, value: { chapterId, paragraphJp: dto.paragraphJp || [], oldParagraphZh: dto.oldParagraphZh || null, glossaryId: dto.glossaryId || '' } }))
      .catch((e) => reply({ ok: false, message: cut(e && e.message, 300) }));
    return null;
  }
  return reply({ ok: false, message: `未知 ws 请求类型：${req.kind}` });
}

async function runScript(ctx, { root, script, client }) {
  const runId = crypto.randomBytes(6).toString('hex');
  const runDir = path.join(root, 'work', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const scriptPath = path.join(runDir, 'script.mjs');
  fs.writeFileSync(scriptPath, String(script || ''), 'utf8');
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  const bootstrapPath = path.join(root, 'work', 'runtime', 'bootstrap.mjs');
  let child;
  try {
    child = fork(scriptPath, [], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '' },
      execArgv: [
        '--permission',
        `--allow-fs-read=${root}`,
        `--allow-fs-write=${path.join(root, 'changes')}`,
        `--allow-fs-write=${path.join(root, 'work')}`,
        `--import=${pathToFileURL(bootstrapPath).href}`,
      ],
      stdio: ['ignore', outFd, errFd, 'ipc'],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  let signal = null;
  let timedOut = false;
  child.on('message', (msg) => {
    try { handleChildRequest(msg, ctx, client, child); } catch { }
  });
  child.send({ type: 'start' });
  const timer = setTimeout(() => { timedOut = true; signal = 'SIGKILL'; try { child.kill('SIGKILL'); } catch { } }, RUN_TIMEOUT_MS);
  const onAbort = () => { signal = 'SIGKILL'; try { child.kill('SIGKILL'); } catch { } };
  if (ctx.signal) {
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
  }
  const exitCode = await new Promise((resolve) => {
    child.once('exit', (code, sig) => { resolve(code === null ? null : code); if (sig && code === null) signal = sig; });
  });
  clearTimeout(timer);
  if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
  return {
    scriptPath: path.relative(root, scriptPath).split(path.sep).join('/'),
    exitCode,
    signal,
    timedOut,
    stdout: summarizeStream(stdoutPath, path.relative(root, stdoutPath).split(path.sep).join('/'), INLINE_OUTPUT_BYTES),
    stderr: summarizeStream(stderrPath, path.relative(root, stderrPath).split(path.sep).join('/'), INLINE_OUTPUT_BYTES),
  };
}

// ---- 变更解析 / 提交 ----
function parseChanges(root) {
  const intents = [];
  const rejected = [];
  const load = (domain, op, validate) => {
    const file = path.join(root, 'changes', domain, `${op}.jsonl`);
    readJsonl(file).forEach((line, idx) => {
      let row = null;
      try { row = JSON.parse(line); } catch (e) {
        rejected.push({ scope: domain, op, reason: 'invalid_change', line: idx + 1, message: '不是合法 JSON' });
        return;
      }
      const err = validate(row);
      if (err) { rejected.push({ scope: domain, op, reason: 'invalid_change', line: idx + 1, message: err }); return; }
      intents.push({ scope: domain, op, row });
    });
  };
  const isStr = (v) => typeof v === 'string';
  load('rules', 'creates', (r) => {
    if (!RULE_KINDS.includes(r.kind)) return 'kind 不合法';
    if (!isStr(r.pattern) || r.pattern === '') return 'pattern 必填';
    if (r.replacement !== undefined && !isStr(r.replacement)) return 'replacement 必须是字符串';
    return null;
  });
  load('rules', 'updates', (r) => {
    if (!Number.isInteger(r.id)) return 'id 必须是整数';
    if (!isStr(r.fp) || r.fp.length !== FP_LEN) return 'fp 缺失或不合法';
    if (Object.keys(r).length < 3) return '至少 3 个字段';
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return 'enabled 必须是布尔';
    return null;
  });
  load('rules', 'deletes', (r) => (!Number.isInteger(r.id) || !isStr(r.fp) || r.fp.length !== FP_LEN) ? '需要 {id, fp}' : null);
  load('glossary', 'creates', (r) => (!isStr(r.src) || r.src === '' || !isStr(r.dst) || r.dst === '') ? '需要 {src, dst}' : null);
  load('glossary', 'updates', (r) => {
    if (!isStr(r.src) || r.src === '') return 'src 必填';
    if (!isStr(r.fp) || r.fp.length !== FP_LEN) return 'fp 缺失或不合法';
    if (Object.keys(r).length < 3) return '至少 3 个字段';
    return null;
  });
  load('glossary', 'deletes', (r) => (!isStr(r.src) || r.src === '' || !isStr(r.fp) || r.fp.length !== FP_LEN) ? '需要 {src, fp}' : null);
  load('prompts', 'updates', (r) => {
    if (!PROMPT_SLOTS.includes(r.kind)) return 'kind 不合法';
    if (!isStr(r.fp) || r.fp.length !== FP_LEN) return 'fp 缺失或不合法';
    if (!isStr(r.text) || r.text.trim() === '') return 'text 必填';
    return null;
  });
  load('prompts', 'deletes', (r) => (!PROMPT_SLOTS.includes(r.kind) || !isStr(r.fp) || r.fp.length !== FP_LEN) ? '需要 {kind, fp}' : null);
  return { intents, rejected };
}

const identityOf = (intent) => {
  const r = (intent && intent.row) || {};
  return { id: r.id, src: r.src, kind: r.kind };
};

function ruleRowOf(store, id, bookKey) {
  return (store.listRules(bookKey) || []).find((r) => r.id === Number(id)) || null;
}

// 对照当前事实解析：产出 candidates（真正要提交的 op）与 rejected
async function resolveChanges(ctx, root) {
  const store = ctx.store;
  const deps = ctx.deps || {};
  const book = ctx.book || null;
  const { intents, rejected } = parseChanges(root);
  const candidates = [];
  const reject = (intent, reason, message) => rejected.push({ scope: intent.scope, op: intent.op, reason, message: message || '', ...identityOf(intent) });
  // 同批内冲突检测（同 identity 多行且字段冲突）
  const seen = new Map();
  for (const intent of intents) {
    const key = intent.scope + ':' + intent.op + ':' + JSON.stringify(identityOf(intent));
    const prev = seen.get(key);
    if (prev && JSON.stringify(prev.row) !== JSON.stringify(intent.row)) {
      reject(intent, 'merge_conflict', '同批内同 identity 的多行内容冲突');
      continue;
    }
    seen.set(key, intent);
    candidates.push(intent);
  }
  // 逐条对照当前事实
  const glossaryCurrent = book && deps.makeClient ? await deps.makeClient(book).getGlossary(book).catch(() => ({})) : {};
  const promptRows = {};
  for (const slot of PROMPT_SLOTS) {
    const row = (store.listPrompts('') || []).find((p) => p.slot === slot && (p.bookKey || '') === '');
    promptRows[slot] = row ? { text: row.text, fp: fp({ slot, text: row.text }) } : { text: null, fp: fp({ slot, text: '' }) };
  }
  const out = [];
  let destroyed = false;
  for (const intent of candidates) {
    const { scope, op, row } = intent;
    if (scope === 'rules') {
      if (op === 'creates') { out.push({ ...intent, current: null }); continue; }
      const cur = ruleRowOf(store, row.id, ctx.bookKey);
      if (!cur) { reject(intent, 'target_missing', '规则不存在'); destroyed = true; continue; }
      if (cur.fp !== row.fp) { reject(intent, 'fp_mismatch', '规则已被外部修改'); destroyed = true; continue; }
      if (op === 'updates' && (row.enabled === undefined || row.enabled === (cur.enabled === 1))) { out.push({ ...intent, unchanged: true }); continue; }
      out.push(intent);
      continue;
    }
    if (scope === 'glossary') {
      if (!book) { reject(intent, 'target_missing', '会话未绑定项目，glossary 变更不可用'); continue; }
      const curValue = Object.prototype.hasOwnProperty.call(glossaryCurrent, row.src) ? glossaryCurrent[row.src] : null;
      if (op === 'creates') {
        if (curValue !== null) { reject(intent, 'merge_conflict', 'src 已存在，应使用 updates'); continue; }
        out.push(intent);
        continue;
      }
      if (curValue === null) { reject(intent, 'target_missing', '术语不存在'); destroyed = true; continue; }
      if (fp({ src: row.src, value: curValue }) !== row.fp) { reject(intent, 'fp_mismatch', '术语已被外部修改'); destroyed = true; continue; }
      if (op === 'updates' && row.dst === undefined && row.info === undefined) { out.push({ ...intent, unchanged: true }); continue; }
      if (op === 'updates' && row.dst !== undefined) {
        const nextValue = row.dst + (row.info ? ` #${row.info}` : '');
        if (nextValue === curValue) { out.push({ ...intent, unchanged: true }); continue; }
      }
      out.push(intent);
      continue;
    }
    if (scope === 'prompts') {
      const cur = promptRows[row.kind];
      if (op === 'updates') {
        if (cur.fp !== row.fp) { reject(intent, 'fp_mismatch', '提示词已被外部修改'); destroyed = true; continue; }
        if (cur.text === row.text) { out.push({ ...intent, unchanged: true }); continue; }
        out.push(intent);
        continue;
      }
      if (!cur.text) { reject(intent, 'target_missing', '该槽已是默认值'); continue; }
      if (cur.fp !== row.fp) { reject(intent, 'fp_mismatch', '提示词已被外部修改'); destroyed = true; continue; }
      out.push(intent);
      continue;
    }
    reject(intent, 'invalid_change', '未知域');
  }
  return { candidates: out, rejected, destroyed, glossaryCurrent, promptRows };
}

function summarizeResolved(resolved) {
  const counts = { rules: 0, glossary: 0, prompts: 0 };
  let unchanged = 0;
  for (const c of resolved.candidates) {
    if (c.unchanged) { unchanged += 1; continue; }
    counts[c.scope] = (counts[c.scope] || 0) + 1;
  }
  return { counts, unchanged, rejected: resolved.rejected };
}

async function commitResolved(ctx, root, resolved) {
  const store = ctx.store;
  const deps = ctx.deps || {};
  const book = ctx.book || null;
  const results = [];
  const applied = { rules: 0, glossary: 0, prompts: 0 };
  let failed = 0;
  for (const c of resolved.candidates) {
    if (c.unchanged) {
      results.push({ scope: c.scope, op: c.op, ...identityOf(c), status: 'unchanged' });
      continue;
    }
    try {
      if (c.scope === 'rules') {
        if (c.op === 'creates') {
          store.addRule({
            bookKey: c.row.bookKey === undefined ? (ctx.bookKey || '') : String(c.row.bookKey || ''),
            kind: c.row.kind,
            pattern: String(c.row.pattern),
            replacement: c.row.replacement === undefined ? '' : String(c.row.replacement),
            regex: c.row.regex ? 1 : 0,
            case_sensitive: c.row.case_sensitive ? 1 : 0,
            enabled: 1,
            priority: Number(c.row.priority) || 100,
          });
        } else if (c.op === 'updates') {
          store.setRuleEnabled(Number(c.row.id), c.row.enabled !== false);
        } else {
          store.deleteRule(Number(c.row.id));
        }
        applied.rules += 1;
        results.push({ scope: c.scope, op: c.op, ...identityOf(c), status: 'success' });
      } else if (c.scope === 'prompts') {
        if (c.op === 'updates') store.setPrompt('', c.row.kind, String(c.row.text));
        else store.clearPrompt('', c.row.kind);
        applied.prompts += 1;
        results.push({ scope: c.scope, op: c.op, kind: c.row.kind, status: 'success' });
      }
      // glossary 域统一在下方合并提交
    } catch (e) {
      failed += 1;
      results.push({ scope: c.scope, op: c.op, ...identityOf(c), status: 'failed', detail: cut(e && e.message, 200) });
    }
  }
  // glossary：合并 creates/updates/deletes → planImport → applyImport（快照 + 全量替换 + 回读校验）
  const glossaryOps = resolved.candidates.filter((c) => c.scope === 'glossary' && !c.unchanged);
  if (glossaryOps.length > 0 && book && deps.makeClient && deps.engine) {
    const cur = resolved.glossaryCurrent || {};
    const split = (value) => {
      const s = String(value == null ? '' : value);
      const at = s.indexOf(' #');
      return at >= 0 ? { dst: s.slice(0, at), info: s.slice(at + 2) } : { dst: s, info: '' };
    };
    const next = { ...cur };
    for (const c of glossaryOps) {
      if (c.op === 'deletes') { delete next[c.row.src]; continue; }
      const curParts = split(cur[c.row.src]);
      const dst = c.row.dst !== undefined ? String(c.row.dst) : curParts.dst;
      const info = c.row.info !== undefined ? String(c.row.info) : curParts.info;
      next[c.row.src] = info ? `${dst} #${info}` : dst;
    }
    const entries = Object.entries(next).map(([src, value]) => ({ src, ...split(value) }));
    const plan = planImport({ entries, currentGlossary: cur, engine: deps.engine });
    const result = await applyImport({ store, client: deps.makeClient(book), book, plan, currentGlossary: cur, note: 'workspace_apply 批次' });
    for (const c of glossaryOps) {
      results.push({ scope: 'glossary', op: c.op, src: c.row.src, status: result.verified ? 'success' : 'failed', detail: result.verified ? '' : '回读校验未通过' });
      if (result.verified) applied.glossary += 1;
      else failed += 1;
    }
  }
  return { applied, results, failed };
}

function clearChanges(root) {
  for (const domain of ['rules', 'glossary', 'prompts']) {
    for (const op of ['creates', 'updates', 'deletes']) {
      try { fs.writeFileSync(path.join(root, 'changes', domain, `${op}.jsonl`), '', 'utf8'); } catch { }
    }
  }
}

export function createWorkspaceTools() {
  const needDeps = (ctx) => {
    if (!ctx || !ctx.deps || !ctx.deps.workspaceRoot) throw Object.assign(new Error('工作区依赖未装配（workspaceRoot）'), { code: 'deps_unavailable' });
    return ctx.deps;
  };
  const boundBook = (ctx) => {
    if (!ctx.bookKey) throw Object.assign(new Error('会话未绑定项目（bookKey 为空）——通用会话没有工作区；请新建绑书会话'), { code: 'workspace_needs_project' });
    const book = ctx.store.getBook(ctx.bookKey);
    if (!book) throw Object.assign(new Error(`book 不存在：${ctx.bookKey}`), { code: 'book_not_found' });
    return book;
  };

  return [
    {
      name: 'workspace_run',
      description: [
        'CodeAct：执行一段 JavaScript（ESM）脚本完成程序化数据处理（读取/分页/筛选/关联/去重/聚合/检查/准备变更清单）。',
        '每次调用启动独立沙箱 Node 进程（--permission）：可读整个工作区、可写 changes/ 与 work/，禁止子进程/worker/原生扩展，网络可用，120s 超时 SIGKILL。',
        '全局对象 ws：ws.contract（契约，含数据集路径与变更 schema）；await ws.doing(text) 汇报进度；await ws.read({kind:"read", subkind:"chapter", chapterId, volumeId?}) 读章节 {paragraphJp, oldParagraphZh, glossaryId}。',
        '数据集文件（JSONL，行内带 fp）：project_meta.json、progress/entries.jsonl、rules/entries.jsonl、glossary/entries.jsonl、prompts.json、runs/entries.jsonl；详见 reference/workspace.md。',
        '要提交修改时：把变更行写入 changes/<域>/<op>.jsonl（schema 见 ws.contract.changes），再用 workspace_apply 提交。跨调用数据放 work/ 下文件。',
        '返回：{scriptPath, exitCode, signal, stdout:{path,bytes,content?}, stderr:{...}}（单流超 64KiB 只给路径）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: { script: { type: 'string', minLength: 1, description: '要执行的完整 JavaScript ESM 源码' } },
        required: ['script'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        needDeps(ctx);
        const book = boundBook(ctx);
        const ctx2 = { ...ctx, book, bookKey: book.key };
        const { root } = await ensureWorkspace(ctx2, { freshChanges: true });
        const client = (ctx.deps || {}).makeClient ? ctx.deps.makeClient(book) : null;
        const record = await runScript(ctx2, { root, script: args.script, client });
        if (record.timedOut) record.stderr.message = '工作区程序超时（120s），已终止。';
        return record;
      },
    },
    {
      name: 'workspace_apply',
      description: [
        '把 changes/**.jsonl 变更清单提交到工程（参数为空对象；清单由 workspace_run 的脚本预先写好）。',
        '流程：解析 → fp 漂移/目标缺失/冲突检测 → 提交简报（审批预览）→ 审批 → 提交 → 回执 {status: applied|partial|rejected|unchanged, applied, rejected, destroyed, results}。',
        'destroyed=true 时快照过期：changes 会被清空，下轮 workspace_run 自动重建。提交简报要先于本调用输出（新增/修改/删除数量与关键结论）。',
      ].join('\n'),
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      requiresApproval: true,
      async preview(args, ctx) {
        needDeps(ctx);
        const book = boundBook(ctx);
        const ctx2 = { ...ctx, book, bookKey: book.key };
        const { root } = await ensureWorkspace(ctx2);
        const resolved = await resolveChanges(ctx2, root);
        const summary = summarizeResolved(resolved);
        return {
          action: '提交工作区变更',
          book: book.key,
          counts: summary.counts,
          unchanged: summary.unchanged,
          rejected: summary.rejected.slice(0, 20),
          rejectedTotal: summary.rejected.length,
          note: '审批通过后按清单逐 op 提交；glossary 域走快照+全量替换+回读校验。',
        };
      },
      async execute(args, ctx) {
        needDeps(ctx);
        if (ctx.deps.queueBusy && ctx.deps.queueBusy()) throw Object.assign(new Error('有翻译任务正在运行（单队列占用中），稍后再提交'), { code: 'queue_busy' });
        const book = boundBook(ctx);
        const ctx2 = { ...ctx, book, bookKey: book.key };
        const { root } = await ensureWorkspace(ctx2);
        const resolved = await resolveChanges(ctx2, root);
        const { applied, results, failed } = await commitResolved(ctx2, root, resolved);
        const totalApplied = applied.rules + applied.glossary + applied.prompts;
        const rejectedTotal = resolved.rejected.length;
        const status = totalApplied > 0 && rejectedTotal === 0 && failed === 0 ? 'applied'
          : totalApplied > 0 ? 'partial'
            : (rejectedTotal > 0 || failed > 0) ? 'rejected' : 'unchanged';
        const destroyed = resolved.destroyed;
        if (destroyed) clearChanges(root);
        else if (status === 'applied') clearChanges(root);   // 全量提交成功 → 清空清单（防重复提交；partial 保留供修复重提）
        return { status, applied, rejected: resolved.rejected, destroyed, results: results.slice(0, 100) };
      },
    },
  ];
}
