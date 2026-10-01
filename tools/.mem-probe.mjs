// tools/.mem-probe.mjs —— auto-novel BETA 工作区内存归因探针
// 只读 + 可回滚：注入合成队列前把 localStorage['workspace-gpt'] 原样备份到 tools/.mem-backup.json，
// 用完 `restore` 复原。全程不点「启动翻译器」，不会发出任何翻译请求、不写站点数据。
// 用法: node tools/.mem-probe.mjs <open|state|toc|baseline|inject|load|retain|expand|restore> [args]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.CDP_PORT || 9333;
const here = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_FILE = path.join(here, '.mem-backup.json');
const PIPELINE_URL = process.env.PROBE_URL || 'https://n.novelia.cc/workspace/gpt-pipeline';
const PROBE_MATCH = process.env.PROBE_MATCH || 'novelia.cc';
const PROVIDER = 'kakuyomu';
const NOVEL_ID = '822139843523722587';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((res, rej) => fetch(url).then((r) => r.json()).then(res).catch(rej));
const listTargets = async () => (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).filter((t) => t.type === 'page');

class Client {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.chunks = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
        this.chunks.push(msg.params.chunk);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 300000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const connect = async () => {
  const targets = await listTargets();
  const target = targets.find((t) => t.url.includes(PROBE_MATCH)) || targets[0];
  if (!target) throw new Error('没有可用的页面目标（chrome 是否带 --remote-debugging-port=' + PORT + ' 启动？）');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const client = new Client(ws);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Page.bringToFront').catch(() => {});
  return client;
};

const evalJs = async (c, expression, awaitPromise = true) => {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('Eval error: ' + d.text + ' ' + ((d.exception && d.exception.description) || ''));
  }
  return r.result ? r.result.value : undefined;
};
const evalFn = (c, body) => evalJs(c, `(async () => { ${body} })()`);

const heap = (c) => evalJs(c, `(() => { const m = performance.memory || {}; return {
  usedMB: +(m.usedJSHeapSize / 1048576).toFixed(1),
  totalMB: +(m.totalJSHeapSize / 1048576).toFixed(1),
  limitMB: +(m.jsHeapSizeLimit / 1048576).toFixed(0) }; })()`);

const gcHeap = async (c, rounds = 3) => {
  await c.send('HeapProfiler.enable').catch(() => {});
  for (let i = 0; i < rounds; i++) { await c.send('HeapProfiler.collectGarbage'); await sleep(350); }
  return heap(c);
};

const waitReady = async (c, timeout = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await evalJs(c, 'document.readyState').catch(() => '');
    if (s === 'complete') return true;
    await sleep(300);
  }
  return false;
};

