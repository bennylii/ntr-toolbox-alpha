# spec-06：LLM 调度器 / 接口池 / 严格单线程（clean-room 行为规格）

借鉴对象：LinguaGacha 0.125 `core/translation-request-scheduler.ts`、`core/request-rate.ts`（思路参考，独立实现，不逐行翻译）。
实现位置：`daemon/scheduler.mjs`（新增）；接线：`daemon/{translate,translate-pipeline,glossary-pipeline,server,index}.mjs`、`daemon/store.mjs`（新增 `usage` 表）。
背景：为「单线程 Gemini」场景提供进程级串行门与 key 池；同时修复现状缺口——`createRequester` 不消费 `rps/rpm`、translate 路径丢弃 `retryAfterMs`、`binaryTranslate` 可绕开并发上限、`serve` 的 `/run` 可并发多书、`/auth` 不热更新 workers。

## 1. 调度器实例

- `daemon/scheduler.mjs` 导出 `class LlmScheduler`；进程内只建一个实例（`index.mjs` 创建，两条管线共用）。
- 构造参数：`{ engine, store, log, options }`；options：
  - `maxInFlight`（默认 **1**）：全局同刻最多在途请求数；
  - `rpm`（默认 0 = 不限）：每分钟派发上限（对全池）；
  - `transportRetries`（默认 3）：传输层重试次数；
  - `cooldownSteps`（默认 `[15000, 30000, 60000]`，毫秒）：单 key 连续失败的冷却阶梯；
  - `timeoutMs`（默认 300000）：交给 `engine.createRequester`；
  - `maxPromptChars`（默认 12000）：提示词估算超限告警阈值（见 §6）；
  - `strictPrompt`（默认 false）：超限时是否直接失败。
- `setWorkers(workers)`：热替换接口池（`/auth` 推送后立即生效，无需重启）；替换时保留仍存在的 worker 的冷却状态（按 id 匹配），新 worker 直接 ready。
- `call(messages, { signal } = {})`：返回形状与 `engine.createRequester` 的 `call` 一致：`{ ok, content, think, finishReason, reasoningLen, workerId, error?, status?, retryAfterMs? }`。
- `stats()`：`{ requests, transportRetries, promptTokens, completionTokens, byWorker: {id: {requests, failures}}, maxObservedInFlight, lastError }`。

## 2. 全局并发门（FIFO）

1. 每个 `call` 先取许可：许可池大小 = `maxInFlight`；无许可时按 **FIFO** 排队，不插队、不超发。
2. 在途计数峰值记入 `stats().maxObservedInFlight`（供测试断言）。
3. **所有** LLM 调用都经调度器：翻译分段、`binaryTranslate` 的劈半、术语提取（`runJob`）、证据核实、审计、以及未来新增的 check/fix 等。`binaryTranslate` 的 `Promise.all` 两半各自取许可，因此在 `maxInFlight=1` 时自然串行。
4. 等待许可的时间不属于请求耗时，也不消耗 RPM 配额。

## 3. 接口池与冷却（key 池）

1. 池 = `workers` 数组（`{id, model, endpoint, key}`）；轮询选择 ready 的 worker 派发（顺序轮转，起点对齐上次选中的下一位）。
2. 单 worker 失败（429/503/超时/网络错误）按 `cooldownSteps` 阶梯冷却：第 1 次失败 15s、第 2 次 30s、第 3 次及以后 60s；成功清零阶梯与冷却。
3. 全部冷却时 **不得** 静默改用第一个：选择最早解冻的 worker，先等待其解冻（等待期间不占许可），再派发；等待上限 300s，超限返回失败。
4. 一个 worker 的 401/402/404 等「非限流业务错误」不计入阶梯冷却（记 failures，不冷却）。
5. 引擎侧 `createRequester` 自带的轮转/冷却不再参与决策：调度器每次传入显式 worker（`override.worker`），引擎的 markFail/markOk 副作用忽略即可。

## 4. 上游限流（Retry-After）与传输重试

1. 结果带 `retryAfterMs` 时（429/503/超时/正文含 retry-after），等待 = `max(上游给出值, 1000ms)`、上限 300s；等待后重试，最多 `transportRetries` 次。
2. 重试等待发生在**许可之外**（不占在途额度）；重试计数入 `stats().transportRetries`。
3. 重试耗尽：返回最后一次失败结果（保留 `retryAfterMs` 供调用方参考）；调用方的内容级重试语义不变（如 translate 的 3 次行数检查、二进制拆分）。
4. 单 worker 场景（Gemini 单 key）：限流等待同样生效，不会立刻重锤上游。

## 5. RPM 节流

- `rpm > 0` 时按 `60s / rpm` 的最小派发间隔节流（令牌桶，容量 1）；`rpm = 0` 不限。
- 节流与全局并发门独立：先过节流，再取许可（或反之，效果等价——同一时刻只有一个派发进入等待队列）。

## 6. 上下文预算（测量 + 告警 + 可选严格）

- `estimateTokens(messages)`：CJK 字符 ≈ 1 token，ASCII ≈ 0.25 token 的启发式（零依赖，不引 tokenizer）；`call` 前估算提示词 token 数与字符数。
- 估算字符数 > `maxPromptChars`：记警告一次（`log.log`），`stats` 计数；`strictPrompt=true` 时直接返回 `{ok:false, error:'prompt-too-long'}`，不发请求。
- **不静默裁剪内容**：裁剪策略（限注入术语条数、截断核实样本等）由各调用方自建提示词时保证；引擎内提示词只做测量与告警（油猴侧零改动承诺）。

## 7. 用量记账

- 调度器包装 `fetchImpl`：对每个 chat 响应用 `res.clone().json()` 尝试读取 `usage`（`prompt_tokens` / `completion_tokens`）；读不到时按估算值（提示词/回答字符数换算）。
- 落库：`usage(bookKey, runId, requests, promptTokens, completionTokens, at)`（新增表；无 runId 时记 0）。
- `/status` 附带最近 run 的用量汇总；CLI `status` 显示累计。

## 8. 控制面接线

- `server.mjs`：`/run` 改为**单队列**（FIFO，串行执行；同一时刻最多一个 runBook 在跑），返回 `{ok, queued, id}`；新增 `GET /runs?id=`（队列项状态：queued/running/done/failed/error）；`/status` 含队列快照与 `scheduler.stats()`。
- 每次 run 的选项（level/concurrency/maxChapters 等）以**参数**传入 runBook，不再改写共享 `pipeline.options`（消除并发变异）。
- `/auth` 更新凭据后调用 `scheduler.setWorkers(workers)` 立即生效。

## 9. 刻意差异（与 LG）

- 不实现自适应并发（LG 的 4→16 自动升降）；固定宽度，默认 1，可手动配置。
- 不实现 key 的 draining/probing 全状态机（只保留 ready/cooling 两态 + 阶梯冷却）。
- 不引入 tokenizer，只做启发式估算。

## 10. 等价验证

- `daemon/daemon-test.mjs` 新增：并发峰值 = 1（mock `/__stats.maxInFlight`）、key 冷却轮换（A 429 → 后续用 B）、Retry-After 被等待（mock `?fail=429&n=1` 带 Retry-After：1）、传输重试后成功、RPM 节流（两次派发间隔 ≥ 60/rpm）、用量落库、`/auth` 热更新生效、`/run` 队列串行。
- 既有 `daemon-test` 16 项、`translate-test` 12 项、`engine-test` 98 项保持全绿。
