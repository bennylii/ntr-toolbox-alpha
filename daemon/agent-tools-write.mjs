// daemon/agent-tools-write.mjs —— Agent 执行/写入工具（A3）：管线派发 + 术语写入/回滚 + 规则/提示词
// 审批：写站点或改本地配置的工具都带 requiresApproval（manual 模式下先出 decision，预览含真实 diff）；
//       run_check/export_glossary/close_proposal 等只读或仅本地状态的操作自动执行。
// 依赖注入：ctx.deps = { engine, makeClient, enqueue }
import { planImport, applyImport, toLgGlossary, restoreSnapshot } from './glossary-io.mjs';

const cut = (text, n) => {
  const s = String(text == null ? '' : text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function createWriteTools() {
  const getDeps = (ctx) => {
    const deps = ctx && ctx.deps;
    if (!deps || !deps.makeClient) throw Object.assign(new Error('Agent 依赖未装配（makeClient）'), { code: 'deps_unavailable' });
    return deps;
  };
  const getBook = (store, key) => {
    const book = store.getBook(String(key || ''));
    if (!book) throw Object.assign(new Error(`book 不存在：${key || '(空)'}`), { code: 'book_not_found' });
    return book;
  };
  const runQueued = async (ctx, job, bookKey, options) => {
    const deps = getDeps(ctx);
    if (typeof deps.enqueue !== 'function') throw Object.assign(new Error('任务队列未装配'), { code: 'queue_unavailable' });
    const { id, done } = deps.enqueue({ bookKey, job, options });
    const item = await done;
    return { jobId: id, state: item.state, error: item.error || '', stats: item.stats || null };
  };

  return [
    {
      name: 'run_check',
      description: '对一本书跑只读质检（七码：假名残留/相似度/术语未落地/标点/缺译/保留段/重试阈值）。propose=true 时把命中样例生成提案。',
      parameters: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          propose: { type: 'boolean', description: '默认 false' },
          limit: { type: 'number', description: '样例上限，默认 20' },
        },
        required: ['book'],
      },
      async execute(args, ctx) {
        getBook(ctx.store, args.book);
        return runQueued(ctx, 'check', String(args.book), {
          propose: args.propose === true,
          limit: Math.min(50, Math.max(1, Math.floor(Number(args.limit) || 20))),
        });
      },
    },
    {
      name: 'run_translate',
      description: '给一本书补翻/重翻章节（把译文上传到站点，属于写操作，需要用户审批）。',
      parameters: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          level: { type: 'string', description: 'expire（默认）/ normal / all' },
          maxChapters: { type: 'number', description: '本次最多上传 N 章，默认 0=不限' },
        },
        required: ['book'],
      },
      requiresApproval: true,
      async preview(args, ctx) {
        const book = getBook(ctx.store, args.book);
        const level = ['expire', 'normal', 'all'].includes(args.level) ? args.level : 'expire';
        return {
          action: '翻译并上传译文',
          book: book.key, title: book.title || '', level,
          maxChapters: Math.max(0, Math.floor(Number(args.maxChapters) || 0)),
          note: '单队列串行执行；上传的段落数必须与原文一致。',
        };
      },
      async execute(args, ctx) {
        const level = ['expire', 'normal', 'all'].includes(args.level) ? args.level : 'expire';
        return runQueued(ctx, 'translate', String(args.book), {
          level,
          maxChapters: Math.max(0, Math.floor(Number(args.maxChapters) || 0)),
        });
      },
    },
    {
      name: 'run_glossary',
      description: '跑一遍术语管线（提取→核实→回扫→直写/提案）。干净的纯新增会直接写入站点术语表（写操作，需要审批），其余进提案。',
      parameters: { type: 'object', properties: { book: { type: 'string' } }, required: ['book'] },
      requiresApproval: true,
      async preview(args, ctx) {
        const book = getBook(ctx.store, args.book);
        return { action: '术语管线（可能直写术语表）', book: book.key, title: book.title || '', note: '写入前自动快照；不达标条目进提案。' };
      },
      async execute(args, ctx) {
        return runQueued(ctx, 'glossary', String(args.book), {});
      },
    },
    {
      name: 'glossary_apply',
      description: '把一批术语条目写入站点术语表（值格式 = dst + " #备注"）。写前给出新增/更新/拦截 diff，写入走快照 + 全量替换 + 回读校验；需要用户审批。',
      parameters: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          entries: {
            type: 'array',
            description: '条目数组',
            items: {
              type: 'object',
              properties: {
                src: { type: 'string' }, dst: { type: 'string' }, info: { type: 'string', description: '备注（≤8 字）' },
              },
              required: ['src', 'dst'],
            },
          },
          note: { type: 'string' },
        },
        required: ['book', 'entries'],
      },
      requiresApproval: true,
      async preview(args, ctx) {
        const deps = getDeps(ctx);
        const book = getBook(ctx.store, args.book);
        const client = deps.makeClient(book);
        const current = await client.getGlossary(book);
        const entries = (Array.isArray(args.entries) ? args.entries : []).map((e) => ({
          src: String((e && e.src) || ''), dst: String((e && e.dst) || ''), info: String((e && e.info) || ''), regex: false, caseSensitive: false,
        }));
        const plan = planImport({ entries, currentGlossary: current, engine: deps.engine });
        return {
          action: '写入站点术语表', book: book.key,
          currentCount: Object.keys(current).length,
          additions: plan.additions.slice(0, 20), additionsTotal: plan.additions.length,
          updates: plan.updates.slice(0, 20), updatesTotal: plan.updates.length,
          skipped: plan.skipped.map((s) => ({ src: s.src, reasons: s.reasons })),
          same: plan.same.length,
          note: '写入前自动快照；被拦截条目不会写入。',
        };
      },
      async execute(args, ctx) {
        const deps = getDeps(ctx);
        const book = getBook(ctx.store, args.book);
        const client = deps.makeClient(book);
        const current = await client.getGlossary(book);
        const entries = (Array.isArray(args.entries) ? args.entries : []).map((e) => ({
          src: String((e && e.src) || ''), dst: String((e && e.dst) || ''), info: String((e && e.info) || ''), regex: false, caseSensitive: false,
        }));
        const plan = planImport({ entries, currentGlossary: current, engine: deps.engine });
        const result = await applyImport({ store: ctx.store, client, book, plan, currentGlossary: current, note: String(args.note || 'agent 写入') });
        return { ...result, skipped: plan.skipped.map((s) => ({ src: s.src, reasons: s.reasons })) };
      },
    },
    {
      name: 'glossary_rollback',
      description: '把站点术语表回滚到某个快照（list_snapshots 查看 id）。写前自动为当前状态再存一份快照；需要用户审批。',
      parameters: {
        type: 'object',
        properties: { book: { type: 'string' }, snapshotId: { type: 'number' } },
        required: ['book', 'snapshotId'],
      },
      requiresApproval: true,
      async preview(args, ctx) {
        const book = getBook(ctx.store, args.book);
        const snap = ctx.store.getSnapshot(Number(args.snapshotId));
        if (!snap) throw Object.assign(new Error(`快照不存在：${args.snapshotId}`), { code: 'snapshot_not_found' });
        return {
          action: '回滚站点术语表', book: book.key, snapshotId: snap.id, snapshotAt: snap.at, note: snap.note,
          targetCount: Object.keys(snap.glossary || {}).length,
          targetHead: Object.entries(snap.glossary || {}).slice(0, 10),
        };
      },
      async execute(args, ctx) {
        const deps = getDeps(ctx);
        const book = getBook(ctx.store, args.book);
        const client = deps.makeClient(book);
        return restoreSnapshot({ store: ctx.store, client, book, snapshotId: args.snapshotId });
      },
    },
    {
      name: 'export_glossary',
      description: '把站点术语表导出为 LG JSON（数组，含 src/dst/info）。只读。',
      parameters: { type: 'object', properties: { book: { type: 'string' } }, required: ['book'] },
      async execute(args, ctx) {
        const deps = getDeps(ctx);
        const book = getBook(ctx.store, args.book);
        const current = await deps.makeClient(book).getGlossary(book);
        const list = toLgGlossary(current, deps.engine);
        return { book: book.key, count: list.length, glossary: list };
      },
    },
    {
      name: 'import_glossary',
      description: '导入 LG JSON 术语表（数组或 {src:dst} 映射）。apply=false 时只回 diff；apply=true 时写入站点（需要审批）。regex 条目会分流到本地规则（默认禁用）。',
      parameters: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          json: { type: 'string', description: 'LG JSON 文本' },
          apply: { type: 'boolean', description: '默认 false（只回 diff）' },
          propose: { type: 'boolean', description: 'apply=false 时把拦截/更新条目存成提案' },
        },
        required: ['book', 'json'],
      },
      requiresApproval: true,
      async preview(args, ctx) {
        const deps = getDeps(ctx);
        const book = getBook(ctx.store, args.book);
        const client = deps.makeClient(book);
        const current = await client.getGlossary(book);
        const { parseLgGlossary } = await import('./glossary-io.mjs');
        const parsed = parseLgGlossary(String(args.json || ''));
        const plan = planImport({ entries: parsed.entries, currentGlossary: current, engine: deps.engine });
        return {
          action: args.apply === false ? '导入（只出 diff，不写入）' : '导入并写入站点术语表',
          book: book.key, entries: parsed.entries.length,
          additions: plan.additions.length, updates: plan.updates.length, same: plan.same.length,
          skipped: plan.skipped.map((s) => ({ src: s.src, reasons: s.reasons })),
          regexRules: plan.regexRules.length,
          note: args.apply === false ? '不写站点' : '写入前自动快照 + 回读校验；regex 条目入本地规则（默认禁用）。',
        };
      },
      async execute(args, ctx) {
        const deps = getDeps(ctx);
        const book = getBook(ctx.store, args.book);
        const client = deps.makeClient(book);
        const current = await client.getGlossary(book);
        const { parseLgGlossary } = await import('./glossary-io.mjs');
        const parsed = parseLgGlossary(String(args.json || ''));
        const plan = planImport({ entries: parsed.entries, currentGlossary: current, engine: deps.engine });
        let regexRuleIds = [];
        if (args.apply !== false && plan.regexRules.length > 0) {
          for (const r of plan.regexRules) {
            regexRuleIds.push(ctx.store.addRule({ bookKey: '', kind: 'pre_replacement', pattern: r.src, replacement: r.dst, regex: 1, enabled: 0, note: 'agent 导入（默认禁用）' }));
          }
        }
        if (args.apply === false) {
          if (args.propose === true && (plan.skipped.length > 0 || plan.updates.length > 0)) {
            ctx.store.addProposal({
              bookKey: book.key, kind: 'import',
              entries: [...plan.skipped.map((s) => ({ src: s.src, dst: s.dst, type: s.info, suspect: s.reasons }))],
              note: 'agent 导入待审',
            });
          }
          return { applied: 0, additions: plan.additions.length, updates: plan.updates.length, same: plan.same.length, skipped: plan.skipped.length, regexRules: plan.regexRules.length, regexRuleIds: [] };
        }
        const result = await applyImport({ store: ctx.store, client, book, plan, currentGlossary: current, note: 'agent 导入' });
        return { ...result, skipped: plan.skipped.map((s) => ({ src: s.src, reasons: s.reasons })), regexRuleIds };
      },
    },
    {
      name: 'set_rule',
      description: '新增一条文本处理规则（pre/post 替换或保留段）。改本地配置，需要审批。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'pre_replacement / post_replacement / text_preserve' },
          pattern: { type: 'string' },
          replacement: { type: 'string' },
          regex: { type: 'boolean' },
          case_sensitive: { type: 'boolean' },
          priority: { type: 'number', description: '默认 100，越小越先执行' },
          bookKey: { type: 'string', description: '留空 = 全局' },
        },
        required: ['kind', 'pattern'],
      },
      requiresApproval: true,
      async preview(args) {
        return { action: '新增规则', kind: args.kind, pattern: cut(args.pattern, 120), replacement: cut(args.replacement, 120), regex: args.regex === true, case_sensitive: args.case_sensitive === true, priority: Number(args.priority) || 100, bookKey: String(args.bookKey || '') };
      },
      async execute(args, ctx) {
        if (!['text_preserve', 'pre_replacement', 'post_replacement'].includes(String(args.kind))) {
          throw Object.assign(new Error('kind 不合法'), { code: 'bad_arguments' });
        }
        const id = ctx.store.addRule({
          bookKey: String(args.bookKey || ''),
          kind: String(args.kind),
          pattern: String(args.pattern),
          replacement: String(args.replacement == null ? '' : args.replacement),
          regex: args.regex === true ? 1 : 0,
          case_sensitive: args.case_sensitive === true ? 1 : 0,
          priority: Number(args.priority) || 100,
          note: 'agent',
        });
        return { id };
      },
    },
    {
      name: 'delete_rule',
      description: '删除一条文本处理规则（按 id）。需要审批。',
      parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      requiresApproval: true,
      async preview(args, ctx) {
        const rule = ctx.store.listRules().find((r) => r.id === Number(args.id));
        if (!rule) throw Object.assign(new Error(`规则不存在：${args.id}`), { code: 'rule_not_found' });
        return { action: '删除规则', rule: { id: rule.id, kind: rule.kind, pattern: cut(rule.pattern, 120), bookKey: rule.bookKey || '' } };
      },
      async execute(args, ctx) {
        ctx.store.deleteRule(Number(args.id));
        return { ok: true };
      },
    },
    {
      name: 'set_prompt',
      description: '设置某本书（或全局）的提示词模板槽位（prefix/base/thinking/suffix）。base 必须含 {format_rules}。需要审批。',
      parameters: {
        type: 'object',
        properties: {
          bookKey: { type: 'string', description: '留空 = 全局' },
          slot: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['slot', 'text'],
      },
      requiresApproval: true,
      async preview(args, ctx) {
        const bookKey = String(args.bookKey || '');
        const current = ctx.store.listPrompts(bookKey).find((r) => r.slot === args.slot && (r.bookKey || '') === bookKey);
        return {
          action: '设置提示词模板', bookKey: bookKey || '(全局)', slot: String(args.slot),
          currentHead: cut(current ? current.text : '(默认)', 200),
          newHead: cut(args.text, 400),
          warn: String(args.slot) === 'base' && !String(args.text || '').includes('{format_rules}') ? 'base 缺少 {format_rules}，运行时将回退默认模板' : '',
        };
      },
      async execute(args, ctx) {
        const { PROMPT_SLOTS } = await import('./prompt.mjs');
        if (!PROMPT_SLOTS.includes(String(args.slot))) throw Object.assign(new Error('slot 不合法'), { code: 'bad_arguments' });
        ctx.store.setPrompt(String(args.bookKey || ''), String(args.slot), String(args.text == null ? '' : args.text));
        return { ok: true };
      },
    },
    {
      name: 'close_proposal',
      description: '关闭（标记为已处理）一条提案。仅改本地状态，自动执行。',
      parameters: { type: 'object', properties: { id: { type: 'number' }, status: { type: 'string', description: 'closed（默认）/ rejected' } }, required: ['id'] },
      async execute(args, ctx) {
        const proposal = ctx.store.getProposal(args.id);
        if (!proposal) throw Object.assign(new Error(`提案不存在：${args.id}`), { code: 'proposal_not_found' });
        ctx.store.setProposalStatus(proposal.id, String(args.status || 'closed'));
        return { id: proposal.id, status: String(args.status || 'closed') };
      },
    },
  ];
}