// 页内助手：从 Vue 实例树里找 PipelineTaskCard（生产构建下 setupState 里没有绑定，但 props 里有）
const HELPERS = `window.__mp = (() => {
  const rootVNode = () => {
    const el = document.querySelector('#app') || document.body;
    if (el && el._vnode) return el._vnode;
    const a = el && el.__vue_app__;
    return a && a._instance ? a._instance.subTree : null;
  };
  const walk = () => {
    const root = rootVNode(); const out = [];
    if (!root) return out;
    const seen = new Set();
    const rec = (v) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      const inst = v.component;
      if (inst) { out.push(inst); rec(inst.subTree); }
      const ch = v.children;
      if (Array.isArray(ch)) { for (const c of ch) rec(c); }
      else if (ch && typeof ch === 'object') {
        for (const k in ch) {
          const vv = ch[k];
          if (typeof vv === 'function') {
            let r = null;
            try { r = vv(); } catch (e) { /* slot 调用失败就跳过 */ }
            if (Array.isArray(r)) { for (const c of r) rec(c); }
          } else if (Array.isArray(vv)) { for (const c of vv) rec(c); }
        }
      }
    };
    rec(root);
    return out;
  };
  const cards = () => walk().filter((i) => i.props && i.props.job && i.props.taskState !== undefined);
  const genLines = (chars, n) => {
    const per = Math.max(6, Math.floor(chars / n));
    const base = '吾輩は猫である。名前はまだ無い。どこで生まれたかとんと見当がつかぬ。何でも薄暗いじめじめした所で泣いていた事だけは記憶している。';
    const out = [];
    for (let i = 0; i < n; i++) out.push((base + base).slice(0, per));
    return out;
  };
  const seg = (lines, maxLen, maxLine) => {
    const ranges = []; let s = 0, c = 0;
    for (let i = 0; i < lines.length; i++) {
      const last = i === lines.length - 1;
      const len = lines[i].length + (last ? 0 : 1);
      if ((c + len > maxLen || i - s >= maxLine) && i > s) { ranges.push({ start: s, end: i }); s = i; c = 0; }
      c += len;
    }
    if (s < lines.length) ranges.push({ start: s, end: lines.length });
    return ranges;
  };
  // 构造一份「和真实代码同构」的章节文本结构，但完全不进 Vue（纯文本对照）
  const buildPlain = (jpChars, zhChars) => {
    const jpLines = genLines(jpChars, Math.ceil(jpChars / 24));
    const ranges = seg(jpLines, 1500, 30);
    const zhLines = genLines(zhChars, Math.ceil(zhChars / 15));
    return {
      ranges,
      segments: ranges.map((r) => ({ status: 'done', lines: jpLines.slice(r.start, r.end), translatedLines: zhLines.slice(r.start, r.end), error: null })),
    };
  };
  return {
    cards,
    inst() {
      const out = walk();
      const byType = new Map();
      for (const i of out) {
        const t = String((i.type && (i.type.__name || i.type.name)) || 'anon');
        byType.set(t, (byType.get(t) || 0) + 1);
      }
      return { total: out.length, top: [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20) };
    },
    cardIndex(taskSub) {
      const cs = cards();
      for (let i = 0; i < cs.length; i++) { const j = cs[i].props.job; if (j && String(j.task).includes(taskSub)) return i; }
      return -1;
    },
    counts() {
      const cs = cards(); let chapters = 0, chapterStates = 0, segments = 0, doneCh = 0;
      for (const c of cs) {
        const st = c.props.taskState; if (!st) continue;
        chapters += st.chapters.length; chapterStates += st.chapterStates.size;
        for (const [, x] of st.chapterStates) segments += x.segments.length;
        doneCh += st.chapters.filter((ch) => ch.status === 'done').length;
      }
      return { cards: cs.length, chapters, doneChapters: doneCh, chapterStates, segments,
        dom: document.getElementsByTagName('*').length,
        domCards: document.querySelectorAll('.task-list *').length };
    },
    plainFill(n, jpChars, zhChars) {
      window.__mpPlain = [];
      for (let i = 0; i < n; i++) window.__mpPlain.push(buildPlain(jpChars, zhChars));
      return window.__mpPlain.length;
    },
    plainFree() { const n = (window.__mpPlain || []).length; window.__mpPlain = null; return n; },
    // 走真实代码路径：ChapterSegmentState.onSegmentsReady / onSegComplete
    retain(taskSub, chapterCount, jpChars, zhChars) {
      const cs = cards();
      let st = null;
      for (const c of cs) { if (String(c.props.job.task).includes(taskSub) && c.props.taskState && c.props.taskState.chapters.length) { st = c.props.taskState; break; } }
      if (!st) return { error: 'no-task-state' };
      const list = st.chapters.slice(0, chapterCount);
      let made = 0;
      for (const ch of list) {
        const cst = st.getChapterState(ch.chapterId);
        if (!cst || cst.ready) continue;
        const jp = genLines(jpChars, Math.ceil(jpChars / 24));
        const ranges = seg(jp, 1500, 30);
        cst.onSegmentsReady(jp, ranges);
        const zh = genLines(zhChars, Math.ceil(zhChars / 15));
        ranges.forEach((r, i) => cst.onSegComplete(i, zh.slice(r.start, r.end)));
        made++;
      }
      return { made, chapterStates: st.chapterStates.size, retainedChars: made * (jpChars + zhChars) };
    },
    release(taskSub) {
      const cs = cards();
      let freed = 0;
      for (const c of cs) {
        if (!String(c.props.job.task).includes(taskSub)) continue;
        const st = c.props.taskState;
        if (st) { freed += st.chapterStates.size; st.chapterStates.clear(); }
      }
      return freed;
    },
    // 触发站点自己的全局深扫（workerErrors computed 依赖每个分块的 status/translatorId）
    poke(taskSub) {
      const cs = cards();
      for (const c of cs) {
        if (!String(c.props.job.task).includes(taskSub)) continue;
        const st = c.props.taskState;
        for (const [, x] of st.chapterStates) {
          if (!x.segments.length) continue;
          const s = x.segments[0];
          s.status = s.status === 'error' ? 'done' : 'error';
          return 'poked';
        }
      }
      return 'nothing';
    },
    expandIdx(i) {
      const card = document.querySelectorAll('.task-list .n-card')[i];
      if (!card) return 'no-card';
      const d = card.querySelector('.task-name') || card.querySelector('.n-card-header');
      d.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'clicked#' + i;
    },
    expand(taskSub) {
      const idx = this.cardIndex(taskSub);
      if (idx < 0) return 'no-card';
      const card = document.querySelectorAll('.task-list .n-card')[idx];
      const d = card.querySelector('.task-name') || card.querySelector('.n-card-header');
      d.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'clicked#' + idx;
    },
    collapse(taskSub) {
      const idx = this.cardIndex(taskSub);
      if (idx < 0) return 'no-card';
      const card = document.querySelectorAll('.task-list .n-card')[idx];
      const d = card.querySelector('.task-name') || card.querySelector('.n-card-header');
      d.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'clicked#' + idx;
    },
  };
})();
window.__mpV = 6;
"helpers4";`;

