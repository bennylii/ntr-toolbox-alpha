# tools/lg-compare —— LinguaGacha 流程同文对比（可复跑）

用**同一篇日文小说摘录**分别走 LinguaGacha v0.125.0 的官方 CLI 翻译流程和本仓库 daemon 的翻译核心，把两侧发给 LLM 的**每个请求的完整 system/user 提示词**落盘，用于管线行为对比。分析结论见 [`docs/lg-compare.md`](../../docs/lg-compare.md)。

两边都指向**假 LLM 端点**（确定性格式化译文），所以对比的是管线行为（分段/提示词/术语注入/重试/预过滤），不是译文质量。

## 文件

| 文件 | 说明 |
|---|---|
| `lg-input.txt` | 测试文本：kakuyomu 小说《小説家にさえなれればいいわたしと、わたしさえいればいい彼女。》（さーかい）正文 300 行摘录（原文件第 10–309 行，跳过导出头），**仅本地对比用途** |
| `lg-glossary.json` | 测试术语表（3 条，LG 质量规则格式 `[{"src","dst","info"}]`；daemon 侧驱动里以 `{jp: zh}` 平面对象等价注入） |
| `lg-flow-driver.test.ts` | LG 侧驱动：内置 OpenAI 兼容 stub（流式 SSE）+ `BackendResources/BackendServices` 进程内装配（`workerExecution=in_process`，不需要 Electron）+ LG 现成的 `run_cli_job`（= CLI 完整流程）。由 launcher 复制进 LG 仓库运行 |
| `run-lg-flow.mjs` | LG 侧 launcher：复制驱动进 `<LG>/src/backend/e2e/` → 跑 LG 自己的 vitest → 删临时副本（LG 的 vitest 只 include `src/**`，驱动必须落在那里才能跑） |
| `daemon-driver.mjs` | daemon 侧驱动：直接 import `daemon/translate.mjs` 真实核心（`segmentLines`/`translateSegment`，含 3 次重试/中文检测/二分），段间串行（真实管线是多 lane 并发，不影响请求形状） |
| `artifacts/` | 本次运行的证据：`lg-requests.jsonl`（LG 9 个请求全文）、`lg-status.jsonl`（CLI JSONL 状态事件）、`lg-out/`（LG 导出的译文 + `bilingual/` 双语）、`daemon-requests.jsonl`（daemon 10 个请求全文）、`daemon-out*.txt` |

## 复跑

前置（一次性）：

```sh
# LG checkout：本仓库根的 linguagacha/ junction（pin v0.125.0）
cd linguagacha && npm install --ignore-scripts   # 跳过 Electron 二进制（驱动用不到）
# Node ≥ 23.8（node:zstd）/ ≥ 22.5（node:sqlite）
```

LG 侧（自带 stub 端点，默认 127.0.0.1:8999，`LG_COMPARE_PORT`/`LG_REPO` 可覆盖）：

```sh
node tools/lg-compare/run-lg-flow.mjs
```

daemon 侧（mock 单开车道 8789，别和 8788 抢）：

```sh
PORT=8789 node mock-llm/server.mjs &
node tools/lg-compare/daemon-driver.mjs     # MOCK_URL 可覆盖端点
```

跑完 `artifacts/` 里的 `*-requests.jsonl` / `*-out*` 会被覆盖为最新结果。
