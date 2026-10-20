// run-lg-flow.mjs —— LG 侧对比驱动的 launcher
//
// 为什么要有这一步：LinguaGacha 的 vitest 配置只 include src/**，驱动测试必须落在
// <LG>/src/backend/e2e/ 下才能跑。所以这里把驱动复制进去 → 用 LG 自己的 vitest 跑 →
// 无论成败都删掉临时副本。LG 仓库的跟踪文件不受影响（pin 在 v0.125.0）。
//
// 前置（一次性）：
//   cd <LG仓库> && npm install --ignore-scripts   # 跳过 Electron 二进制，CLI/驱动用不到
//   node buildtools/build-workspace.mjs           # 仅 agent 驱动需要：构建 CodeAct 沙箱运行时
//   # Node ≥ 23.8（node:zstd）/ ≥ 22.5（node:sqlite）
//
// 用法：
//   node tools/lg-compare/run-lg-flow.mjs          # CLI 翻译流程驱动（lg-flow-driver）
//   node tools/lg-compare/run-lg-flow.mjs agent    # Agent 全链路驱动（lg-agent-driver）
//   LG_REPO 环境变量可覆盖 LG 仓库路径，默认 <本仓库>/linguagacha（junction）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL_DIR = path.join(REPO_ROOT, "tools", "lg-compare");
const LG_ROOT = path.resolve(process.env.LG_REPO ?? path.join(REPO_ROOT, "linguagacha"));
const DRIVER = process.argv[2] === "agent" ? "agent" : "flow";
const STUB_PORT = process.env.LG_COMPARE_PORT ?? (DRIVER === "agent" ? "8998" : "8999");

const DRIVERS = {
  flow: {
    source: "lg-flow-driver.test.ts",
    needsWorkspaceRuntime: false,
  },
  agent: {
    source: "lg-agent-driver.test.ts",
    needsWorkspaceRuntime: true, // 真 CodeAct 沙箱（node buildtools/build-workspace.mjs 的产物）
  },
};
const driver = DRIVERS[DRIVER];

const driver_source = path.join(TOOL_DIR, driver.source);
const driver_target = path.join(LG_ROOT, "src", "backend", "e2e", driver.source);
const artifact_dir = path.join(TOOL_DIR, "artifacts");

for (const [label, p] of [["LG 仓库", LG_ROOT], ["LG vitest 配置", path.join(LG_ROOT, "buildtools/vitest/vitest.config.ts")], ["LG node_modules", path.join(LG_ROOT, "node_modules")]]) {
  if (!fs.existsSync(p)) {
    console.error(`[run-lg-flow] ${label}不存在：${p}`);
    console.error("[run-lg-flow] 请确认 linguagacha checkout 已就位并完成 npm install --ignore-scripts（见本目录 README）。");
    process.exit(1);
  }
}
if (driver.needsWorkspaceRuntime && !fs.existsSync(path.join(LG_ROOT, "build", "resources", "workspace", "package.json"))) {
  console.error(`[run-lg-flow] CodeAct 沙箱运行时不存在：<LG>/build/resources/workspace`);
  console.error("[run-lg-flow] 请先在 LG 仓库执行：node buildtools/build-workspace.mjs");
  process.exit(1);
}

const env = {
  ...process.env,
  LG_COMPARE_ARTIFACTS: artifact_dir,
  LG_COMPARE_INPUT: path.join(TOOL_DIR, "lg-input.txt"),
  LG_COMPARE_PORT: String(STUB_PORT),
  LG_COMPARE_WORKSPACE_RUNTIME: path.join(LG_ROOT, "build", "resources", "workspace"),
};
if (DRIVER === "flow") env.LG_COMPARE_GLOSSARY = path.join(TOOL_DIR, "lg-glossary.json");

fs.mkdirSync(artifact_dir, { recursive: true });
fs.copyFileSync(driver_source, driver_target);
let result;
try {
  result = spawnSync("npx", ["vitest", "run", `src/backend/e2e/${driver.source}`, "--config", "buildtools/vitest/vitest.config.ts"], {
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
console.log(`[run-lg-flow] 完成（${DRIVER}）。请求日志/状态/译文输出在 ${artifact_dir}`);