const ensureHelpers = async (c) => {
  const v = await evalJs(c, 'window.__mpV || 0').catch(() => 0);
  if (v !== 6) await evalJs(c, HELPERS);
};

const summarizeLs = (c) => evalJs(c, `(() => {
  const raw = localStorage.getItem('workspace-gpt') || '';
  let o = {}; try { o = JSON.parse(raw); } catch (e) {}
  const rawPipe = localStorage.getItem('workspace-gpt-pipeline') || '';
  let p = {}; try { p = JSON.parse(rawPipe); } catch (e) {}
  return {
    gptBytes: raw.length,
    jobs: (o.jobs || []).length,
    uncompletedJobs: (o.uncompletedJobs || []).length,
    workers: (o.workers || []).length,
    pipelineWorkers: (p.workers || []).length,
    pipelineJobs: (p.jobs || []).length,
  };
})()`);

const idbQueue = (c) => evalJs(c, `(async () => new Promise((res) => {
  const r = indexedDB.open('ntr-glossary');
  r.onerror = () => res('open-err');
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('jobs')) return res('no-store');
    const q = db.transaction('jobs', 'readonly').objectStore('jobs').count();
    q.onsuccess = () => res(q.result);
    q.onerror = () => res('count-err');
  };
}))()`);

const tocStats = (c) => evalFn(c, `
  const token = (() => { try { return JSON.parse(localStorage.getItem('auth') || '{}').profile?.token || ''; } catch (e) { return ''; } })();
  const payload = token ? JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) : null;
  const r = await fetch('/api/novel/${PROVIDER}/${NOVEL_ID}/translate-v2/gpt', { credentials: 'same-origin', headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if (!r.ok) return { err: 'HTTP ' + r.status, tokenExp: payload && payload.exp, now: Math.floor(Date.now() / 1000) };
  const j = await r.json();
  const toc = j.toc || [];
  return { chapters: toc.length, done: toc.filter((t) => t.glossaryUuid).length,
    glossary: Object.keys(j.glossary || {}).length, bytes: JSON.stringify(j).length, tokenExp: payload && payload.exp };
`);

const aggregate = (prof) => {
  const map = new Map();
  const rec = (n) => {
    const cf = n.callFrame || {};
    const key = (cf.functionName || '(anon)') + ' @ ' + String(cf.url || '').split('/').pop() + ':' + cf.lineNumber;
    map.set(key, (map.get(key) || 0) + (n.selfSize || 0));
    (n.children || []).forEach(rec);
  };
  rec(prof.head);
  return [...map.entries()].map(([k, v]) => ({ mb: +(v / 1048576).toFixed(2), key: k })).sort((a, b) => b.mb - a.mb);
};

const loadBackup = () => fs.existsSync(BACKUP_FILE) ? JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')) : null;
const saveBackup = (o) => fs.writeFileSync(BACKUP_FILE, JSON.stringify(o));

