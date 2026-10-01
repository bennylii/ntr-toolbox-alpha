// 生成可安装的 dev 版（装测试 profile 的篡改猴用）：
//   @name 加 (dev 术语增强)、@version 改 0.8.0-dev、清空 @downloadURL/@updateURL（防被 GreasyFork 覆盖）
// 跑法：node tools/.gen-dev.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'NTR_ToolBox.user.js');
const devPath = path.join(root, 'NTR_ToolBox.dev.user.js');

const src = fs.readFileSync(srcPath, 'utf8');
const out = src
  .replace(/^\/\/ @name\s+.*$/m, '// @name         NTR ToolBox (dev 术语增强)')
  .replace(/^\/\/ @version\s+.*$/m, '// @version      0.8.0-dev')
  .replace(/^\/\/ @downloadURL.*$/m, '')
  .replace(/^\/\/ @updateURL.*$/m, '');
// 行数必须一致（只动头部那 4 行的内容），防止正则误伤正文
if (out === src || out.split('\n').length !== src.split('\n').length) throw new Error('替换异常：dev 与主文件行数应一致');
fs.writeFileSync(devPath, out);
console.log('已生成', devPath, out.length, '字节');
