// GlossaryEngine 单元测试：从 NTR_ToolBox.user.js 抽取引擎段并在 node 里跑
// 用法: node tools/engine-test.mjs        （集成测试需要 mock-llm/server.mjs 已在 8788 运行）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const userscript = path.join(here, '..', 'NTR_ToolBox.user.js');
const extractPath = path.join(here, '.engine-extract.mjs');

const source = fs.readFileSync(userscript, 'utf8');
const start = source.indexOf('// ==GlossaryEngine-START==');
const end = source.indexOf('// ==GlossaryEngine-END==');
if (start < 0 || end < 0) {
  console.error('未找到 GlossaryEngine 标记段');
  process.exit(2);
}
const section = source.slice(start, end);
fs.writeFileSync(extractPath, section + '\nexport { GlossaryEngine, GlossaryLog };\n');
const { GlossaryEngine: E, GlossaryLog: L } = await import('file://' + extractPath.replace(/\\/g, '/'));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { pass++; console.log('  ok  ' + name); })
        .catch((e) => { fail++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); });
    }
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message));
  }
};

console.log('== 文本工具 ==');
await t('normalize 全角转半角与半角片假名', () => {
  assert.equal(E.normalize('ＡＢＣ１２３'), 'ABC123');
  assert.equal(E.normalize('ｱｲｳｴｵ'), 'アイウエオ');
  assert.equal(E.normalize('ﾞﾟｰ'), '゛゜ー');
});
await t('cleanRuby 去振假名', () => {
  assert.equal(E.cleanRuby('|汉字[かんじ]'), '汉字');
  assert.equal(E.cleanRuby('(汉字/かんじ)'), '汉字');
  assert.equal(E.cleanRuby('[r_かんじ][ch_汉字]'), '汉字');
  assert.equal(E.cleanRuby('<ruby>汉字<rb>汉字</rb><rt>かんじ</rt></ruby>'), '汉字');
});
await t('displayLength', () => {
  assert.equal(E.displayLength('アリス'), 6);
  assert.equal(E.displayLength('ab'), 2);
  assert.equal(E.displayLength('汉字'), 4);
});
await t('splitByPunctuation', () => {
  assert.deepEqual(E.splitByPunctuation('アリス・リーン', true), ['アリス', 'リーン']);
  assert.deepEqual(E.splitByPunctuation('「ローズ娼館」', true), ['ローズ娼館']);
});
await t('ruleFilter', () => {
  assert.equal(E.ruleFilter('0=1.mp3'), true);
  assert.equal(E.ruleFilter('MapData/abc'), true);
  assert.equal(E.ruleFilter('123'), true);
  assert.equal(E.ruleFilter('テキストです'), false);
});
await t('languageFilter', () => {
  assert.equal(E.languageFilter('アリスは笑った', 'JA'), true);
  assert.equal(E.languageFilter('hello world', 'JA'), false);
});

console.log('== JSONLINE 解析 ==');
await t('repairJsonLine 正常/围栏/闲聊', () => {
  assert.equal(E.repairJsonLine('{"src":"アリス","dst":"爱丽丝","type":"女性人名"}').obj.dst, '爱丽丝');
  assert.equal(E.repairJsonLine('```jsonline'), null);
  assert.equal(E.repairJsonLine('条目前缀 {"src":"a","dst":"b","type":"地名"} 后缀').obj.src, 'a');
});
await t('repairJsonLine 单引号+尾逗号', () => {
  const r = E.repairJsonLine("{'src': 'アリス', 'dst': '爱丽丝', 'type': '地名',}");
  assert.equal(r.obj.src, 'アリス');
  assert.equal(r.obj.dst, '爱丽丝');
});
await t('repairJsonLine 断流半截行', () => {
  const r = E.repairJsonLine('{"src":"アリス","dst":"爱丽');
  assert.equal(r.obj.src, 'アリス');
  assert.equal(r.partial, true);
});
await t('parseResponse 剥离 think + 计数', () => {
  const content = '分析中……\n<think>推理过程</think>\n```jsonline\n{"src":"アリス","dst":"爱丽丝","type":"女性人名"}\n{"src":"ローズ","dst":"罗丝"} 说明\n```';
  const r = E.parseResponse(content);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].dst, '爱丽丝');
  assert.equal(r.entries[1].type, '');
});
await t('splitThink reasoning_content 风格', () => {
  const r = E.splitThink('推理……</think>{"src":"a"}');
  assert.equal(r.think, '推理……');
  assert.equal(r.result, '{"src":"a"}');
});