const main = async () => {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  const c = await connect();
  try {
    if (cmd === 'open') {
      const url = a1 || PIPELINE_URL;
      await c.send('Page.navigate', { url });
      await waitReady(c);
      await sleep(1500);
      await ensureHelpers(c);
      console.log('URL:', await evalJs(c, 'location.href'));
      return;
    }
    if (cmd === 'inst') {
      await ensureHelpers(c);
      console.log(JSON.stringify(await evalJs(c, 'window.__mp.inst()'), null, 2));
      return;
    }
    if (cmd === 'expandN') {
      await ensureHelpers(c);
      const n = Number(a1) || 10;
      const out = [];
      for (let i = 0; i < n; i++) { out.push(await evalJs(c, `window.__mp.expandIdx(${i})`)); await sleep(250); }
      await sleep(2000);
      console.log(JSON.stringify({ clicked: out.length, sample: out.slice(0, 3), counts: await evalJs(c, 'window.__mp.counts()'), heap: await heap(c) }, null, 2));
      return;
    }
    if (cmd === 'css') {
      await ensureHelpers(c);
      const on = a1 !== 'off';
      const r = await evalJs(c, `(() => {
        const id = 'mem-probe-cv';
        document.getElementById(id)?.remove();
        if (${on}) {
          const s = document.createElement('style'); s.id = id;
          s.textContent = '.task-list .grid .c { content-visibility: auto; contain-intrinsic-size: 34px 34px; contain: layout paint style; }';
          document.head.appendChild(s);
        }
        return { on: ${on}, cells: document.querySelectorAll('.task-list .grid .c').length };
      })()`);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (cmd === 'layout') {
      await ensureHelpers(c);
      const r = await evalJs(c, `(() => {
        const samples = [];
        for (let i = 0; i < 12; i++) {
          document.body.style.paddingTop = (i % 2) ? '0px' : '1px';
          const t = performance.now();
          void document.documentElement.offsetHeight;
          samples.push(performance.now() - t);
        }
        document.body.style.paddingTop = '';
        const s = samples.slice().sort((a, b) => a - b);
        return { medianMs: +s[Math.floor(s.length / 2)].toFixed(2), minMs: +s[0].toFixed(2), maxMs: +s[s.length - 1].toFixed(2),
          cells: document.querySelectorAll('.task-list .grid .c').length, dom: document.getElementsByTagName('*').length };
      })()`);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (cmd === 'snap') {
      const out = a1 || path.join(here, '.mem-snapshot.heapsnapshot');
      await c.send('HeapProfiler.enable').catch(() => {});
      await c.send('HeapProfiler.collectGarbage'); await sleep(700);
      await c.send('HeapProfiler.collectGarbage'); await sleep(700);
      c.chunks.length = 0;
      const t0 = Date.now();
      await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
      fs.writeFileSync(out, c.chunks.join(''));
      console.log(JSON.stringify({ file: out, bytes: fs.statSync(out).size, chunks: c.chunks.length, ms: Date.now() - t0 }, null, 2));
      return;
    }
    if (cmd === 'state') {
      await ensureHelpers(c);
      console.log(JSON.stringify({
        href: await evalJs(c, 'location.href'),
        heap: await heap(c),
        ls: await summarizeLs(c),
        idbJobs: await idbQueue(c),
        counts: await evalJs(c, 'window.__mp.counts()'),
        toc: await tocStats(c),
      }, null, 2));
      return;
    }
    if (cmd === 'toc') {
      console.log(JSON.stringify(await tocStats(c), null, 2));
      return;
    }
    if (cmd === 'ntrq') {
      const info = await evalFn(c, `
        return await new Promise((res) => {
          const r = indexedDB.open('ntr-glossary');
          r.onerror = () => res('open-err');
          r.onsuccess = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('jobs')) return res([]);
            const q = db.transaction('jobs', 'readonly').objectStore('jobs').getAll();
            q.onsuccess = () => res(q.result.map((j) => ({
              id: j.id, state: j.state,
              target: JSON.stringify(j.target || {}).slice(0, 140),
              opts: Object.keys(j.options || {}), progress: j.progress || null,
              entries: (j.entries || []).length, updatedAt: j.updatedAt || null,
            })));
            q.onerror = () => res('err');
          };
        });
      `);
      const cfg = await evalJs(c, `(() => {
        try { const c = JSON.parse(localStorage.getItem('NTR_ToolBox_Config') || '{}');
          const m = (c.modules || []).find((x) => x.name === 'AI提取术语表');
          const g = (s) => { const it = (m?.settings || []).find((y) => y.name === s); return it ? it.value : null; };
          return { useTest: g('使用临时端点'), model: g('临时模型'), taskMode: g('任务方式'), autoResume: (c.modules || []).some((x) => x.name === '术语队列' && (x.settings || []).some((y) => y.name === '自动续跑' && y.value)); };
        } catch (e) { return { err: String(e) }; }
      })()`);
      console.log(JSON.stringify({ jobs: info, config: cfg }, null, 2));
      return;
    }
    if (cmd === 'baseline') {
      await ensureHelpers(c);
      const h = await gcHeap(c, 4);
      const counts = await evalJs(c, 'window.__mp.counts()');
      const b = loadBackup() || {};
      b.baseline = { ts: Date.now(), heap: h, counts };
      saveBackup(b);
      console.log(JSON.stringify({ baseline: h, counts }, null, 2));
      return;
    }
    if (cmd === 'inject') {
      const jobCount = Number(a1) || 40;
      const endIndex = Number(a2) || 16;
      const overlap = a3 === 'overlap';
      const tiny = a3 === 'tiny';
      const res = await evalFn(c, `
        const key = 'workspace-gpt';
        const raw = localStorage.getItem(key);
        if (!window.__mpOrig) window.__mpOrig = raw;
        const obj = raw ? JSON.parse(raw) : { workers: [], jobs: [], uncompletedJobs: [] };
        obj.jobs = obj.jobs || []; obj.uncompletedJobs = obj.uncompletedJobs || []; obj.workers = obj.workers || [];
        const origJobs = obj.jobs.length, origRecs = obj.uncompletedJobs.length;
        const t0 = Date.now() - 3600000;
        const jobs = [];
        for (let i = 0; i < ${jobCount}; i++) {
          const s = ${tiny} ? i : (${overlap} ? i : i * ${endIndex});
          const e = ${tiny} ? i + 3 : (${overlap} ? ${endIndex} : s + ${endIndex});
          jobs.push({
            task: 'web/${PROVIDER}/${NOVEL_ID}?level=normal&forceMetadata=false&startIndex=' + s + '&endIndex=' + e,
            description: 'mem-probe ' + (i + 1),
            createAt: t0 + i * 1000,
          });
        }
        obj.jobs = obj.jobs.filter((j) => !String(j.task).includes('${NOVEL_ID}')).concat(jobs);
        const nextRaw = JSON.stringify(obj);
        localStorage.setItem(key, nextRaw);
        return { origJobs, origRecs, injected: jobs.length, nowJobs: obj.jobs.length, newBytes: nextRaw.length };
      `);
      const b = loadBackup() || {};
      b.raw = b.raw ?? await evalJs(c, 'window.__mpOrig ?? localStorage.getItem("workspace-gpt")');
      b.injectedAt = Date.now();
      b.jobCount = jobCount; b.sliceLen = endIndex; b.overlap = overlap;
      saveBackup(b);
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (cmd === 'load') {
      await c.send('HeapProfiler.enable');
      await c.send('HeapProfiler.startSampling', { samplingInterval: 8192 });
      const t0 = Date.now();
      await c.send('Page.navigate', { url: PIPELINE_URL });
      await waitReady(c);
      await sleep(1500);
      await ensureHelpers(c);
      // 第一张卡就绪时间（chapters > 0）
      let firstReadyMs = null;
      for (let i = 0; i < 400; i++) {
        const c1 = await evalJs(c, 'window.__mp.counts()').catch(() => null);
        if (c1 && c1.chapters > 0) { firstReadyMs = Date.now() - t0; break; }
        await sleep(200);
      }
      // 等任务初始化稳定（chapters 数连续 3 次不变）
      let last = '', stable = 0, counts = null;
      for (let i = 0; i < 90; i++) {
        counts = await evalJs(c, 'window.__mp.counts()');
        const s = JSON.stringify(counts);
        if (s === last) { stable++; if (stable >= 3 && counts.chapters > 0) break; } else { stable = 0; }
        last = s;
        await sleep(1000);
      }
      const settleMs = Date.now() - t0;
      const prof = await c.send('HeapProfiler.stopSampling');
      const top = aggregate(prof.profile).slice(0, 18);
      const h = await gcHeap(c, 4);
      const counts2 = await evalJs(c, 'window.__mp.counts()');
      const inst = await evalJs(c, 'window.__mp.inst()');
      const resources = await evalJs(c, `(() => {
        const es = performance.getEntriesByType('resource').filter((e) => e.name.includes('translate-v2'));
        return { count: es.length, sumMs: Math.round(es.reduce((a, e) => a + e.duration, 0)),
          maxMs: Math.round(Math.max(0, ...es.map((e) => e.duration))),
          firstStartMs: es.length ? Math.round(Math.min(...es.map((e) => e.startTime))) : null,
          lastEndMs: es.length ? Math.round(Math.max(...es.map((e) => e.startTime + e.duration))) : null };
      })()`);
      const b = loadBackup() || {};
      b.loaded = { ts: Date.now(), settleMs, heap: h, counts: counts2 };
      saveBackup(b);
      console.log(JSON.stringify({ settleMs, firstReadyMs, heap: h, counts: counts2, instances: inst.total, instTop: inst.top.slice(0, 8), resources, baseline: b.baseline || null, samplingTop: top, ls: await summarizeLs(c) }, null, 2));
      return;
    }
    if (cmd === 'retain') {
      await ensureHelpers(c);
      const taskSub = a1 || NOVEL_ID;
      const n = Number(a2) || 120;
      const jpChars = 3600, zhChars = 2400;
      const h0 = await gcHeap(c, 4);
      await evalJs(c, `window.__mp.plainFill(${n}, ${jpChars}, ${zhChars})`);
      const hPlain = await gcHeap(c, 4);
      await evalJs(c, 'window.__mp.plainFree()');
      const hFreed = await gcHeap(c, 4);
      const ret = await evalJs(c, `window.__mp.retain(${JSON.stringify(taskSub)}, ${n}, ${jpChars}, ${zhChars})`);
      const hReactive = await gcHeap(c, 4);
      const poked = await evalJs(c, `window.__mp.poke(${JSON.stringify(taskSub)})`);
      await sleep(800);
      const hAfterSweep = await gcHeap(c, 4);
      const counts = await evalJs(c, 'window.__mp.counts()');
      const freed = await evalJs(c, `window.__mp.release(${JSON.stringify(taskSub)})`);
      const hReleased = await gcHeap(c, 4);
      console.log(JSON.stringify({
        note: '同量文本：纯数组(非响应式) vs 真实代码路径(ChapterSegmentState/reactive)',
        h0, hPlain, plainDeltaMB: +(hPlain.usedMB - h0.usedMB).toFixed(1),
        hFreed, hReactive, reactiveDeltaMB: +(hReactive.usedMB - hFreed.usedMB).toFixed(1),
        hAfterSweep, sweepExtraMB: +(hAfterSweep.usedMB - hReactive.usedMB).toFixed(1),
        retained: ret, poke: poked, counts, freedChapters: freed, hReleased,
      }, null, 2));
      return;
    }
    if (cmd === 'expand') {
      await ensureHelpers(c);
      const taskSub = a1 || NOVEL_ID;
      const before = await evalJs(c, 'window.__mp.counts()');
      const hBefore = await gcHeap(c, 4);
      const clicked = await evalJs(c, `window.__mp.expand(${JSON.stringify(taskSub)})`);
      await sleep(2500);
      const hAfter = await gcHeap(c, 4);
      const after = await evalJs(c, 'window.__mp.counts()');
      const gridInfo = await evalJs(c, `(() => ({
        grids: document.querySelectorAll('.task-list .grid').length,
        cells: document.querySelectorAll('.task-list .grid .c').length,
        naiveBars: document.querySelectorAll('.task-list .grid .n-progress').length,
      }))()`);
      console.log(JSON.stringify({
        clicked, domBefore: before.dom, domAfter: after.dom, domDelta: after.dom - before.dom,
        heapBefore: hBefore, heapAfter: hAfter, heapDeltaMB: +(hAfter.usedMB - hBefore.usedMB).toFixed(1),
        gridInfo, counts: after,
      }, null, 2));
      return;
    }
    if (cmd === 'savebackup') {
      const raw = await evalJs(c, 'window.__mpOrig ?? null');
      if (raw === null) { console.log('页面里没有 __mpOrig（可能已刷新）'); return; }
      const b = loadBackup() || {};
      b.raw = raw; b.savedAt = Date.now();
      saveBackup(b);
      console.log(JSON.stringify({ saved: raw.length, file: BACKUP_FILE }, null, 2));
      return;
    }
    if (cmd === 'restore') {
      const b = loadBackup();
      if (!b || b.raw === undefined) { console.log('没有备份可恢复'); return; }
      const r = await evalFn(c, `
        localStorage.setItem('workspace-gpt', ${JSON.stringify(b.raw)});
        const raw = localStorage.getItem('workspace-gpt') || '';
        let o = {}; try { o = JSON.parse(raw); } catch (e) {}
        return { bytes: raw.length, jobs: (o.jobs || []).length, uncompletedJobs: (o.uncompletedJobs || []).length, matchBackup: raw === ${JSON.stringify(b.raw)} };
      `);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.log('未知子命令。可用: open/state/toc/baseline/inject/load/retain/expand/restore');
  } finally {
    try { c.ws.close(); } catch (e) { /* noop */ }
  }
};

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
