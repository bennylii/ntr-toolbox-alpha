// Mock LLM 端点：OpenAI 兼容 /v1/chat/completions，用于 NTR ToolBox 术语提取功能的本地测试
// 零依赖（node 内置 http），默认端口 8788
//
// 用法：
//   node server.mjs            # 监听 127.0.0.1:8788
//   PORT=8899 node server.mjs
//
// 故障注入（可加在 endpoint URL 上，也可用请求头 x-mock-fail）：
//   ?fail=429              总是回 429（带 Retry-After: 2）
//   ?fail=429&n=2          前 2 次 429，之后正常
//   ?fail=timeout          永不响应（客户端超时）
//   ?fail=abort            回一半断流
//   ?fail=truncate         最后一行 JSON 被截断
//   ?fail=badjson          返回畸形 JSON（单引号/尾逗号/闲聊包裹）
//   ?fail=empty            返回空内容
//   ?fail=think            返回含 <think> 段与推理前缀
//   ?slow=1500             延迟 1.5s 再响应
//   ?script=429,429,ok,truncate,ok   按请求顺序消费的脚本（第 N 次请求用第 N 项）
//   ?variant=unstable      每次请求对部分条目换一个 dst（测多轮投票）
//   ?reset=1               重置统计
// 统计：GET /__stats
//
// 环境变量（全局生效，模拟"慢/单槽位"上游，复现 KWG 单线程卡请求类问题）：
//   MOCK_SLOW_MS=8000   所有请求延迟 8s 再响应
//   MOCK_SLOW_JITTER=4000  任务时长抖动：slow ± jitter（确定性伪随机，模拟时长波动的上游）
//   MOCK_FAIL=timeout   所有请求进入指定故障模式
//   MOCK_SLOTS=1        单槽位上游：已有任务在跑时新请求 429 busy（带 Retry-After），
//                       槽位按任务工时占用，客户端超时放弃也不会提前释放
//   MOCK_BUSY_AFTER=3   busy 时返回的 Retry-After 秒数

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';

// 全局故障/模拟参数（环境变量，作用于所有请求；查询串/请求头优先级更高）
//   MOCK_SLOW_MS=8000   所有请求延迟 8s 再响应（模拟慢上游）
//   MOCK_FAIL=timeout   所有请求进入指定故障模式
//   MOCK_SLOTS=1        单槽位上游：同一时刻已有一个任务在跑时，新请求直接 429 busy（模拟浏览器 UI 中继）
//   MOCK_BUSY_AFTER=3   busy 拒绝时返回的 Retry-After 秒数（默认 3）
const GLOBAL_SLOW_MS = Number(process.env.MOCK_SLOW_MS || 0);
const GLOBAL_SLOW_JITTER = Number(process.env.MOCK_SLOW_JITTER || 0);
const GLOBAL_FAIL = process.env.MOCK_FAIL || '';
const SLOTS = Number(process.env.MOCK_SLOTS || 0);
const BUSY_RETRY_AFTER = Number(process.env.MOCK_BUSY_AFTER || 3);

// ---------------- 工具 ----------------

const rnd = (() => {
  let s = 0x9e3779b9;
  return () => {
    // xorshift32，固定种子 → 输出可复现
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
})();

const hash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const ZI = '蕾娜莉丝薇奥拉瑟琳缇亚朵蔷薇娼馆暗夜狼牙月影绯红苍银龙姬骑士団长魔导书妖精森罗';
const pickZh = (seed, n) => {
  let out = '';
  let h = seed;
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    out += ZI[h % ZI.length];
  }
  return out;
};

const TYPES = ['男性人名', '女性人名', '未知性别人名', '地名', '家族', '组织', '特殊物品', '特殊生物', '其他'];

// ---------------- 伪造提取结果 ----------------

// 从片段里挑“看起来像术语”的词：片假名串、被引号包裹的词、重复出现的汉字串
function extractFakeTerms(text) {
  const terms = new Map(); // src -> type
  const push = (w, type) => {
    w = w.trim();
    if (w.length < 2 || w.length > 12) return;
    if (!terms.has(w)) terms.set(w, type);
  };

  for (const m of text.matchAll(/[\u30A0-\u30FF\u31F0-\u31FF\uFF65-\uFF9F]{2,}/g)) {
    push(m[0], TYPES[hash(m[0]) % 6]); // 人名/地名/家族/组织/物品/生物
  }
  for (const m of text.matchAll(/[「『]([^」』\n]{2,10})[」』]/g)) {
    push(m[1], TYPES[(hash(m[1]) + 3) % 6]);
  }
  // 重复出现 >=2 次的 2-4 字汉字串
  const counts = new Map();
  for (const m of text.matchAll(/[\u4E00-\u9FFF]{2,4}/g)) {
    counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  }
  for (const [w, c] of counts) {
    if (c >= 2 && c <= 20) push(w, TYPES[(hash(w) + 1) % 6]);
  }

  return [...terms.entries()];
}