console.log('== 分块与后处理 ==');
await t('makeChunks 预算切分', () => {
  const lines = Array.from({ length: 50 }, (_, i) => '行' + i + '：' + 'x'.repeat(90));
  const chunks = E.makeChunks(lines, 500);
  assert.ok(chunks.length > 3, 'chunks=' + chunks.length);
  assert.equal(chunks.map((c) => c.lines.length).reduce((a, b) => a + b, 0), 50);
  assert.ok(chunks.every((c) => c.text.length <= 500 || c.lines.length === 1));
});
await t('postProcess 过滤/投票/计数', () => {
  const lines = ['アリスは笑った', 'アリスは泣いた', 'ローズ娼館へ行く', '短い'];
  const entries = [
    { src: 'アリス', dst: '爱丽丝', type: '女性人名' },
    { src: 'アリス', dst: '爱丽丝', type: '女性人名' },
    { src: 'アリス', dst: '阿丽丝', type: '女性人名' },
    { src: 'ローズ娼館', dst: '蔷薇娼馆', type: '组织' },
    { src: '消える', dst: '消失', type: '其他' },
    { src: '消える2', dst: '消失', type: 'other' },
    { src: '超'.repeat(20), dst: 'x', type: '地名' },
    { src: '无関系', dst: '无关', type: '地名' },
    { src: '同文', dst: '同文', type: '' },
  ];
  const g = E.postProcess(entries, lines);
  const byName = Object.fromEntries(g.map((v) => [v.src, v]));
  assert.equal(byName['アリス'].dst, '爱丽丝', '多数投票');
  assert.equal(byName['アリス'].count, 2, '出现次数');
  assert.equal(byName['ローズ娼館'].count, 1);
  assert.ok(!byName['消える'], '其他类应被过滤');
  assert.ok(!byName['消える2'], 'other 应被过滤');
  assert.ok(!byName['无関系'], '零命中应被过滤');
  assert.ok(!byName['同文'], 'src==dst 且无类型应被过滤');
  assert.ok(!Object.keys(byName).some((k) => k.length > 32), '超长应被过滤');
});
await t('postProcess 按标点拆分对齐', () => {
  const entries = [{ src: 'アリス・ローズ', dst: '爱丽丝·罗丝', type: '女性人名' }];
  const g = E.postProcess(entries, ['アリスとローズが来た', 'アリスは笑った']);
  const byName = Object.fromEntries(g.map((v) => [v.src, v]));
  assert.equal(byName['アリス'].dst, '爱丽丝');
  assert.equal(byName['ローズ'].dst, '罗丝');
});

console.log('== 行覆盖 / 缓存校验（「只补没跑过的行」的基石） ==');
await t('uncoveredLines 多重集差集（同一行出现多次也各自计数）', () => {
  const all = ['a', 'b', 'a', 'c'];
  assert.deepEqual(E.uncoveredLines(all, []), all, '没有记录时全是未覆盖');
  assert.deepEqual(E.uncoveredLines(all, [{ lines: ['a'] }, { lines: ['c'] }]), ['b', 'a'], '保持原文顺序');
  assert.deepEqual(E.uncoveredLines(all, [{ lines: ['a', 'a', 'c'] }]), ['b'], '重复行按出现次数扣');
  assert.deepEqual(E.uncoveredLines([], [{ lines: ['a'] }]), []);
  assert.deepEqual(E.uncoveredLines(['a'], [{ lines: ['别的行'] }]), ['a'], '不相干的行不影响');
  assert.deepEqual(E.uncoveredLines(['a'], [null, { }, { lines: null }]), ['a'], '脏记录不当成覆盖');
});
await t('linesMatch 逐行比对（缓存命中校验）', () => {
  assert.equal(E.linesMatch(['a', 'b'], ['a', 'b']), true);
  assert.equal(E.linesMatch(['a'], ['a', 'b']), false);
  assert.equal(E.linesMatch(['a'], ['b']), false);
  assert.equal(E.linesMatch(['a'], undefined), false);
  assert.equal(E.linesMatch(undefined, undefined), false);
});

console.log('== 指南清洗 / 可疑标记 ==');
await t('postProcess：整句（src 含句读）直接丢，并计入 postDrop', () => {
  const lines = ['アリスは笑った。', 'アリスは笑った', 'ローズが来た'];
  const entries = [
    { src: 'アリスは笑った。', dst: '爱丽丝笑了。', type: '' },
    { src: 'アリス', dst: '爱丽丝', type: '女性人名' },
    { src: 'ローズ、アリス', dst: '罗丝、爱丽丝', type: '' },
    { src: 'ローズ', dst: '罗丝', type: '女性人名' },
  ];
  const g = E.postProcess(entries, lines);
  const srcs = g.map((v) => v.src);
  assert.ok(!srcs.includes('アリスは笑った。'), '带句号的整句应被丢掉');
  assert.ok(!srcs.includes('ローズ、アリス'), '带顿号的混合串应被丢掉');
  assert.deepEqual(E.postDrop(), { punct: 2, honorific: 0 });
});

