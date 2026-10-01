// auto-novel 老工作区「任务记录」内存探针 —— F12 控制台整段粘贴即可
// 只改 localStorage['workspace-gpt']（本地假数据，不联网、不碰服务端），用 __anMem.restore() 还原。
// 用法：粘贴 → __anMem.print() 看现状 → __anMem.fill(300) → F5 刷新 → __anMem.print()
//       → __anMem.download() 导出 → __anMem.restore() → F5 刷新
// 提醒：造数据期间别点「重试未完成任务」「启动翻译器」，否则会把假任务真的排进队列。
(() => {
  const KEY = 'workspace-gpt';
  const S = (window.__anMem = window.__anMem || {});
  const THE_NOVEL = 'kakuyomu/822139843523722587';
  const MB = (x) => (x == null ? null : +(x / 1048576).toFixed(1));

  const walk = () => {
    const el = document.querySelector('#app') || document.body;
    const root = el._vnode || (el.__vue_app__ && el.__vue_app__._instance && el.__vue_app__._instance.subTree);
    const out = [];
    if (!root) return out;
    const seen = new Set();
    const isVNode = (x) => !!x && typeof x === 'object' && (x.__v_isVNode === true || ('type' in x && 'children' in x && 'el' in x));
    const rec = (v) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      const inst = v.component;
      if (inst) { out.push(inst); rec(inst.subTree); }
      const ch = v.children;
      if (Array.isArray(ch)) { for (const c of ch) rec(c); }
      else if (isVNode(ch)) rec(ch);
      else if (ch && typeof ch === 'object') {
        for (const k in ch) {
          const vv = ch[k];
          if (typeof vv === 'function') { let r = null; try { r = vv(); } catch (e) {} if (Array.isArray(r)) { for (const c of r) rec(c); } else if (isVNode(r)) rec(r); }
          else if (Array.isArray(vv)) { for (const c of vv) rec(c); }
          else if (isVNode(vv)) rec(vv);
        }
      }
    };
    rec(root);
    return out;
  };

  const ls = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };

  S.report = () => {
    const raw = ls(KEY);
    let o = {};
    try { o = JSON.parse(raw); } catch (e) { o = {}; }
    const inst = walk();
    const byType = {};
    for (const i of inst) {
      const t = String((i.type && (i.type.__name || i.type.name)) || 'anon');
      byType[t] = (byType[t] || 0) + 1;
    }
    const m = performance.memory || {};
    const used = MB(m.usedJSHeapSize);
    return {
      at: new Date().toISOString(),
      url: location.href,
      heapUsedMB: used,
      heapTotalMB: MB(m.totalJSHeapSize),
      heapLimitMB: m.jsHeapSizeLimit ? MB(m.jsHeapSizeLimit) : null,
      // 粗估「Chrome 任务管理器」里这一栏的内存：≈ 堆 ×1.35 + 40（0/300/1000 行实测拟合，仅供参考）
      estTaskMgrMB: used == null ? null : Math.round(used * 1.35 + 40),
      domNodes: document.getElementsByTagName('*').length,
      listItems: document.querySelectorAll('.n-list-item').length,
      vueInstances: inst.length,
      vueTop: Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 14),
      lsWorkspaceBytes: raw.length,
      jobs: (o.jobs || []).length,
      uncompletedJobs: (o.uncompletedJobs || []).length,
      workers: (o.workers || []).length,
    };
  };
  S.print = () => { const r = S.report(); console.log('%c[an-mem]', 'color:#0a0', r); return r; };

  S.backup = () => {
    const kept = sessionStorage.getItem('__anMem.raw');
    if (S.raw === undefined && kept !== null) S.raw = kept;
    if (S.raw !== undefined) return S.raw.length;
    if (localStorage.getItem(KEY) == null) localStorage.setItem(KEY, JSON.stringify({ workers: [], jobs: [], uncompletedJobs: [] }));
    S.raw = localStorage.getItem(KEY);
    sessionStorage.setItem('__anMem.raw', S.raw);
    console.log('[an-mem] 已备份 ' + S.raw.length + ' 字节（存在 sessionStorage，刷新后仍可还原），还原：__anMem.restore()');
    return S.raw.length;
  };
  if (sessionStorage.getItem('__anMem.raw') !== null) S.raw = sessionStorage.getItem('__anMem.raw');

  // 造 n 条任务记录。kind='pending'（默认，未完成，和真实队列一致）会多渲一个「重试」按钮；
  // kind='done' 用 progress 标成已完成，「重试未完成任务」不会把它重新入队。
  S.fill = (n = 300, kind = 'pending') => {
    S.backup();
    const o = JSON.parse(localStorage.getItem(KEY) || '{"workers":[],"jobs":[],"uncompletedJobs":[]}');
    o.workers = o.workers || []; o.jobs = o.jobs || []; o.uncompletedJobs = o.uncompletedJobs || [];
    const t0 = Date.now() - 30 * 24 * 3600 * 1000;
    o.uncompletedJobs = Array.from({ length: n }, (_, i) => {
      const rec = {
        task: 'web/' + THE_NOVEL + '?level=normal&forceMetadata=false&startIndex=' + i + '&endIndex=' + (i + 1),
        description: 'mem-probe record ' + (i + 1),
        createAt: t0 + i * 1000,
      };
      if (kind === 'done') rec.progress = { finished: 1, error: 0, total: 1 };
      return rec;
    });
    localStorage.setItem(KEY, JSON.stringify(o));
    console.log('[an-mem] 已写入 ' + n + ' 条「' + (kind === 'done' ? '已完成' : '未完成') + '」记录（原数据在 __anMem.raw）→ F5 刷新后看效果。别点「重试未完成任务」/「启动翻译器」。');
    return n;
  };

  S.restore = () => {
    if (S.raw === undefined) { console.warn('[an-mem] 没有备份（本页没跑过 __anMem.fill）'); return null; }
    localStorage.setItem(KEY, S.raw);
    sessionStorage.removeItem('__anMem.raw');
    const o = JSON.parse(localStorage.getItem(KEY));
    console.log('[an-mem] 已还原 ' + S.raw.length + ' 字节 → 刷新页面生效；还原后记录数 = ' + (o.uncompletedJobs || []).length);
    return S.raw.length;
  };

  // 长时间观测：队列跑起来时内存随时间怎么涨。结束后用 __anMem.samples() 看数列。
  S.sample = (seconds = 120, everyMs = 5000) => {
    S._s = [];
    const t0 = Date.now();
    const tick = () => {
      const m = performance.memory || {};
      S._s.push({
        t: +((Date.now() - t0) / 1000).toFixed(1),
        heapMB: MB(m.usedJSHeapSize),
        totalMB: MB(m.totalJSHeapSize),
        dom: document.getElementsByTagName('*').length,
        rows: document.querySelectorAll('.n-list-item').length,
      });
    };
    tick();
    const id = setInterval(tick, everyMs);
    setTimeout(() => { clearInterval(id); console.log('%c[an-mem] 采样结束（' + S._s.length + ' 点），__anMem.samples()', 'color:#0a0'); }, seconds * 1000);
    console.log('[an-mem] 采样 ' + seconds + 's / 每 ' + everyMs + 'ms 一点');
    return S._s;
  };
  S.samples = () => { const a = S._s || []; try { console.table(a); } catch (e) {} return a; };

  const redact = (obj) => {
    // 导出前把 worker 的 api key 抹掉（备份里本来就有你的真 key，别把它发出去）
    const clone = JSON.parse(JSON.stringify(obj));
    for (const w of clone.workers || []) for (const k of ['key', 'apiKey', 'token']) if (w[k]) w[k] = '<redacted:' + String(w[k]).length + 'chars>';
    return clone;
  };

  S.download = () => {
    const raw = S.raw ?? sessionStorage.getItem('__anMem.raw') ?? localStorage.getItem(KEY);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) {}
    const payload = {
      report: S.report(),
      samples: S._s || [],
      backupWorkspaceGptRedacted: parsed ? redact(parsed) : raw,
      note: 'backup 里的 api key 已脱敏；还原请用页面里的 __anMem.restore()',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'an-mem-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    console.log('%c[an-mem] 已导出 an-mem-<时间>.json（报告 + 采样 + 已脱敏备份）', 'color:#0a0');
  };

  console.log('%c[an-mem] 就绪：__anMem.print() 报告 | __anMem.fill(300[,"done"]) 造数 → F5 | __anMem.sample(120) 连续采样 | __anMem.download() 导出 | __anMem.restore() 还原 → F5', 'color:#0a0;font-weight:bold');
  return S.print();
})();
