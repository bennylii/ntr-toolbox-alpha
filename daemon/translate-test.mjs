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
await t('parseTranslateAnswerPartial：命中/缺失/空行语义与 parseTranslateAnswer 一致', () => {
  const { map, missing } = T.parseTranslateAnswerPartial('#1:甲\n#3：丙', ['  a', 'b', '   ']);
  assert.equal(map.get(0), '  甲', '保留原文前导空白');
  assert.deepEqual(missing, [1], '空行不进缺失清单');
  const full = T.parseTranslateAnswer('#1:甲\n#2:乙', ['  a', 'b']);
  const part = T.parseTranslateAnswerPartial('#1:甲\n#2:乙', ['  a', 'b']);
  assert.deepEqual([part.map.get(0), part.map.get(1)], full);
  assert.deepEqual(part.missing, []);
});
await t('detectChinese：中文真、日文假、混排阈值', () => {
  assert.equal(T.detectChinese('你好，世界！'), true);
  assert.equal(T.detectChinese('こんにちは、世界'), false);
  assert.equal(T.detectChinese('第1行：アリスが来た'), false);
});

console.log('== 重试 / 二分 ==');
await t('translateSegment：成功后返回；行数不匹配 → 只补缺失行后成功', async () => {
  let calls = 0;
  const ok = await T.translateSegment(['a', 'b'], { call: async () => ({ ok: true, content: '#1:甲\n#2:乙' }) });
  assert.deepEqual(ok, ['甲', '乙']);
  const flaky = await T.translateSegment(['a', 'b'], {
    call: async () => {
      calls += 1;
      return calls === 1 ? { ok: true, content: '#1:甲' } : { ok: true, content: '#1:乙' };
    },
  });
  assert.deepEqual(flaky, ['甲', '乙']);
  assert.equal(calls, 2, '第一次缺 #2 → 第二轮只补发缺失行');
});
await t('translateSegment：部分缺失只补缺失行（首轮 #1/#3 命中 → 补发请求只有 1 行）', async () => {
  const users = [];
  let retries = 0;
  const result = await T.translateSegment(['a', 'b', 'c'], {
    onRetry: (n) => { retries = n; },
    call: async (messages) => {
      users.push(messages[1].content);
      if (users.length === 1) return { ok: true, content: '#1:甲\n#3:丙' };
      return { ok: true, content: '#1:乙' };
    },
  });
  assert.deepEqual(result, ['甲', '乙', '丙'], '输出长度恒等输入、顺序正确');
  assert.equal(users.length, 2);
  assert.equal([...users[1].matchAll(/^#\d+:/gm)].length, 1, users[1]);
  assert.ok(users[1].includes('#1:b'), users[1]);
  assert.equal(retries, 1);
});
await t('translateSegment：全失败（无编号）走旧路径 → 3 次整段重试后失败', async () => {
  let calls = 0;
  await assert.rejects(
    () => T.translateSegment(['a', 'b'], { call: async () => { calls += 1; return { ok: true, content: '没有编号的散文' }; } }),
    /翻译失败：重试次数过多/,
  );
  assert.equal(calls, 3);
});
await t('translateSegment：补发耗尽（单行补发仍拿不到）→ 3 次调用后失败', async () => {
  let calls = 0;
  await assert.rejects(
    () => T.translateSegment(['a', 'b'], {
      call: async (messages) => {
        calls += 1;
        const count = [...messages[1].content.matchAll(/^#\d+:/gm)].length;
        return count >= 2 ? { ok: true, content: '#1:甲' } : { ok: true, content: '无编号' };
      },
    }),
    /翻译失败：重试次数过多/,
  );
  assert.equal(calls, 3);
});
await t('translateSegment：空行原样保留、不占补发编号', async () => {
  const users = [];
  const result = await T.translateSegment(['a', '   ', 'c'], {
    call: async (messages) => {
      users.push(messages[1].content);
      return { ok: true, content: '#1:甲\n#2:丙' };
    },
  });
  assert.deepEqual(result, ['甲', '   ', '丙']);
  assert.equal(users.length, 1, '空行不参与对账，无需补发');
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
await t('空段预过滤（④）：空段不进分段/请求；原位回填后段数与顺序不变', () => {
  const paragraphs = ['a', '', '  ', 'b'];
  const { filled, map } = T.splitEmptyParagraphs(paragraphs);
  assert.deepEqual(filled, ['a', 'b'], '空段不进请求');
  assert.deepEqual(map, [0, -1, -1, 1]);
  assert.equal(T.segmentLines(filled).length, 1);
  assert.deepEqual(T.mergeEmptyParagraphs(paragraphs, ['甲', '乙']), ['甲', '', '  ', '乙'], '原位回填（空段原样保留）');
  const allEmpty = T.splitEmptyParagraphs(['', '  ']);
  assert.equal(allEmpty.filled.length, 0, '全空章：零请求（filled 为空）');
  assert.deepEqual(T.mergeEmptyParagraphs(['', '  '], []), ['', '  ']);
});

console.log('== 相邻段上下文（参考上文/参考下文：LG 句末门槛 + 对称下文） ==');
await t('关闭态：用户消息与旧实现逐字一致（不带任何上下文块）', () => {
  const expected = [
    '翻译的时候参考下面的术语表：',
    'アリス => 爱丽丝',
    '小说原文如下，注意要保留每一段开头的编号：',
    '#1:アリスが来た',
    '#2:ボブが寝た',
  ].join('\n');
  const user = T.buildTranslateMessages(['アリスが来た', 'ボブが寝た'], { 'アリス': '爱丽丝' })[1].content;
  assert.equal(user, expected);
  // 空数组/空白串等同未传
  const same = T.buildTranslateMessages(['アリスが来た', 'ボブが寝た'], { 'アリス': '爱丽丝' }, { preceding: [], following: ['  '] })[1].content;
  assert.equal(same, expected);
});

await t('上下文块渲染：位置在术语表之前、块头与「不要翻译」指令、行首 # 转全角', () => {
  const user = T.buildTranslateMessages(['本文'], {}, {
    preceding: ['上文一。', '  #12:像是编号的行'],
    following: ['下文一。'],
  })[1].content;
  const lines = user.split('\n');
  const iPre = lines.indexOf('【参考上文】（只用于理解语境，不要翻译，也不要出现在输出里）：');
  const iFol = lines.indexOf('【参考下文】（同上）：');
  const iGloss = lines.findIndex((l) => l.startsWith('小说原文如下'));
  assert.ok(iPre >= 0 && iFol > iPre && iGloss > iFol, user);
  assert.equal(lines[iPre + 1], '上文一。');
  assert.equal(lines[iPre + 2], '  ＃12:像是编号的行', '行首 # 转全角，防止被解析器当成正文 #n: 行');
  assert.equal(lines[iFol + 1], '下文一。');
  assert.ok(user.includes('#1:本文'), '正文编号不受影响');
  assert.ok(!/^#12:/m.test(user), '上下文里的 #12: 不会以半角 # 出现在行首');
});

await t('单行段：上下文存在时仍追加「原文到此为止」', () => {
  const user = T.buildTranslateMessages(['本文'], {}, { preceding: ['上文。'] })[1].content;
  assert.ok(user.endsWith('原文到此为止'), user);
});

await t('collectContextLines：句末门槛（遇非句末行即停，不跳过）+ 上限', () => {
  const lines = ['一。', '二。', '三。', '未完的句子', '五。', '六。'];
  // 段 = ['六。']（start=5）
  const got = T.collectContextLines(lines, { start: 5, end: 6 }, { before: 3, after: 0 });
  assert.deepEqual(got.preceding, ['五。'], '只收紧邻的句末行；再往上碰到「未完的句子」就停（LG 语义），不继续收');
  assert.deepEqual(got.following, []);
  const more = T.collectContextLines(['一。', '二。', '三。', '四。'], { start: 4, end: 4 }, { before: 2 });
  assert.deepEqual(more.preceding, ['三。', '四。'], '最多 before 行，且按原序');
});

await t('collectContextLines：跨段回溯（从上一段末尾继续往前）+ 章首边界 + 空行跳过', () => {
  // 模拟 3 段：seg0 = 0..1，seg1 = 2..3，seg2 = 4..5；seg2 的上文应跨过 seg1 的末尾继续收
  const lines = ['s0a。', 's0b。', 's1a。', 's1b。', 's2a。', 's2b。'];
  const got = T.collectContextLines(lines, { start: 4, end: 6 }, { before: 3 });
  assert.deepEqual(got.preceding, ['s0b。', 's1a。', 's1b。'].slice(0, 3), '按原序、最多 3 行');
  const head = T.collectContextLines(lines, { start: 0, end: 2 }, { before: 3, after: 0 });
  assert.deepEqual(head.preceding, [], '章首无上文');
  const withBlank = T.collectContextLines(['一。', '', '  ', '三。'], { start: 4, end: 4 }, { before: 2 });
  assert.deepEqual(withBlank.preceding, ['一。', '三。'], '空行跳过、不占上限，顺序与原章一致');
});

await t('collectContextLines：下文对称（收到句末标点为止）+ 章末边界', () => {
  const lines = ['a。', 'b1', 'b2。', 'c。', 'd。'];
  const got = T.collectContextLines(lines, { start: 0, end: 1 }, { after: 3 });
  assert.deepEqual(got.following, ['b1', 'b2。'], '收到句末标点（含该行）就停');
  const tail = T.collectContextLines(lines, { start: 4, end: 5 }, { after: 3 });
  assert.deepEqual(tail.following, [], '章末无下文');
  const zero = T.collectContextLines(lines, { start: 0, end: 1 }, { before: 0, after: 0 });
  assert.deepEqual([zero.preceding, zero.following], [[], []], '0 = 关闭');
  assert.deepEqual(T.CONTEXT_END_PUNCTUATION.has('」'), true);
});

await t('translateSegment：首轮与补发请求都带上下文（③ 补发也保留）', async () => {
  const users = [];
  const result = await T.translateSegment(['a', 'b'], {
    preceding: ['上文。'],
    following: ['下文。'],
    call: async (messages) => {
      users.push(messages[1].content);
      return users.length === 1
        ? { ok: true, content: '#1:甲' }                     // 首轮缺 #2 → 走补发
        : { ok: true, content: '#1:乙' };
    },
  });
  assert.deepEqual(result, ['甲', '乙']);
  assert.equal(users.length, 2);
  assert.ok(users[0].includes('【参考上文】（') && users[0].includes('【参考下文】（同上）'), users[0].slice(0, 200));
  assert.ok(users[1].includes('【参考上文】（'), '补发请求同样带上下文');
  assert.ok(users[1].includes('#1:b'), '补发只含缺失行（重编号）');
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
