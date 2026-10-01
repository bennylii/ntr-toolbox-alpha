// 一次性体检：拿导出的队列备份，看《术语表使用指南》那几类形态各命中多少条
// 用法: node tools/.scan-guide-gaps.mjs [备份.json]   （默认找 Downloads 里最新的那个）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'ntr-toolbox-alpha.user.js'), 'utf8');
const extractPath = path.join(here, '.engine-extract.mjs');
fs.writeFileSync(extractPath, source.slice(source.indexOf('// ==GlossaryEngine-START=='), source.indexOf('// ==GlossaryEngine-END==')) + '\nexport { GlossaryEngine };\n');
const { GlossaryEngine: E } = await import('file://' + extractPath.replace(/\\/g, '/'));

const pickBackup = () => {
  if (process.argv[2]) return process.argv[2];
  const dir = path.join(os.homedir(), 'Downloads');
  const files = fs.readdirSync(dir).filter((f) => /^ntr-glossary-queue\.\d+\.json$/.test(f)).sort();
  if (files.length === 0) throw new Error('没找到 ntr-glossary-queue.*.json，直接传路径吧');
  return path.join(dir, files[files.length - 1]);
};
const file = pickBackup();
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = [];
(data.jobs || []).forEach((j) => (j.entries || []).forEach((e) => entries.push({ ...e, job: j.title })));
console.log(`备份：${(data.jobs || []).length} 个任务 / ${entries.length} 条术语\n`);

const KEI = /(さん|様|ちゃん|ちゃん|君|くん|先生|先輩|殿|嬢|氏|サン|たん|坊|ちゃん)$/;
const KINSHIP = /^(お)?(母さん|父さん|兄さん|姉さん|爺さん|婆さん|母|父|兄|姉|妹|弟|祖父|祖母|おばさん|おじさん)/;
const SENT = /[。！？…!?、]/;
const QUOTE = /^[「『]|[」』]$/;

const buckets = { 敬称后缀: [], 亲缘称呼: [], 整句或带标点: [], 过长: [], 复合词含の: [] };
for (const e of entries) {
  const src = String(e.src || '');
  if (KEI.test(src)) buckets.敬称后缀.push(e);
  if (KINSHIP.test(src)) buckets.亲缘称呼.push(e);
  if (SENT.test(src) || QUOTE.test(src)) buckets.整句或带标点.push(e);
  if (E.displayLength(src) > 12) buckets.过长.push(e);
  if (src.includes('の')) buckets.复合词含の.push(e);
}
for (const [k, list] of Object.entries(buckets)) {
  console.log(`== ${k}：${list.length} 条`);
  list.slice(0, 8).forEach((e) => console.log(`   ${e.src} => ${e.dst}  [${e.type || '-'} / count ${e.count}]`));
  if (list.length > 8) console.log(`   … 另有 ${list.length - 8} 条`);
}
// 交叉：既含の又超过 8 字（最像「复合词不拆」那条禁令的）
const compound = entries.filter((e) => String(e.src).includes('の') && E.displayLength(String(e.src)) >= 8);
console.log(`\n== 含「の」且 ≥8 字（最像复合短语）：${compound.length} 条`);
compound.slice(0, 15).forEach((e) => console.log(`   ${e.src} => ${e.dst}  [${e.type || '-'} / count ${e.count}]`));