await t('postProcess：人名+敬称在裸名也成条目时丢掉（裸名不存在则保留）', () => {
  const lines = ['アルテさんが来た', 'アルテが笑った', 'ベル様が来た'];
  const entries = [
    { src: 'アルテさん', dst: '阿尔蒂小姐', type: '女性人名' },
    { src: 'アルテ', dst: '阿尔蒂', type: '女性人名' },
    { src: 'ベル様', dst: '贝尔大人', type: '女性人名' },   // 裸名「ベル」不在这张表里 → 保留
  ];
  const g = E.postProcess(entries, lines);
  const srcs = g.map((v) => v.src);
  assert.ok(!srcs.includes('アルテさん'), '裸名在表里 → 丢掉带敬称的');
  assert.ok(srcs.includes('ベル様'), '裸名不在表里 → 原样保留（交给再次筛选）');
  assert.equal(E.postDrop().honorific, 1);
});

await t('suspectReasons：四类形态各自命中、短的正当条目不误伤', () => {
  assert.deepEqual(E.suspectReasons('虹の橋'), [], '短地名不误伤');
  assert.deepEqual(E.suspectReasons('江の島'), []);
  assert.deepEqual(E.suspectReasons('キリタニヨースケ'), [], '9 字日文名不算过长');
  assert.deepEqual(E.suspectReasons('ミュート・ミュータント'), [], '中点不算标点');
  assert.deepEqual(E.suspectReasons('道化師のイラストが入っているペン'), ['过长', '像短语']);
  assert.deepEqual(E.suspectReasons('なるちゃん'), ['带敬称'], '整体昵称也先标着（人自己看一眼）');
  assert.deepEqual(E.suspectReasons('アリスさん'), ['带敬称']);
  assert.deepEqual(E.suspectReasons('アリスは笑った。'), ['含标点']);
  assert.deepEqual(E.suspectReasons(''), []);
});

await t('AUDIT_RULES：补上 复合词不拆 / 称呼控制 / 整句过长 三条判据', () => {
  assert.ok(/复合词不拆/.test(E.AUDIT_RULES));
  assert.ok(/称呼控制/.test(E.AUDIT_RULES));
  assert.ok(/整句\/过长/.test(E.AUDIT_RULES));
  assert.ok(/虹の橋/.test(E.AUDIT_RULES), '固定地名要写明保留');
  assert.ok(/なるちゃん/.test(E.AUDIT_RULES), '整体昵称要写明不算');
});

console.log('== 调试日志 ==');
await t('GlossaryLog：WARN/ERROR 始终记；INFO 只在「调试日志」开着时记', () => {
  L.setEnabledSource(() => false);
  L.clear();
  L.info('不该留在缓冲里的 info');
  L.warn('这条要留下');
  assert.deepEqual(L.lines().map((r) => r.msg), ['这条要留下']);
  assert.equal(L.stats().enabled, false);
  // 开着的时候 info 也要进来，并且能导出成文本
  L.setEnabledSource(() => true);
  L.clear();
  L.info('打开后的 info');
  const text = L.format();
  assert.ok(text.includes('打开后的 info'), text);
  assert.ok(/INFO/.test(text) && /^\[/.test(text), '导出文本带时间戳与级别');
  assert.equal(L.stats().enabled, true);
  L.clear();
  L.setEnabledSource(() => false);
  assert.equal(L.lines().length, 0, 'clear 之后应当为空');
});

console.log('== 空响应处理（fetchImpl 桩，无需 mock） ==');

await t('runJob 空响应按失败处理（不标记完成）', async () => {
  const emptyFetch = async () => new Response(
    JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '   ' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  const workers = [{ id: 'stub', model: 'm', endpoint: 'http://127.0.0.1:9', key: 'x' }];
  const requester = E.createRequester(workers, { timeoutMs: 1000, fetchImpl: emptyFetch });
  const lines = E.splitLines(Array.from({ length: 6 }, (_, i) => `第${i}行：アリスが魔導書を読む。`).join('\n'));
  const r = await E.runJob({ lines, callLLM: (m) => requester.call(m), options: { budgetChars: 3000, maxRounds: 2, concurrency: 1 } });
  assert.equal(r.chunksDone, 0, '空响应不应计为完成块');
  assert.ok(r.chunksFailed > 0, '应计为失败块 chunksFailed=' + r.chunksFailed);
  assert.equal(r.pendingLines, lines.length, '所有行应保持待处理');
  assert.equal(r.glossary.length, 0);
});

await t('runJob 上报 coveredLines（成功块覆盖的正文行数）', async () => {
  const lines = E.splitLines(Array.from({ length: 6 }, (_, i) => `第${i}行：アリスが魔導書を読む。`).join('\n'));
  const events = [];
  const r = await E.runJob({
    lines,
    callLLM: async () => ({ ok: true, content: '{"src":"アリス","dst":"爱丽丝","type":"女性人名"}\n' }),
    options: { budgetChars: 3000, maxRounds: 1, concurrency: 1 },
    onProgress: (p) => events.push(p),
  });
  assert.equal(events.find((p) => p.phase === 'done').coveredLines, lines.length, '收尾报告要带 coveredLines');
  assert.equal(r.processedLines.length, lines.length);
});

await t('runJob 轮次预算：第 2 轮原样重试，第 3 轮才减半', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `MARK${i}：` + 'ア'.repeat(60));
  const sizes = [];
  await E.runJob({
    lines,
    callLLM: async (messages) => {
      sizes.push(messages[0].content.split('\n').filter((l) => /^MARK\d/.test(l)).length);
      return { ok: false, error: 'stub（故意失败）' };
    },
    options: { budgetChars: 400, maxRounds: 3, concurrency: 1 },
  });
  const r0 = E.makeChunks(lines, 400).map((c) => c.lines.length);
  const r2 = E.makeChunks(lines, 200).map((c) => c.lines.length);
  assert.deepEqual(sizes.slice(0, r0.length), r0, '第 1 轮按预算切');
  assert.deepEqual(sizes.slice(r0.length, r0.length * 2), r0, '第 2 轮原样再来一次（同样切法，先不拆）');
  assert.deepEqual(sizes.slice(r0.length * 2, r0.length * 2 + r2.length), r2, '第 3 轮才减半');
});

