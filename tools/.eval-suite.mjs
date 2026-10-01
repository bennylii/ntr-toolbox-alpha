// 评估 e2e 套件输出：node tools/.eval-suite.mjs <cdp原始输出文件>
import fs from 'node:fs';
const file = process.argv[2];
const s = fs.readFileSync(file, 'utf8');
const start = s.indexOf('{');
if (start < 0) { console.log('NO JSON: ' + s.slice(0, 300)); process.exit(0); }
let depth = 0; let end = -1; let inStr = false; let esc = false;
for (let i = start; i < s.length; i += 1) {
  const ch = s[i];
  if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
  if (ch === '"') { inStr = true; continue; }
  if (ch === '{') depth += 1;
  else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
}
if (end < 0) { console.log('INCOMPLETE JSON (被截断？) 前 300 字: ' + s.slice(start, start + 300)); process.exit(0); }
const j = JSON.parse(s.slice(start, end + 1));

if (Array.isArray(j.checks)) {
  console.log(`checks 通过 ${j.checks.filter((c) => c.ok).length} / ${j.checks.length}`);
  j.checks.filter((c) => !c.ok).forEach((c) => console.log('  FAIL ' + c.label + '  ' + JSON.stringify(c.extra === undefined ? null : c.extra).slice(0, 240)));
} else if (Array.isArray(j.pass) || Array.isArray(j.fail)) {
  console.log(`pass ${(j.pass || []).length} / fail ${(j.fail || []).length}`);
  (j.fail || []).forEach((f) => console.log('  FAIL ' + String(f).slice(0, 240)));
} else if (Array.isArray(j.cases)) {
  console.log(`cases ${j.cases.length}`);
  j.cases.forEach((c) => {
    const stats = (c.afterPick && c.afterPick.stats) || (c.overlay && c.overlay.stats) || '';
    const m = /提取 (\d+) 条/.exec(stats);
    const count = m ? Number(m[1]) : 0;
    const loaded = count > 0 || /来源/.test(stats);
    let verdict;
    if (c.expectNoLoad) verdict = loaded ? 'BAD(不该载入)' : 'ok(未载入)';
    else if (count > 0) verdict = 'ok(已载入)';
    else if (c.put) verdict = 'ok(拖入后写入)';      // 拖文件是开弹层之后才发生的，stats 快照还是 0
    else verdict = 'note(空表)';
    console.log(`  ${verdict} ${c.label} | ${stats}${c.put ? ' | PUT ' + ((c.put.keys || []).length) + ' 条' : ''}`);
  });
  (j.parser || []).forEach((p) => console.log(`  parser ${p.label}: ${p.entries.length} 条`));
} else {
  console.log('未识别的结构，键: ' + Object.keys(j).join(','));
  console.log(JSON.stringify(j).slice(0, 400));
}
const errs = j.errors || j.fatal || [];
(Array.isArray(errs) ? errs : [errs]).forEach((e) => console.log('  ERR ' + String(e).slice(0, 240)));
