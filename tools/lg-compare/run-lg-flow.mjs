// run-lg-flow.mjs —— LG 侧对比驱动的 launcher
//
// 为什么要有这一步：LinguaGacha 的 vitest 配置只 include src/**，驱动测试必须落在
// <LG>/src/backend/e2e/ 下才能跑。所以这里把驱动复制进去 → 用 LG 自己的 vitest 跑 →
// 无论成败都删掉临时副本。LG 仓库的跟踪文件不受影响（pin 在 v0.125.0）。
//
// 前置（一次性）：
//   cd <LG仓库> && npm install --ignore-scripts   # 跳过 Electron 二进制，CLI/驱动用不到
//   # Node ≥ 23.8（node:zstd）/ ≥ 22.5（node:sqlite）
//
// 用法：node tools/lg-compare/run-lg-flow.mjs
//   LG_REPO 环境变量可覆盖 LG 仓库路径，默认 <本仓库>/linguagacha（junction）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL_DIR = path.join(REPO_ROOT, "tools", "lg-compare");
const LG_ROOT = path.resolve(process.env.LG_REPO ?? path.join(REPO_ROOT, "linguagacha"));
const STUB_PORT = process.env.LG_COMPARE_PORT ?? "8999";

const driver_source = path.join(TOOL_DIR, "lg-flow-driver.test.ts");
const driver_target = path.join(LG_ROOT, "src", "backend", "e2e", "lg-flow-driver.test.ts");
const artifact_dir = path.join(TOOL_DIR, "artifacts");

for (const [label, p] of [["LG 仓库", LG_ROOT], ["LG vitest 配置", path.join(LG_ROOT, "buildtools/vitest/vitest.config.ts")], ["LG node_modules", path.join(LG_ROOT, "node_modules")]]) {
  if (!fs.existsSync(p)) {
    console.error(`[run-lg-flow] ${label}不存在：${p}`);
    console.error("[run-lg-flow] 请确认 linguagacha checkout 已就位并完成 npm install --ignore-scripts（见本目录 README）。");
    process.exit(1);
  }
}

const env = {
  ...process.env,
  LG_COMPARE_ARTIFACTS: artifact_dir,
  LG_COMPARE_INPUT: path.join(TOOL_DIR, "lg-input.txt"),
  LG_COMPARE_GLOSSARY: path.join(TOOL_DIR, "lg-glossary.json"),
  LG_COMPARE_PORT: String(STUB_PORT),
};

fs.mkdirSync(artifact_dir, { recursive: true });
fs.copyFileSync(driver_source, driver_target);
let result;
try {
  result = spawnSync("npx", ["vitest", "run", "src/backend/e2e/lg-flow-driver.test.ts", "--config", "buildtools/vitest/vitest.config.ts"], {
    cwd: LG_ROOT,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
} finally {
  fs.rmSync(driver_target, { force: true });
}

if (!result || result.status !== 0) {
  console.error("[run-lg-flow] LG 侧驱动失败（产物目录里可能只有部分文件）。");
  process.exit(result?.status ?? 1);
}
console.log(`[run-lg-flow] 完成。请求日志/状态/译文输出在 ${artifact_dir}`);