await t('分块缓存命中要核对行：键相同但行不同 → 不吃缓存', async () => {
  const lines = ['アリスが笑った', 'ローズが泣いた'];
  const store = new Map([['ns/r0/c0', { entries: [{ src: 'ゴースト', dst: '鬼', type: '其他' }], lines: ['别的行'] }]]);
  let calls = 0;
  const r = await E.runJob({
    lines,
    callLLM: async () => { calls += 1; return { ok: true, content: '{"src":"アリス","dst":"爱丽丝","type":"女性人名"}' }; },
    options: { budgetChars: 3000, maxRounds: 1, concurrency: 1 },
    cache: { namespace: 'ns', get: (k) => Promise.resolve(store.get(k)), put: (k, v) => { store.set(k, v); return Promise.resolve(); } },
  });
  assert.equal(calls, 1, '行不一致时要真发请求');
  assert.ok(!r.glossary.some((e) => e.src === 'ゴースト'), '错位缓存里的条目不能混进来');
  assert.ok(r.glossary.some((e) => e.src === 'アリス'));
});

await t('分块缓存命中（行一致）：不重发请求，条目仍参与后处理', async () => {
  const lines = ['アリスが笑った', 'ローズが泣いた'];
  const store = new Map([['ns2/r0/c0', { entries: [{ src: 'アリス', dst: '爱丽丝', type: '女性人名' }], lines }]]);
  let calls = 0;
  const r = await E.runJob({
    lines,
    callLLM: async () => { calls += 1; return { ok: true, content: '' }; },
    options: { budgetChars: 3000, maxRounds: 1, concurrency: 1 },
    cache: { namespace: 'ns2', get: (k) => Promise.resolve(store.get(k)), put: (k, v) => { store.set(k, v); return Promise.resolve(); } },
  });
  assert.equal(calls, 0, '命中缓存不该再请求');
  assert.equal(r.chunksDone, 1);
  assert.equal(r.processedLines.length, lines.length, '缓存覆盖的行也算已覆盖');
  assert.equal(r.glossary.find((e) => e.src === 'アリス').count, 1);
});

await t('runJob 中途停止：没轮到的块的行仍算「待处理」', async () => {
  const lines = E.splitLines(Array.from({ length: 10 }, (_, i) => `第${i}行：${'ア'.repeat(250)}`).join('\n'));
  let calls = 0;
  const callLLM = async () => {
    calls += 1;
    return { ok: true, content: '{"src":"アア","dst":"啊啊","type":"其他"}\n' };
  };
  const r = await E.runJob({
    lines,
    callLLM,
    options: { budgetChars: 200, maxRounds: 1, concurrency: 1 },
    shouldStop: () => calls >= 3,     // 跑满 3 块就停，第 4 块起 worker 会直接退出
  });
  assert.equal(r.chunksDone, 3, '只应完成 3 块');
  assert.equal(r.pendingLines, lines.length - 3, '没轮到的 7 块的行要算回待处理（否则「待 0 行」会骗人）');
});

console.log('== 审计（再次筛选） ==');
await t('buildAuditPrompt：条数、JSONLINE、可选作品背景', () => {
  const entries = [
    { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 871 },
    { src: '代々木駅', dst: '代代木站', type: '地名', count: 1 },
    { src: '無次', dst: '无次', type: '其他' },
  ];
  const bare = E.buildAuditPrompt({ entries });
  assert.ok(bare.includes('术语表审核员'), '应含角色设定');
  assert.ok(bare.includes('一条同时像"该删"和"该留"时，一律保留'), '应含保守原则');
  const entryLines = (t) => t.split('\n').filter((l) => l.startsWith('{') && !l.includes('<与输入完全一致的原文>'));
  const lines = entryLines(bare).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, '每条一行 JSON');
  assert.deepEqual(lines[0], { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 871 });
  assert.equal(lines[2].count, 0, '没有次数时补 0');
  assert.equal(lines[2].type, '其他');
  const withCtx = E.buildAuditPrompt({ entries, context: { title: '某小说', snippet: '开头一句。' } });
  assert.ok(withCtx.startsWith('作品：某小说\n开头节选：开头一句。'), withCtx.slice(0, 40));
  assert.ok(withCtx.includes('{"src":"<与输入完全一致的原文>"'), '应含输出格式示例');
});

