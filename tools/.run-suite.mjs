// 临时跑测脚本：node tools/.run-suite.mjs <suite文件> <页面URL>
import { execFileSync } from 'node:child_process';
const [suite, url] = process.argv.slice(2);
const cdp = (args) => execFileSync('node', ['tools/cdp.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
cdp(['open', url]);
await new Promise((r) => setTimeout(r, 1200));
cdp(['inject']);
let raw = '';
try { raw = cdp(['evalf', suite]); } catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }
const m = raw.match(/\{[\s\S]*\}/);
if (!m) { console.log('NO JSON: ' + raw.slice(0, 300)); process.exit(0); }
const j = JSON.parse(m[0]);
const walk = (node, path) => {
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && typeof x.ok === 'boolean');
    if (objs.length === node.length && objs.length > 0) {
      console.log(`  [${path}] 通过 ${objs.filter((x) => x.ok).length} / ${objs.length}`);
      objs.filter((x) => !x.ok).forEach((x) => console.log('   FAIL ' + (x.label || x.name || JSON.stringify(x).slice(0, 120)) + '  ' + JSON.stringify(x.extra === undefined ? null : x.extra).slice(0, 200)));
      return true;
    }
  }
  if (node && typeof node === 'object') {
    let any = false;
    for (const [k, v] of Object.entries(node)) any = walk(v, path ? path + '.' + k : k) || any;
    return any;
  }
  return false;
};
const had = walk(j, '');
if (!had) console.log('  ' + JSON.stringify(j).slice(0, 800));
const errs = j.errors || j.fatal || [];
(Array.isArray(errs) ? errs : [errs]).forEach((e) => console.log('  ERR ' + String(e).slice(0, 200)));
