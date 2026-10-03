// daemon/engine.mjs —— 运行时抽取引擎段（与 ntr-toolbox-alpha.user.js 永远同源）
// 启动时从仓库根的用户脚本切出 ==GlossaryEngine== 标记段，写入 .engine.mjs 缓存
// （带内容 hash）后动态 import；源码变化自动重建，无需构建步骤。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cachePath = path.join(here, '.engine.mjs');
const USERSCRIPT = 'ntr-toolbox-alpha.user.js';

let cached = null;
let cachedHash = '';

export async function loadEngine() {
  const source = fs.readFileSync(path.join(root, USERSCRIPT), 'utf8');
  const start = source.indexOf('// ==GlossaryEngine-START==');
  const end = source.indexOf('// ==GlossaryEngine-END==');
  if (start < 0 || end < 0) throw new Error(`未在 ${USERSCRIPT} 找到 GlossaryEngine 标记段`);
  const section = source.slice(start, end);
  const hash = crypto.createHash('sha1').update(section).digest('hex').slice(0, 12);
  if (cached && cachedHash === hash) return cached;

  let existing = '';
  try { existing = fs.readFileSync(cachePath, 'utf8'); } catch { }
  if (!existing.includes(`/*engine-hash:${hash}*/`)) {
    fs.writeFileSync(cachePath, `/*engine-hash:${hash}*/\n` + section + '\nexport { GlossaryEngine, GlossaryLog };\n');
  }
  const mod = await import(pathToFileURL(cachePath).href + `?v=${hash}`);   // 变体 URL 绕开 ESM 缓存
  cached = mod.GlossaryEngine;
  cachedHash = hash;
  return cached;
}

export { root as repoRoot };