await t('parseAuditResponse：只认带 src 的判废行，坏行跳过', () => {
  const text = [
    '我看了一下：',
    '```jsonline',
    '{"src":"代々木駅","why":"3","note":"一次性站名"}',
    '{"src":"教室","why":2,"note":"通用名词"}',
    '{"src":"","why":"1"}',
    '{"dst":"没有 src 的行"}',
    '这不是 JSON',
    '```',
  ].join('\n');
  const { marks, count } = E.parseAuditResponse(text);
  assert.equal(count, 2);
  assert.deepEqual(marks.get('代々木駅'), { why: '3', note: '一次性站名' });
  assert.deepEqual(marks.get('教室'), { why: '2', note: '通用名词' });
  assert.equal(marks.size, 2);
  assert.equal(E.parseAuditResponse('').marks.size, 0);
});

await t('parseAuditResponse：think 段被剔除', () => {
  const { marks } = E.parseAuditResponse('<think>我先数一数……</think>\n{"src":"O","why":"4","note":"单字母"}');
  assert.equal(marks.size, 1);
  assert.equal(marks.get('O').why, '4');
});

const auditEntries = [
  { src: 'アリス', dst: '爱丽丝', count: 871 },
  { src: '代々木駅', dst: '代代木站', count: 1 },
  { src: '教室', dst: '教室', count: 9 },
  { src: 'O', dst: 'O', count: 14 },
  { src: 'ボブ', dst: '鲍勃', count: 30 },
];
await t('auditGlossary：分批请求（5 条 / 每批 2 → 3 批），标记按 src 回填', async () => {
  const calls = [];
  const res = await E.auditGlossary({
    entries: auditEntries,
    batchSize: 2,
    call: async (messages) => {
      const prompt = messages[0].content;
      const rows = prompt.split('\n').filter((l) => l.startsWith('{') && !l.includes('<与输入完全一致的原文>'));
      calls.push(rows.length);
      const first = rows[0];
      const src = JSON.parse(first).src;
      return { ok: true, content: `\`\`\`jsonline\n{"src":"${src}","why":"3","note":"mock"}\n\`\`\`` };
    },
  });
  assert.deepEqual(calls, [2, 2, 1], '每批条数');
  assert.equal(res.batches, 3);
  assert.equal(res.marks.size, 3, '每批第一条被标');
  assert.equal(res.unmatched, 0);
  assert.ok(res.marks.has('アリス') && res.marks.has('教室') && res.marks.has('ボブ'));
});

await t('auditGlossary：src 首尾空白差异也能匹配，不存在的 src 计 unmatched', async () => {
  const res = await E.auditGlossary({
    entries: [{ src: 'アリス', dst: '爱丽丝', count: 3 }],
    call: async () => ({ ok: true, content: '{"src":" アリス ","why":"2","note":"空\"}\n{"src":"幽灵","why":"1","note":"不存在"}' }),
  });
  assert.equal(res.marks.size, 1);
  assert.equal(res.unmatched, 1);
  assert.equal(res.marks.get('アリス').why, '2');
});

await t('auditGlossary：请求失败/乱答 → fail-open（不打标、不抛）', async () => {
  const entries = [{ src: 'アリス', dst: '爱丽丝', count: 3 }, { src: 'ボブ', dst: '鲍勃', count: 8 }];
  const boom = await E.auditGlossary({
    entries,
    batchSize: 1,
    call: async () => { throw new Error('网络炸了'); },
  });
  assert.equal(boom.marks.size, 0);
  assert.ok(boom.failed.includes('网络炸了'));
  const garbage = await E.auditGlossary({
    entries,
    call: async () => ({ ok: true, content: '都挺好的，没有问题。' }),
  });
  assert.equal(garbage.marks.size, 0);
  assert.equal(garbage.failed, '');
  const httpErr = await E.auditGlossary({
    entries,
    call: async () => ({ ok: false, error: 'HTTP 402：Insufficient Balance' }),
  });
  assert.equal(httpErr.marks.size, 0);
  assert.ok(httpErr.failed.includes('HTTP 402'));
});

await t('auditGlossary：onProgress 报告批次、空响应算失败', async () => {
  const seen = [];
  const res = await E.auditGlossary({
    entries: auditEntries,
    batchSize: 3,
    onProgress: (p) => seen.push(`${p.phase}${p.batch}/${p.batches}:${p.size}:${p.done}`),
    call: async () => ({ ok: true, content: '' }),
  });
  assert.deepEqual(seen, ['start1/2:3:0', 'done1/2:3:1', 'start2/2:2:1', 'done2/2:2:2']);
  assert.equal(res.marks.size, 0);
  assert.ok(res.failed.includes('空响应'));
});

