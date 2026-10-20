# tools/lg-compare —— LinguaGacha 流程同文对比（可复跑）

用**同一篇日文小说摘录**分别走 LinguaGacha v0.125.0 的官方 CLI 翻译流程和本仓库 daemon 的翻译核心，把两侧发给 LLM 的**每个请求的完整 system/user 提示词**落盘，用于管线行为对比。分析结论见 [`docs/lg-compare.md`](../../docs/lg-compare.md)。另含 **Agent 模式与技能系统**的同维实测（LG 的 agent 全链路：真技能 → 真沙箱提取 → 真审批落库 → agent 内批量翻译；daemon 的 agent 真内核 + 真技能目录 + 真审批往返）。

两边都指向**假 LLM 端点**（确定性格式化译文），所以对比的是管线/Agent 行为（分段/提示词/术语注入/重试/预过滤、技能注入/工具循环/审批），不是译文质量。

## 文件

| 文件 | 说明 |
|---|---|
| `lg-input.txt` | 测试文本：kakuyomu 小说《小説家にさえなれればいいわたしと、わたしさえいればいい彼女。》（さーかい）正文 300 行摘录（原文件第 10–309 行，跳过导出头），**仅本地对比用途** |
| `lg-glossary.json` | 测试术语表（3 条，LG 质量规则格式 `[{"src","dst","info"}]`；daemon 侧驱动里以 `{jp: zh}` 平面对象等价注入） |
| `lg-flow-driver.test.ts` | LG 侧 CLI 流程驱动：内置 OpenAI 兼容 stub（流式 SSE）+ `BackendResources/BackendServices` 进程内装配（`workerExecution=in_process`，不需要 Electron）+ LG 现成的 `run_cli_job`。由 launcher 复制进 LG 仓库运行 |
| `lg-agent-driver.test.ts` | LG 侧 **Agent 全链路**驱动：同一进程内装配 + `AgentService/AgentSkillsService/AgentWorkspaceService/AgentWorkspaceRunner` 真件，stub 扮演 agent 模型（按剧本发 tool_calls），走真 read_skill → 真 workspace_run（CodeAct 沙箱）→ 真 workspace_apply（manual 审批，驱动自动放行）→ 术语落 rules 表 → agent 内 `run_batch_item_translation` 翻译全文 |
| `run-lg-flow.mjs` | LG 侧 launcher：复制驱动进 `<LG>/src/backend/e2e/` → 跑 LG 自己的 vitest → 删临时副本（LG 的 vitest 只 include `src/**`）。用法：`node run-lg-flow.mjs [flow|agent]` |
| `daemon-driver.mjs` | daemon 侧翻译管线驱动：直接 import `daemon/translate.mjs` 真实核心（`segmentLines`/`translateSegment`），段间串行（真实管线是多 lane 并发，不影响请求形状） |
| `daemon-agent-driver.mjs` | daemon 侧 **Agent** 驱动：真 `createAgentLoop` + 真 `skills/` 目录（promptText 进 system + `read_skill`）+ 真 decision broker（审批写入/ask_user 提问，驱动自动作答），模型指向 mock 8790 的 `?toolcall=` 剧本 |
| `artifacts/` | 本次运行的证据：`lg-requests.jsonl`、`lg-status.jsonl`、`lg-out/`（LG 导出译文+双语）、`daemon-requests.jsonl`、`daemon-out*.txt`（管线对比）；`lg-agent-{requests,summary,glossary,timeline}.*`、`daemon-agent-{requests,summary,timeline}.*`（Agent 对比） |

## 复跑

前置（一次性）：

```sh
# LG checkout：本仓库根的 linguagacha/ junction（pin v0.125.0）
cd linguagacha && npm install --ignore-scripts   # 跳过 Electron 二进制（驱动用不到）
node buildtools/build-workspace.mjs              # 仅 agent 驱动需要：构建 CodeAct 沙箱运行时
# Node ≥ 23.8（node:zstd）/ ≥ 22.5（node:sqlite）
```

LG 侧（自带 stub 端点，flow 默认 8999 / agent 默认 8998，`LG_COMPARE_PORT`/`LG_REPO` 可覆盖）：

```sh
node tools/lg-compare/run-lg-flow.mjs          # CLI 翻译流程
node tools/lg-compare/run-lg-flow.mjs agent    # Agent 全链路（术语提取→审批落库→批量翻译）
```

daemon 侧（mock 单开车道 8789/8790，别和 8788 抢）：

```sh
PORT=8789 node mock-llm/server.mjs &
node tools/lg-compare/daemon-driver.mjs        # MOCK_URL 可覆盖端点

PORT=8790 node mock-llm/server.mjs &
node tools/lg-compare/daemon-agent-driver.mjs  # Agent 轮次（技能注入/工具循环/审批）
```

跑完 `artifacts/` 里的 `*-requests.jsonl` / `*-out*` 会被覆盖为最新结果。

