// daemon/translate-test.mjs —— 翻译核心纯函数单测（镜像站点语义的关键行为）
// 跑法：node daemon/translate-test.mjs（不需要 mock）
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = await import(pathToFileURL(path.join(here, 'translate.mjs')).href);

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
  return Promise.resolve();
};

console.log('== 分段（镜像 createLineSegmenter） ==');
await t('默认 1500 字/30 行：短章一段、超行数拆分', () => {
  const short = Array.from({ length: 10 }, (_, i) => `第${i}行`);
  assert.equal(T.segmentLines(short).length, 1);
  const many = Array.from({ length: 65 }, (_, i) => `第${i}行`);
  const segs = T.segmentLines(many, { maxLines: 30 });
  assert.deepEqual(segs.map((s) => s.length), [30, 30, 5]);
});
await t('超长单行自成一段；字符预算按含换行 +1 计', () => {
  const long = 'あ'.repeat(1600);
  const segs = T.segmentLines(['短行', long, '短行'], { maxLen: 1500 });
  assert.equal(segs.length, 3, JSON.stringify(segs.map((s) => s.length)));
  assert.equal(segs[1][0], long);
});

console.log('== 提示词（镜像 openai-prompt） ==');
await t('系统提示固定文本；术语表仅注入"段内行命中"的条目', () => {
  const messages = T.buildTranslateMessages(['アリスが来た', 'ボブが寝た'], { 'アリス': '爱丽丝', 'ボブ': '鲍勃', 'キャロル': '卡罗尔' });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, T.TRANSLATE_SYSTEM_PROMPT);
  const user = messages[1].content;
  assert.ok(user.includes('翻译的时候参考下面的术语表：'));
  assert.ok(user.includes('アリス => 爱丽丝'));
  assert.ok(user.includes('ボブ => 鲍勃'));
  assert.ok(!user.includes('キャロル'), '段内未命中的术语不注入');
  assert.ok(user.includes('#1:アリスが来た') && user.includes('#2:ボブが寝た'));
});
await t('无命中术语时不出现术语表段；单行段追加"原文到此为止"', () => {
  const user = T.buildTranslateMessages(['こんにちは'], { 'アリス': '爱丽丝' })[1].content;
  assert.ok(!user.includes('术语表'));
  assert.ok(user.includes('#1:こんにちは'));
  assert.ok(user.endsWith('原文到此为止'));
});

console.log('== 解析 / 中文检测 ==');
await t('解析 #n: 行（含全角冒号）、保留前导空白、空行回原文', () => {
  const answer = '#1:甲\n#2：乙\n#3:  丙';
  const result = T.parseTranslateAnswer(answer, ['  a', 'b', 'c']);
  assert.deepEqual(result, ['  甲', '乙', '丙']);
  const withBlank = T.parseTranslateAnswer('#1:甲', ['a', '   ']);
  assert.deepEqual(withBlank, ['甲', '   '], '空行保留原文');
});
await t('缺失编号 → 抛"行数不匹配"', () => {
  assert.throws(() => T.parseTranslateAnswer('#1:甲', ['a', 'b']), /行数不匹配/);
});
await t('detectChinese：中文真、日文假、混排阈值', () => {
  assert.equal(T.detectChinese('你好，世界！'), true);
  assert.equal(T.detectChinese('こんにちは、世界'), false);
  assert.equal(T.detectChinese('第1行：アリスが来た'), false);
});

console.log('== 重试 / 二分 ==');
await t('translateSegment：成功后返回；行数不匹配重试后成功', async () => {
  let calls = 0;
  const ok = await T.translateSegment(['a', 'b'], { call: async () => ({ ok: true, content: '#1:甲\n#2:乙' }) });
  assert.deepEqual(ok, ['甲', '乙']);
  const flaky = await T.translateSegment(['a', 'b'], {
    call: async () => {
      calls += 1;
      return calls === 1 ? { ok: true, content: '#1:甲' } : { ok: true, content: '#1:甲\n#2:乙' };
    },
  });
  assert.deepEqual(flaky, ['甲', '乙']);
  assert.equal(calls, 2, '第一次解析抛"行数不匹配"后重试');
});
await t('translateSegment：连续失败 3 次 → 抛"翻译失败：重试次数过多"', async () => {
  let calls = 0;
  await assert.rejects(
    () => T.translateSegment(['a', 'b'], { call: async () => { calls += 1; return { ok: true, content: '#1:甲' }; } }),
    /翻译失败：重试次数过多/,
  );
  assert.equal(calls, 3);
});
await t('translateSegment：非中文输出重试（3 次后失败）', async () => {
  let calls = 0;
  await assert.rejects(
    () => T.translateSegment(['a'], { call: async () => { calls += 1; return { ok: true, content: '#1:こんにちは' }; } }),
    /翻译失败：重试次数过多/,
  );
  assert.equal(calls, 3);
});
await t('binaryTranslate：多行段失败时逐行兜底（单行成功/单行回退原文）', async () => {
  const result = await T.binaryTranslate(['a', 'b', 'c'], {
    call: async (messages) => {
      const user = messages[1].content;
      const count = [...user.matchAll(/^#\d+:/gm)].length;
      if (count > 1) return { ok: true, content: '#1:坏' };          // 多行总是坏
      return { ok: true, content: '#1:好' };                          // 单行总是好
    },
  });
  assert.deepEqual(result, ['好', '好', '好']);
});
await t('全空段直接返回（不请求）', async () => {
  let calls = 0;
  const result = await T.translateSegment(['', '  '], { call: async () => { calls += 1; return { ok: true, content: '' }; } });
  assert.deepEqual(result, ['', '  ']);
  assert.equal(calls, 0);
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