await t('auditGlossary：并发 3 → 同时在飞铺满 3 路，结果照常合并', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ src: `术语${i}`, dst: '译', count: i + 1 }));
  let inflight = 0;
  let maxInflight = 0;
  const events = [];
  const res = await E.auditGlossary({
    entries,
    batchSize: 2,          // 5 批
    concurrency: 3,
    call: async (messages) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const row = messages[0].content.split('\n').find((l) => l.startsWith('{') && !l.includes('<与输入完全一致的原文>'));
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      return { ok: true, content: `{"src":${JSON.stringify(JSON.parse(row).src)},"why":"1","note":"mock"}` };
    },
    onProgress: (p) => events.push(`${p.phase}${p.done}`),
  });
  assert.equal(res.batches, 5);
  assert.equal(res.marks.size, 5, '每批标第一条 → 5 条');
  assert.equal(maxInflight, 3, `并发 3 时必须铺满 3 路（实测 ${maxInflight}）`);
  assert.deepEqual(events.filter((e) => e.startsWith('done')).map((e) => e.slice(4)), ['1', '2', '3', '4', '5'], 'done 计数 1→5');
});

await t('auditGlossary：并发下某一批失败只丢那一批（fail-open）', async () => {
  const entries = Array.from({ length: 6 }, (_, i) => ({ src: `词${i}`, dst: '译' }));
  let n = 0;
  const res = await E.auditGlossary({
    entries,
    batchSize: 2,
    concurrency: 3,
    call: async (messages) => {
      n += 1;
      if (n === 2) throw new Error('HTTP 500：炸了');
      const row = messages[0].content.split('\n').find((l) => l.startsWith('{') && !l.includes('<与输入完全一致的原文>'));
      return { ok: true, content: `{"src":${JSON.stringify(JSON.parse(row).src)},"why":"4","note":"x"}` };
    },
  });
  assert.equal(res.batches, 3);
  assert.equal(res.marks.size, 2, '两批好的各标一条');
  assert.ok(res.failed.includes('HTTP 500'));
});

await t('auditGlossary：shouldStop 停止派发新批次（已在飞的不受影响）', async () => {
  const entries = [{ src: '甲', dst: 'a' }, { src: '乙', dst: 'b' }, { src: '丙', dst: 'c' }];
  let calls = 0;
  const res = await E.auditGlossary({
    entries,
    batchSize: 1,
    concurrency: 1,          // 串行跑，第 1 批跑完就喊停
    call: async (messages) => {
      calls += 1;
      const row = messages[0].content.split('\n').find((l) => l.startsWith('{') && !l.includes('<与输入完全一致的原文>'));
      return { ok: true, content: `{"src":${JSON.stringify(JSON.parse(row).src)},"why":"2","note":"x"}` };
    },
    shouldStop: () => calls >= 1,
  });
  assert.equal(calls, 1, '第二批不该发出去');
  assert.equal(res.batches, 1);
  assert.equal(res.marks.size, 1);
});

await t('searchForContext：索引版与朴素版完全一致（掩码/重复行/单字/未命中）', () => {
  const lines = [
    'アリスはアリス・リーンを呼んだ。',
    'アリス・リーンは返事をした。',
    'アリスは笑った。',
    'ボブとアリスが来た。',
    'ボブとアリスが来た。',                 // 完全重复的行（count 按去重后的行文本算）
    'ローズ娼館の前で立ち止まった。',
    'ローズとアリス。',
    '教室で本を読む。',
    'O',
  ];
  const srcs = ['アリス', 'アリス・リーン', 'リーン', 'ボブ', 'ローズ', 'ローズ娼館', '教室', 'O', '存在しない', 'の'];
  // 朴素实现：逐行扫全文（改动前的行为）
  const naive = (glossary, all) => {
    const pool = all.slice();
    const ordered = glossary.slice().sort((a, b) => b.src.length - a.src.length);
    for (const entry of ordered) {
      const src = entry.src;
      const hits = new Set();
      pool.forEach((line, i) => { if (line.includes(src)) hits.add(i); });
      const contexts = [...new Set([...hits].map((i) => all[i]))].sort((a, b) => b.length - a.length);
      entry.context = contexts;
      entry.count = contexts.length;
      hits.forEach((i) => { pool[i] = pool[i].split(src).join('#'.repeat(src.length)); });
    }
    return ordered.sort((a, b) => b.count - a.count);
  };
  const fast = E.searchForContext(srcs.map((src) => ({ src, dst: '译' })), lines);
  const slow = naive(srcs.map((src) => ({ src, dst: '译' })), lines);
  assert.deepEqual(
    fast.map((e) => [e.src, e.count, e.context]),
    slow.map((e) => [e.src, e.count, e.context]),
  );
  // 掩码确实起作用：长词先匹配后，短词不该把长词里的字符再数一遍
  const alice = fast.find((e) => e.src === 'アリス');
  const leen = fast.find((e) => e.src === 'リーン');     // 只出现在「アリス・リーン」里，长词已被遮蔽 → 0
  assert.equal(leen.count, 0);
  assert.ok(alice.count > 0);
});

