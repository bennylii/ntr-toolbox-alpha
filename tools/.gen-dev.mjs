// 生成可安装的 dev 版（装测试 profile 的篡改猴用）：
//   @name 加 (dev)、@version 追加 -dev、清空 @downloadURL/@updateURL（若有）
// 跑法：node tools/.gen-dev.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'ntr-toolbox-alpha.user.js');
const devPath = path.join(root, 'ntr-toolbox-alpha.dev.user.js');

const src = fs.readFileSync(srcPath, 'utf8');
const version = src.match(/^\/\/ @version\s+(.+)$/m)?.[1]?.trim() ?? '';
const devVersion = version.replace(/^v/, '') + '-dev';
const out = src
  .replace(/^\/\/ @name\s+.*$/m, '// @name         NTR Toolbox Alpha (dev)')
  .replace(/^\/\/ @version\s+.*$/m, `// @version      ${devVersion}`)
  .replace(/^\/\/ @downloadURL.*$/m, '')
  .replace(/^\/\/ @updateURL.*$/m, '');
// 行数必须一致（只动头部那 4 行的内容），防止正则误伤正文
if (out === src || out.split('\n').length !== src.split('\n').length) throw new Error('替换异常：dev 与主文件行数应一致');
fs.writeFileSync(devPath, out);
console.log('已生成', devPath, out.length, '字节');