function buildJsonline(terms, opts) {
  const { variant = false, noisy = false } = opts;
  const lines = [];
  terms.forEach(([src, type], i) => {
    let dst = pickZh(hash(src), 2 + (hash(src + 'len') % 3));
    // 每 5 条制造一条“其他”类（应被清洗掉）
    let t = type;
    if (i % 5 === 4) t = '其他';
    // 每 7 条制造 src==dst（应被清洗掉）
    if (i % 7 === 6) dst = src;
    // 每 11 条制造空 dst（应被清洗掉）
    if (i % 11 === 10) dst = '';
    // 每 13 条制造超长 src（>32 显示宽度，应被清洗掉）
    let s = src;
    if (i % 13 === 12) s = src + 'の' + '超长'.repeat(20);
    // 不稳定模式：偶数次出现的条目换一个候选译文（测投票）
    if (variant && i % 3 === 1) dst = pickZh(hash(src + 'B'), 3) + '·改';
    lines.push(JSON.stringify({ src: s, dst, type: t }));
  });
  if (noisy) {
    return [
      '好的，以下是从文本片段中提取的术语表：',
      '```jsonline',
      ...lines,
      '```',
      '以上共计 ' + lines.length + ' 条，请查收。',
    ].join('\n');
  }
  return ['```jsonline', ...lines, '```'].join('\n');
}

// ---------------- 故障注入 ----------------

const scriptCounters = new Map(); // key -> index

function decideFault(url, headers) {
  const q = url.searchParams;
  if (q.get('reset') === '1') {
    scriptCounters.clear();
    stats = { requests: 0, byMode: {}, entries: 0, inflightNow: 0, maxInflight: 0, jobsNow: 0, maxJobs: 0, busyRejects: 0, startedAt: Date.now() };
    return { mode: 'ok' };
  }

  const script = q.get('script');
  if (script) {
    // key 带上完整 query，便于给每次测试加唯一 run= token 得到独立的计数
    const key = 'script:' + url.search;
    const i = scriptCounters.get(key) || 0;
    scriptCounters.set(key, i + 1);
    const arr = script.split(',');
    const mode = arr[Math.min(i, arr.length - 1)].trim() || 'ok';
    return { mode };
  }

  const headerFault = headers['x-mock-fail'];
  const fail = headerFault || q.get('fail') || GLOBAL_FAIL || 'ok';
  const n = Number(q.get('n') || 0);

  if (fail === '429' && n > 0) {
    const key = 'n429:' + n;
    const i = scriptCounters.get(key) || 0;
    scriptCounters.set(key, i + 1);
    if (i >= n) return { mode: 'ok' };
  }
  return { mode: fail };
}

// ---------------- HTTP ----------------