console.log('== 请求层 / 编排（需要 mock 端点在 8788） ==');
const mockAlive = await fetch('http://127.0.0.1:8788/v1/models').then(() => true).catch(() => false);
if (!mockAlive) {
  console.log('  --  mock 端点未启动，跳过集成测试（node mock-llm/server.mjs）');
} else {
  const mkText = (n) => Array.from({ length: n }, (_, i) =>
    `第${i}行：アリスとローズがローズ娼館で魔導書を読む。レナリスも来た。`).join('\n');

  await t('runJob 正常提取（mock）', async () => {
    const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: 'http://127.0.0.1:8788', key: 'x' }];
    const requester = E.createRequester(workers, { timeoutMs: 5000, rps: 20, rpm: 0 });
    const text = mkText(60);
    const lines = E.splitLines(text).filter((l) => E.languageFilter(l, 'JA') && !E.ruleFilter(l));
    const r = await E.runJob({ lines, callLLM: (m) => requester.call(m), options: { budgetChars: 600, maxRounds: 3, concurrency: 2 } });
    assert.ok(r.glossary.length > 0, '应提取到术语');
    const names = r.glossary.map((v) => v.src);
    assert.ok(names.includes('アリス') || names.includes('ローズ') || names.includes('レナリス'), 'names=' + names.join(','));
    assert.equal(r.pendingLines, 0, '应全部处理完');
  });

  await t('runJob 轮次收敛（429 失败后下一轮救回）', async () => {
    const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: `http://127.0.0.1:8788?script=429,429,ok,ok,ok,ok,ok,ok,ok,ok,ok,ok&run=${Date.now()}`, key: 'x' }];
    const requester = E.createRequester(workers, { timeoutMs: 5000, rps: 20, rpm: 0 });
    const text = mkText(30);
    const lines = E.splitLines(text);
    const events = [];
    const r = await E.runJob({
      lines, callLLM: (m) => requester.call(m),
      options: { budgetChars: 3000, maxRounds: 3, concurrency: 1 },
      onProgress: (p) => events.push(p),
    });
    assert.ok(r.chunksFailed > 0, '应有失败块 chunksFailed=' + r.chunksFailed);
    assert.ok(r.rounds > 1, '应进入第二轮 rounds=' + r.rounds);
    assert.ok(r.glossary.length > 0, '次轮应救回');
    assert.ok(events.some((p) => p.phase === 'cooldown'), '应按 Retry-After 等待');
  });

  await t('runJob 全失败 -> 部分失败保留状态', async () => {
    const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: 'http://127.0.0.1:8788?script=429', key: 'x' }];
    const requester = E.createRequester(workers, { timeoutMs: 5000, rps: 20, rpm: 0 });
    const lines = E.splitLines(mkText(10));
    const r = await E.runJob({ lines, callLLM: (m) => requester.call(m), options: { budgetChars: 3000, maxRounds: 2, concurrency: 1 } });
    assert.equal(r.glossary.length, 0);
    assert.ok(r.pendingLines > 0, 'pendingLines=' + r.pendingLines);
  });

  await t('runJob 断流截断（truncate）仍能救回完整行', async () => {
    const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: 'http://127.0.0.1:8788?fail=truncate', key: 'x' }];
    const requester = E.createRequester(workers, { timeoutMs: 5000, rps: 20, rpm: 0 });
    const lines = E.splitLines(mkText(20));
    const r = await E.runJob({ lines, callLLM: (m) => requester.call(m), options: { budgetChars: 3000, maxRounds: 1, concurrency: 1 } });
    assert.ok(r.glossary.length > 0, '完整行应存活');
    assert.ok(r.glossary.some((v) => v.partial), '应标记 partial 截断条目');
  });

  await t('runJob think 模式（剥离 thinking）', async () => {
    const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: 'http://127.0.0.1:8788?fail=think', key: 'x' }];
    const requester = E.createRequester(workers, { timeoutMs: 5000, rps: 20, rpm: 0 });
    const lines = E.splitLines(mkText(20));
    const r = await E.runJob({ lines, callLLM: (m) => requester.call(m), options: { budgetChars: 3000, maxRounds: 1, concurrency: 1 } });
    assert.ok(r.glossary.length > 0);
  });

  await t('buildChatUrl 端点拼接', () => {
    assert.equal(E.buildChatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(E.buildChatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(E.buildChatUrl('https://x.cn/v1/chat/completions'), 'https://x.cn/v1/chat/completions');
    assert.equal(E.buildChatUrl('http://127.0.0.1:8788'), 'http://127.0.0.1:8788/v1/chat/completions');
    assert.equal(E.buildChatUrl('http://127.0.0.1:8788?fail=429'), 'http://127.0.0.1:8788/v1/chat/completions?fail=429');
  });

  const lastBody = () => fetch('http://127.0.0.1:8788/__stats').then((r) => r.json()).then((s) => s.lastBody || {});

  await t('输出上限：默认（0）不发送 max_tokens', async () => {
    const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: 'http://127.0.0.1:8788', key: 'x' }];
    const requester = E.createRequester(workers, { timeoutMs: 5000, rps: 20 });
    await requester.call([{ role: 'user', content: '文本片段\n第1行：アリス' }]);
    const b = await lastBody();
    assert.equal(b.max_tokens, undefined, 'max_tokens 不该出现');
    assert.equal(b.max_completion_tokens, undefined, 'max_completion_tokens 不该出现');
    assert.equal(b.temperature, 0.3, '其它参数照旧');
  });

  await t('输出上限：设了才发 max_tokens / o 系列走 max_completion_tokens', async () => {
    const w = [{ id: 'mock', model: 'mock-glossary-1', endpoint: 'http://127.0.0.1:8788', key: 'x' }];
    await E.createRequester(w, { timeoutMs: 5000, rps: 20, maxTokens: 5000 }).call([{ role: 'user', content: '文本片段\n第1行：アリス' }]);
    assert.equal((await lastBody()).max_tokens, 5000);
    const wO = [{ id: 'mock', model: 'o3-mini', endpoint: 'http://127.0.0.1:8788', key: 'x' }];
    await E.createRequester(wO, { timeoutMs: 5000, rps: 20, maxTokens: 5000 }).call([{ role: 'user', content: '文本片段\n第1行：アリス' }]);
    const b = await lastBody();
    assert.equal(b.max_completion_tokens, 5000);
    assert.equal(b.max_tokens, undefined);
  });

  await t('审计走请求层（mock ?audit=2）：判废条数与 why/note 回填', async () => {
    const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: `http://127.0.0.1:8788?audit=2&run=${Date.now()}`, key: 'x' }];
    const requester = E.createRequester(workers, { timeoutMs: 8000, rps: 20, rpm: 0, temperature: 0 });
    const entries = [
      { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 871 },
      { src: '代々木駅', dst: '代代木站', type: '地名', count: 1 },
      { src: '教室', dst: '教室', type: '地名', count: 9 },
    ];
    const res = await E.auditGlossary({
      entries,
      call: (m) => requester.call(m),
      context: { title: 'mock 测试书', snippet: 'アリスが魔導書を読む。' },
    });
    assert.equal(res.marks.size, 2, 'mock 按 audit=2 回两条');
    assert.ok(res.marks.has('アリス') && res.marks.has('代々木駅'));
    assert.ok(res.marks.get('アリス').note.includes('mock 判废'), res.marks.get('アリス').note);
    assert.equal(res.failed, '');
  });

  await t('审计请求体不带 max_tokens（不会把思考算进预算）', async () => {
    const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: `http://127.0.0.1:8788?audit=1&run=${Date.now()}`, key: 'x' }];
    const requester = E.createRequester(workers, { timeoutMs: 8000, rps: 20, maxTokens: 0, temperature: 0 });
    await E.auditGlossary({ entries: [{ src: 'アリス', dst: '爱丽丝', count: 3 }], call: (m) => requester.call(m) });
    const stats = await fetch('http://127.0.0.1:8788/__stats').then((r) => r.json());
    assert.equal(stats.lastBody.max_tokens, undefined);
    assert.equal(stats.lastBody.max_completion_tokens, undefined);
    assert.equal(stats.lastBody.temperature, 0, '审计用温度 0');
  });

  await t('思考吃满预算（thinkbudget）：上限 8192 → 空响应失败；不发送上限 → 正常提取', async () => {
    const lines = E.splitLines(mkText(20));
    const w = (q) => [{ id: 'mock', model: 'mock-glossary-1', endpoint: `http://127.0.0.1:8788?fail=thinkbudget&run=${q}`, key: 'x' }];
    const busy = await E.runJob({
      lines,
      callLLM: (m) => E.createRequester(w('a'), { timeoutMs: 5000, rps: 20, maxTokens: 8192 }).call(m),
      options: { budgetChars: 3000, maxRounds: 1, concurrency: 1 },
    });
    assert.equal(busy.glossary.length, 0, '预算被思考吃满时应是空响应');
    assert.ok(busy.chunksFailed > 0, '应计为失败块');
    const free = await E.runJob({
      lines,
      callLLM: (m) => E.createRequester(w('b'), { timeoutMs: 5000, rps: 20 }).call(m),
      options: { budgetChars: 3000, maxRounds: 1, concurrency: 1 },
    });
    assert.ok(free.glossary.length > 0, '不发送上限时应能正常提取');
    assert.equal(free.pendingLines, 0);
  });
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
