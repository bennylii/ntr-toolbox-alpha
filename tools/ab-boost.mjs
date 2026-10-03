// A/B 度量：同一本书文本，「基线管线」vs「增强管线（多轮种子 + 证据核实）」的产出对比
// 用法:
//   node tools/ab-boost.mjs --text <book.txt> --endpoint <url> [--model m] [--key k]
//        [--budget 3000] [--concurrency 2] [--max-lines 0] [--verify drop-first]
// 说明:
//   - 需要真实 LLM 端点（或 mock：node mock-llm/server.mjs）才能跑出有意义的结果；
//   - 基线 = 单轮提取（种子补漏关、不核实）；增强 = 多轮种子 + 核实；
//   - 指标：条目数 / 形态可疑数 / 核实剔除数 / 请求数 / 耗时；报告写到 tools/.ab-report.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const userscript = path.join(here, '..', 'ntr-toolbox-alpha.user.js');
const extractPath = path.join(here, '.engine-extract.mjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const textFile = opt('text', '');
const endpoint = opt('endpoint', '');
if (!textFile || !endpoint) {
  console.error('用法: node tools/ab-boost.mjs --text <book.txt> --endpoint <http://host:port/v1> [--model m] [--key k] [--budget 3000] [--concurrency 2] [--max-lines 0] [--verify drop-first]');
  process.exit(2);
}
const model = opt('model', 'mock-glossary-1');
const key = opt('key', 'x');
const budgetChars = Math.max(200, Number(opt('budget', 3000)) || 3000);
const concurrency = Math.max(1, Number(opt('concurrency', 2)) || 2);
const maxLines = Math.max(0, Number(opt('max-lines', 0)) || 0);
const verifyParam = opt('verify', '');
const endpointUrl = verifyParam ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}verify=${verifyParam}` : endpoint;

// 抽取引擎段（与 engine-test.mjs 同一模式）
const source = fs.readFileSync(userscript, 'utf8');
const start = source.indexOf('// ==GlossaryEngine-START==');
const end = source.indexOf('// ==GlossaryEngine-END==');
if (start < 0 || end < 0) { console.error('未找到 GlossaryEngine 标记段'); process.exit(2); }
fs.writeFileSync(extractPath, source.slice(start, end) + '\nexport { GlossaryEngine, GlossaryLog };\n');
const { GlossaryEngine: E } = await import('file://' + extractPath.replace(/\\/g, '/'));

const raw = fs.readFileSync(textFile, 'utf8');
let lines = E.splitLines(raw).filter((line) => E.languageFilter(line, 'JA')).filter((line) => !E.ruleFilter(line));
if (maxLines > 0) lines = lines.slice(0, maxLines);
if (lines.length === 0) { console.error('文本为空或语言过滤后无内容'); process.exit(2); }

const summarize = (entries, extra) => ({
  entries: entries.length,
  kept: entries.length - (extra.verifyDropped || 0),
  suspects: entries.filter((e) => E.suspectReasons(e.src).length > 0).length,
  cleaningDropped: extra.dropped || null,
  seedRounds: extra.seedRounds || 0,
  verifyDropped: extra.verifyDropped || 0,
  requests: extra.requests,
  ms: extra.ms,
  top: entries.slice(0, 8).map((e) => e.src),
});

const worker = [{ id: 'ab', model, endpoint: endpointUrl, key }];

// ---- 基线：单轮提取 ----
const baseline = await (async () => {
  let requests = 0;
  const requester = E.createRequester(worker, { timeoutMs: 300000, rps: concurrency, rpm: 0 });
  const t0 = Date.now();
  const result = await E.runJob({
    lines,
    callLLM: (messages) => { requests += 1; return requester.call(messages); },
    options: { budgetChars, maxRounds: 2, concurrency, targetLanguage: '中文', seedPolish: false },
  });
  return summarize(result.glossary, { dropped: result.dropped, requests, ms: Date.now() - t0 });
})();

// ---- 增强：多轮种子 + 证据核实 ----
const enhanced = await (async () => {
  let requests = 0;
  const requester = E.createRequester(worker, { timeoutMs: 300000, rps: concurrency, rpm: 0 });
  const t0 = Date.now();
  const result = await E.runJob({
    lines,
    callLLM: (messages) => { requests += 1; return requester.call(messages); },
    options: { budgetChars, maxRounds: 2, concurrency, targetLanguage: '中文', seedPolish: true, maxSeedRounds: 3 },
  });
  const verified = await E.verifyEntries({
    entries: result.glossary,
    lines,
    call: (messages) => { requests += 1; return requester.call(messages); },
    concurrency,
  });
  return summarize(verified.entries, {
    dropped: result.dropped, seedRounds: result.seedRounds,
    verifyDropped: verified.dropped, requests, ms: Date.now() - t0,
  });
})();

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(`\nA/B 报告（${textFile} · ${lines.length} 行 · ${endpointUrl}）`);
console.log(`${pad('指标', 14)}${pad('基线', 12)}增强`);
for (const k of ['entries', 'kept', 'suspects', 'verifyDropped', 'seedRounds', 'requests', 'ms']) {
  console.log(`${pad(k, 14)}${pad(baseline[k], 12)}${enhanced[k]}`);
}
const report = {
  at: new Date().toISOString(), textFile, lines: lines.length, endpoint: endpointUrl, model,
  baseline, enhanced,
};
fs.writeFileSync(path.join(here, '.ab-report.json'), JSON.stringify(report, null, 2));
console.log(`\n报告已写入 ${path.join(here, '.ab-report.json')}`);
console.log('提示：条目质量（漏收/误收）还需抽样人工判定；落地率用「验收回扫」在站点侧复核。');