let stats = { requests: 0, byMode: {}, entries: 0, inflightNow: 0, maxInflight: 0, jobsNow: 0, maxJobs: 0, busyRejects: 0, startedAt: Date.now() };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const headers = req.headers;

  const cors = {
    'Access-Control-Allow-Origin': headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-mock-fail, accept',
    'Access-Control-Max-Age': '600',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // 供 Tampermonkey 安装的用户脚本：
  //  - /NTR_ToolBox.dev.user.js → 直接给生成好的 dev 文件（@name/@version 与本地文件一致，已去掉 updateURL/downloadURL，不会被 GreasyFork 覆盖）
  //  - /NTR_ToolBox.user.js     → 主文件（临时把 updateURL/downloadURL 注释掉，避免装完被 GreasyFork 自动更新顶掉）
  if (url.pathname === '/NTR_ToolBox.dev.user.js' || url.pathname === '/NTR_ToolBox.user.js') {
    try {
      const fsMod = await import('node:fs');
      const pathMod = await import('node:path');
      const root = pathMod.join(pathMod.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
      const isDev = url.pathname.endsWith('.dev.user.js');
      const file = pathMod.join(root, isDev ? 'NTR_ToolBox.dev.user.js' : 'NTR_ToolBox.user.js');
      let src = fsMod.readFileSync(file, 'utf8');
      if (!isDev) {
        src = src.replace(/^\/\/ @(downloadURL|updateURL).*$/gm, '// @$1  (disabled in mock build)');
      }
      res.writeHead(200, { ...cors, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(src);
    } catch (e) {
      res.writeHead(500, { ...cors, 'content-type': 'text/plain' });
      res.end('read userscript failed: ' + e.message);
    }
    return;
  }

  if (url.pathname === '/__stats') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
    return;
  }

  // 离线 e2e 用：站点的小说 DTO 假数据（读术语表走这里）。只处理 GET，写入永远不落到这里。
  // 特例：novelId = mock-src 的文库书带「一卷一章」的假正文（针对取文链路/队列跑的用例），别的仍是空 DTO
  if (req.method === 'GET' && /^\/api\/(novel|wenku)\//.test(url.pathname)) {
    const segs = url.pathname.split('/').filter(Boolean);
    const rich = /mock-src/.test(url.pathname);
    res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
    if (rich && /\/chapter-task\//.test(url.pathname)) {
      const ch = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
      const n = ch === 'ch2' ? 12 : 25;
      res.end(JSON.stringify({
        chapterId: ch,
        paragraphJp: Array.from({ length: n }, (_, i) => `第${i + 1}行：アリスが魔導書を読む。ローズも来た。`),
      }));
      return;
    }
    if (rich && /\/translate-v2\//.test(url.pathname)) {
      res.end(JSON.stringify({ toc: [{ chapterId: 'ch1' }, { chapterId: 'ch2' }] }));
      return;
    }
    res.end(JSON.stringify({
      providerId: segs[2] || 'mock', novelId: segs[segs.length - 1] || 'mock-novel',
      titleZh: 'mock 测试书', titleJp: 'モックテスト', glossary: {},
      volumeJp: rich ? [{ volumeId: 'v1', total: 2 }] : [], toc: [],
    }));
    return;
  }

  // 离线 e2e 用：给油猴脚本一个 /novel、/wenku、/favorite 下的空白文档（不依赖外网就能跑用例）
  if (req.method === 'GET' && /^\/(novel|wenku|favorite)(\/|$)/.test(url.pathname)) {
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>mock 测试页</title></head><body><div id="app"></div></body></html>');
    return;
  }

  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-glossary-1', object: 'model', owned_by: 'mock' }] }));
    return;
  }

  if (!url.pathname.endsWith('/chat/completions') || req.method !== 'POST') {
    res.writeHead(404, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found: ' + url.pathname } }));
    return;
  }

  // 读取 body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = JSON.parse(bodyText); } catch { /* ignore */ }

  const { mode } = decideFault(url, headers);
  const slow = Number(url.searchParams.get('slow') || 0) || GLOBAL_SLOW_MS;
  const jitter = Number(url.searchParams.get('jitter') || 0) || GLOBAL_SLOW_JITTER;
  // 有效任务时长 = slow ± jitter（确定性伪随机），模拟时长波动的上游
  const jobMs = slow > 0 ? Math.max(0, Math.round(slow + (jitter > 0 ? (rnd() * 2 - 1) * jitter : 0))) : 0;
  const variant = url.searchParams.get('variant') === 'unstable';
  const noisy = url.searchParams.get('style') === 'chatty';

  stats.requests += 1;
  stats.byMode[mode] = (stats.byMode[mode] || 0) + 1;
  stats.inflightNow = (stats.inflightNow || 0) + 1;
  stats.maxInflight = Math.max(stats.maxInflight || 0, stats.inflightNow);
  // 供测试断言请求体形状（例如「输出上限」不发送时不带 max_tokens）
  stats.lastBody = {
    model: body.model,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    max_completion_tokens: body.max_completion_tokens,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
  };
  res.on('close', () => {
    stats.inflightNow -= 1;
    // 客户端在响应前断开（超时放弃）——上游的活其实还在跑
    if (!res.writableEnded) console.log(`[mock] client abandoned before response (inflight=${stats.inflightNow})`);
  });

  const userContent = (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content || '').join('\n');
  // 宽松查找“文本片段”标记：取标记后的第一行开始的内容（不依赖冒号是全角还是半角）
  let clip = userContent;
  const clipIdx = userContent.indexOf('文本片段');
  if (clipIdx >= 0) {
    const nl = userContent.indexOf('\n', clipIdx);
    clip = nl >= 0 ? userContent.slice(nl + 1) : userContent.slice(clipIdx + 4);
  }
  const terms = extractFakeTerms(clip);

  console.log(`[mock] ${new Date().toISOString()} mode=${mode} model=${body.model} chars=${clip.length} terms=${terms.length} variant=${variant} job=${jobMs}ms`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sendJson = (code, obj, extra = {}) => {
    res.writeHead(code, { ...cors, 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };

  const okBody = (content) => ({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'mock-glossary-1',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: Math.ceil(clip.length / 1.5), completion_tokens: content.length, total_tokens: 0 },
  });

  // 单槽位上游：一个任务占槽期间，新请求直接 429"busy"（模拟浏览器 UI 中继 / 单并发本地模型）
  // 槽位按"任务工时"（slow 毫秒）计时：即使客户端提前超时放弃，槽位仍被继续占用——真实上游的活不会因客户端断开而停止
  if (SLOTS > 0 && stats.jobsNow >= SLOTS) {
    stats.busyRejects += 1;
    console.log(`[mock] busy reject (jobs=${stats.jobsNow}/${SLOTS})`);
    sendJson(429, { error: { message: 'UI generate error: extension busy with another job', type: 'RuntimeError' } }, { 'retry-after': String(BUSY_RETRY_AFTER) });
    return;
  }
  stats.jobsNow += 1;
  stats.maxJobs = Math.max(stats.maxJobs || 0, stats.jobsNow);
  setTimeout(() => { stats.jobsNow -= 1; }, Math.max(jobMs, 0));

  if (jobMs > 0) await sleep(Math.min(jobMs, 30000));

  switch (mode) {
    case '429': {
      sendJson(429, { error: { message: 'mock rate limit', type: 'rate_limit_exceeded' } }, { 'retry-after': '2' });
      return;
    }
    case 'timeout': {
      // 保持连接不响应，由客户端超时
      console.log('[mock] holding socket for timeout test');
      return;
    }
    case 'abort': {
      const text = buildJsonline(terms, { variant, noisy });
      const half = Math.floor(text.length / 2);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.write(JSON.stringify(okBody(text.slice(0, half))).slice(0, 200));
      setTimeout(() => res.destroy(), 50);
      return;
    }
    case 'truncate': {
      const text = buildJsonline(terms, { variant, noisy });
      const cut = text.lastIndexOf('\n');
      const cutText = text.slice(0, cut) + '\n{"src":"' + (terms[0]?.[0] || 'x') + '","dst":"半截';
      sendJson(200, okBody(cutText));
      return;
    }
    case 'badjson': {
      const lines = terms.map(([src]) => `{'src': '${src}', 'dst': '${pickZh(hash(src), 2)}', 'type': '地名',}`);
      const text = ['当然可以：', '```jsonline', ...lines.slice(0, Math.max(1, lines.length - 1)), '```'].join('\n');
      sendJson(200, okBody(text));
      return;
    }
    case 'empty': {
      sendJson(200, okBody(''));
      return;
    }
    case 'think': {
      const text = `用户希望我提取术语……\n<think>让我仔细分析这段文本，先看人名，再看地名。（推理过程略）</think>\n` + buildJsonline(terms, { variant, noisy });
      sendJson(200, okBody(text));
      return;
    }
    case 'thinkbudget': {
      // 模拟「思考也算进 max_tokens」的上游（deepseek 新版 / o 系列之类）：
      // 只要客户端发了输出上限且不够大 → 思考吃满预算、正文为空（finish_reason=length）
      const budget = Number(body.max_tokens || body.max_completion_tokens || 0) || 0;
      if (budget > 0 && budget < 20000) {
        stats.emptyBudget = (stats.emptyBudget || 0) + 1;
        sendJson(200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'mock-glossary-1',
          choices: [{
            index: 0,
            finish_reason: 'length',
            message: { role: 'assistant', content: '', reasoning_content: '思考一下。'.repeat(3000) },
          }],
          usage: { prompt_tokens: 100, completion_tokens: budget, total_tokens: 0 },
        });
        return;
      }
      const text = buildJsonline(terms, { variant, noisy });
      stats.entries += terms.length;
      sendJson(200, okBody(text));
      return;
    }
    default: {
      // 审计（再次筛选）模式：认出审核提示词 → 按 ?audit=N 把列表里前 N 条判为「建议删」
      //   ?auditErr=1 → 回一段没有 JSONLINE 的话（测 fail-open）
      if (userContent.includes('术语表审核员')) {
        stats.auditRequests = (stats.auditRequests || 0) + 1;
        if (url.searchParams.get('auditErr') === '1') {
          sendJson(200, okBody('好的，我看完了，感觉都还行。'));
          return;
        }
        const auditN = Math.max(0, Number(url.searchParams.get('audit') || 0) || 0);
        const list = [];
        userContent.split(/\r?\n/).forEach((line) => {
          const t = line.trim();
          if (!t.startsWith('{')) return;
          try {
            const obj = JSON.parse(t);
            if (obj && typeof obj.src === 'string' && 'dst' in obj) list.push(obj);
          } catch { /* 不是 JSON 行，跳过 */ }
        });
        const drop = list.slice(0, auditN);
        stats.auditSeen = (stats.auditSeen || 0) + list.length;
        const text = ['```jsonline', ...drop.map((e, i) => JSON.stringify({
          src: e.src, why: String(1 + (i % 5)), note: `mock 判废#${i + 1}`,
        })), '```'].join('\n');
        console.log(`[mock] audit: seen=${list.length} drop=${drop.length}`);
        sendJson(200, okBody(text));
        return;
      }
      const text = buildJsonline(terms, { variant, noisy });
      stats.entries += terms.length;
      sendJson(200, okBody(text));
      return;
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mock] listening on http://${HOST}:${PORT}  (chat: /v1/chat/completions, stats: /__stats)`);
});
