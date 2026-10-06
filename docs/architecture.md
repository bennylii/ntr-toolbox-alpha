# 架构总览 —— ntr-toolbox-alpha（油猴 + 本地 daemon）

> 本文是**设计架构总览**：组件、数据流、关键决策与契约速查。模块级行为规格在 `docs/cleanroom/spec-01..10`，
> daemon 逐命令/逐页面的操作说明在 `daemon/README.md`，版本记录在 `CHANGELOG.md`。
> 三份文档的分工：本文讲「为什么这样设计 + 怎么拼起来」，spec 讲「行为契约」，daemon/README 讲「怎么用」。

## 1. 一页总览

```
┌─────────────────────────── 浏览器（用户 Chrome）────────────────────────────┐
│  n.novelia.cc 页面                                                          │
│   ├─ 油猴 ntr-toolbox-alpha                                                 │
│   │    ├─ 术语管线 UI（提取/队列/回滚/导入）──── 走站点 API（Bearer）          │
│   │    ├─ Daemon 连接模块 ──── 自动同步凭据（/ping 探测 + /auth 推送，指纹去重）│
│   │    └─ 面板角标 ────────── daemon 在线/离线                                 │
│   └─ 站点 GPT/Sakura 工作区（BETA pipeline 等）                              │
└──────────────┬──────────────────────────────────────────┬───────────────────┘
               │ HTTPS（经本地代理 6789 出网）               │ http://127.0.0.1:7331
               ▼                                          ▼ （CORS 白名单 + LNA 授权）
┌───────────────────────── 站点 n.novelia.cc ───────────┐  ┌──────────────────────────────────┐
│ /api/novel|wenku/...  translate-v2  glossary  file    │  │  daemon（Node ≥ 24，零 npm 依赖）  │
└───────────────────────────────────────────────────────┘  │  ├─ 控制面 HTTP（/ui + REST）      │
                                                           │  ├─ pipelines（单队列 FIFO）       │
                                                           │  │   ├─ translate（GPT worker）    │
                                                           │  │   ├─ glossary（术语管线）       │
                                                           │  │   ├─ check（质检 v2）          │
                                                           │  │   └─ lg-import（LG 结果导入）   │
                                                           │  ├─ Agent（工具循环 + 工作区）      │
                                                           │  ├─ LlmScheduler（双模型池）       │
                                                           │  ├─ SQLite（19 张表）             │
                                                           │  └─ Windows 托盘（tray.ps1）      │
                                                           └──────────────┬───────────────────┘
                                                                          ▼
                                                            LLM 端点（OpenAI 兼容；默认单线程逆向 Gemini）
```

分工：**浏览器端**负责「拿站点数据 + 写站点术语表 + 把凭据喂给 daemon」；**daemon** 负责「调 LLM 干活 + 按站点契约回写 + 提供控制台/Agent」。两者对同一本书互斥（单队列 + 书锁），避免双写。

## 2. 进程与目录

- **油猴**：`ntr-toolbox-alpha.user.js` 单文件；dev 构建由 `tools/.gen-dev.mjs` 生成。
- **daemon**：`daemon/index.mjs` 入口（CLI 子命令 + `serve` 常驻）；`serve` 托管控制面 HTTP、管线、Agent；托盘（`tray.vbs`/`tray.ps1`）可选拉起隐藏进程。
- **存储**：一个 SQLite（默认 `daemon/daemon.db`，`--db` 可换）——全部状态可序列化、可续跑；文件系统只有三类产物：`exports/`（LG 导出）、`uploads/`（LG 结果上传）、`work/<sessionId>/`（Agent 工作区，已 gitignore）。
- **mock**：`mock-llm/server.mjs` 一个进程同时模拟 LLM 上游与站点 API（8788 主车道 / 8790 daemon 车道）。

## 3. 数据模型（SQLite，19 张表）

| 归属 | 表 | 说明 |
|---|---|---|
| 项目 | `books` | 项目 = 登记的书（key/kind/origin/title/state） |
| 翻译 | `progress` `segcache` `chaptermeta` | 章/段级进度、段缓存（含处理链版本键）、章级重试计数 |
| 术语 | `ledger` `chunks` `snapshots` | 术语管线账本、分块缓存、写回前快照（回滚用） |
| 规则/提示词 | `rules` `prompts` | 文本处理链规则、提示词四槽（bookKey='' 为全局） |
| 质检 | `warnings` | 七码警告逐条落库（check 任务全量替换该书） |
| Agent | `agent_sessions` `agent_messages` `agent_decisions` | 会话/时间线/审批与追问（绑书 = 项目绑定） |
| 运维 | `runs` `usage` `metrics` `locks` `config` | run 记录、用量、RSS 采样、书锁、全局配置（唯一的「全局层」） |

设计要点：**一切工作数据按 bookKey 分账**，`config` 是唯一全局层（凭据/双池/serve/提示词全局槽/lastSync）。这使「项目一级化」不需要任何数据迁移。

## 4. 关键子系统

### 4.1 站点契约（真机核对，mock 同步改严）

1. `GET /api/novel|wenku/{...}/translate-v2/{translator}` → 任务 toc（含各章 glossaryUuid）+ glossary；
2. `POST .../translate-v2/{t}/chapter-task/{ch}?sync=false` → `paragraphJp` + 旧译（`sync` 必填，缺了 404）；
3. `POST .../translate-v2/gpt/chapter/{id}` body `{glossaryId, paragraphsZh, sakuraVersion:'0.9'}` → 章节提交（`sakuraVersion` 是站点工作区客户端的固定常量，段落数严格一致）；
4. `PUT .../glossary` 全量替换（写前快照 + 写后回读校验）；
5. `GET .../file?mode=jp-zh&filename=…`（`filename` 必填，缺了 404）。

鉴权 = `Authorization: Bearer <auth-v2.token>`；站点 API **不使用 Cookie**（refresh cookie 是 HttpOnly 且属站点域，daemon 无法也无需持有）。

### 4.2 LlmScheduler 与双模型池

所有 LLM 调用（翻译分段、术语提取/核实、Agent）都过一个调度器抽象，进程内有**两个实例**：

- **翻译池**（`config.workers` + `config.llm`）：翻译管线专用；站点「Daemon 连接」推送与设置页都可写（最后写入者赢）；
- **助手/术语池**（`config.agent.workers` + `config.agent.llm`）：Agent 与术语管线用（工具调用模型），**独立并发门/冷却/RPM**，与翻译互不抢在途额度；未显式配置时镜像翻译池，显式后油猴推送不再覆盖。

池内语义：全局并发门 `maxInFlight`（默认 1 = 单线程逆向 Gemini）、key 轮转 + 阶梯冷却（15s/30s/60s，业务错误不重试）、Retry-After 遵循、RPM、提示词预算（strict 可选）、用量记账。

### 4.3 翻译管线

`runBook` 生命周期：取 toc（按 glossaryUuid 判 expire/normal/all）→ 逐章 chapter-task → 行分段（1500 字/30 行）→ 段缓存命中检查 → LLM（`#编号` 协议 + 行数校验重试）→ 合并 → 处理链（资源投影/保留段/替换表/标点）→ 上传（§4.1-3 契约）→ 进度落库 → **丢弃本章文本**（内存纪律：浏览器工作区的泄漏修复）。断点续跑靠 progress + segcache。

### 4.4 术语管线

SCAN（分块缓存）→ EXTRACT（爬楼式轮次收敛）→ VERIFY（证据核实）→ 指南门槛 → 直写（快照+回读校验）或进 `proposals`（人工复核）。中断可续（chunks + ledger）。

### 4.5 质检 v2（对齐 LinguaGacha，确定性启发式、无 LLM）

七码：`FOREIGN_CHAR_RESIDUE`（字素分割 + 书写系统分类，片段证据，拉丁短串豁免）、`SIMILARITY`（原始文本包含或字符集 Jaccard>0.8；**JA→ZH 需残留证据护栏**）、`LINE_COUNT_MISMATCH`、`GLOSSARY`（scanAcceptance 语义）、`TEXT_PRESERVE`（保留段两侧提取逐位比对）、`PUNCTUATION_MISMATCH`（标点组序列）、`RETRY_THRESHOLD`（章级重试 ≥2）。
运行：`check` 任务 / agent `run_check`·`quality_report`；结果 **全量替换落 `warnings` 表**（不受 `--codes` 过滤影响），消费面：`GET /warnings`、agent `list_warnings`、工作区 `warnings/entries.jsonl`、控制台项目详情；`--propose` 可转提案，`--tsv` 导表。规格见 `docs/cleanroom/spec-07` §6-7。

### 4.6 保护规则（内置预设库 + 用户规则）

- 库：`presets/text_preserve.json` 五层——`base`（恒用：`<br>` 等）＋ `kag`/`renpy`/`rpgmaker`/`wolf`（引擎控制码，规则页可切换；`none` 全关）；
- 合并：`preserve.mjs effectivePreserveRules` = 预设层 + 用户 `text_preserve` 规则，**按 pattern 去重、用户优先**；
- 两个消费面用不同裁剪：**预处理链（prep）** 剔除 checkOnly 项（空白符/URI 逐字符占位会污染提示词），**质检** 全量并过滤空白片段（LG 语义）；
- 预设条目内置只读、不落 rules 表。

### 4.7 Agent（本地助手）

- **循环**：系统提示（含【当前项目】与技能目录）→ 模型 → 顺序派发工具 → `role:'tool'` 回填 → 至无工具调用或 `maxSteps`；支持中止/失败续聊/摘要压缩（`summaryUpTo` 切点）。
- **工具分层**：只读（自动）/ 执行（队列）/ 写入（审批）。审批 = decision broker（预览即真实 diff；GUI 卡片/CLI y/N；`workspace_apply` 的批次预览与实际提交是同一份差异）。
- **项目绑定**：会话绑书（控制台新会话挂当前项目）；每轮注入【当前项目】，工具 book 参数缺省即此书。
- **技能**：`skills/` SKILL.md 包（含隐藏前置 writing-guide / agent-charter），`read_skill` + `@点名`。
- **工作区（CodeAct，LG 同款）**：`workspace_run {script}` 在 `--permission` 沙箱子进程执行模型脚本（fs 限工作区、禁子进程/worker，网络开放；120s 超时）；`ws` API = `contract`（数据集/变更契约）+ `doing`（进度）+ `read`（站点章节按需拉取）。数据集/变更清单是 JSONL 文件（`changes/**`），`workspace_apply {}` 解析→fp 漂移检测→审批→逐 op 提交→回执 `{status, applied, rejected, destroyed}`。变更域 v1 = rules / glossary / prompts；章节译文不走工作区。

### 4.8 LG 互通

- **术语表**：`glossary-io` 双向 JSON（导入含引擎审计与 regex→规则分流）。
- **译文**：`export-src`（GUI 同款）导出「一行一段」纯文本 + 对齐清单（每章 `start/count/jpSha1`）→ LinguaGacha 翻译（txt 天然保行号）→ `import-lg`/GUI「导入 LG 译文」按清单切片回章，**三层校验**（总行数 / 每章行数+空行模式 / 源 sha1）后按 §4.1-3 契约提交；GUI 里以 `lg-import` 队列任务跑，进度经队列 progress 通道实时回显。

### 4.9 控制台（`/ui`，OpenWebUI 风格）

「项目」为一级容器：侧栏「当前项目」切换器全站跟随（通用 = 全局视角）；项目页卡片（进度/最近 run/队列/提案 + 导出/导入 LG 按钮）；任务/规则/提示词/助手/状态默认作用于当前项目；规则页另含「内置保护预设」选择器。提示词与技能是**全局资源**（LG 式）。设置页七个区块（连接 / 双模型池×2 / 调度×2 / 助手参数 / 站点与凭据）。

### 4.10 连接与凭据

- `GET /ping`（免凭据，带版本）供探测；`POST /auth` 收 `{token, workers, origin, auto}`，只回元数据不回 token；
- **自动同步**：油猴侧 30s glance tick 顺带做「指纹（token+workers+origin）变化才推」，页面加载即推、token 刷新 ≤30s 自愈，无变化零请求；`lastSync.mode = auto|manual` 可观测；
- CORS：内置 `n.novelia.cc` + localhost（不可移除）+ `config.serve.origins` 附加条目；仅监听 127.0.0.1；LNA/PNA 头已应答（真实用户首次需浏览器授权一次；headless 车道需禁用 LocalNetworkAccessChecks）。

### 4.11 托盘

`tray.vbs` → `tray.ps1`（PowerShell NotifyIcon，零依赖）：隐藏拉起 daemon（端口自读 `config.serve.port`/`.serve-port`），菜单 = 控制台/状态/日志/重启/退出，意外退出气泡提醒。

## 5. 控制面 API 速查

| 方法/路径 | 用途 |
|---|---|
| `GET /ping` `/status` `/settings` `/rules` `/prompts` `/books` `/progress` `/runs` `/proposals` `/snapshots` `/warnings` `/agent/*` | 只读面（探测/状态/配置回读/列表） |
| `POST /auth` | 凭据 + 翻译器推送（油猴自动/手动共用，带 auto 标记） |
| `POST /run` | 派发 `translate / glossary / check / lg-import`（单队列，lg-import 校验路径白名单） |
| `POST /settings` | llm / agent（含 workers、llm 子对象）/ origin / serve（port、origins）/ textPreserve.preset |
| `POST /books` `/rules` `/prompts` `/snapshots/restore` `/proposals/close|apply` `/lg/export|upload|verify` `/agent/*` | 各域写操作 |

写请求的 Origin 必须在白名单内；`/lg/verify` 与 `lg-import` 的文件路径必须在 `exports/` 或 `uploads/` 下（防任意文件读）。

## 6. 设计决策记录（为什么）

| 决策 | 理由 |
|---|---|
| daemon 零 npm 依赖（node:sqlite / Intl.Segmenter / 内置 fetch） | 个人工具可移植性优先；Node ≥ 24 内置能力足够 |
| 单队列 FIFO + 书锁 | 站点多写者会互相覆盖 glossaryUuid/章节；串行是唯一安全模型 |
| 双模型池 | 逆向 Gemini 单线程且不支持工具；助手/术语需要 tools——独立池让两侧并发互不阻塞 |
| 项目 = 书，不建新实体 | 数据层天然按 bookKey 分账；「项目化」是组织层，不动 schema |
| 质检 = 确定性启发式 + 落库，无 LLM | 与 LG 对齐且可重复；证据（片段/行号）直接可定位 |
| warnings 全量替换而非增量 | 源译文随时变，增量难保一致；全量 + 事务简单可靠 |
| 工作区 CodeAct 用文件（JSONL）跨调用 | 与 LG 契约一致；脚本无状态、可审计（changes 文件即提交意图） |
| 沙箱网络开放 | 与 LG 一致；fs 由 `--permission` 收紧，子进程/worker 被默认拒绝 |
| 自动同步挂 30s glance tick | 零新增定时器；指纹短路保证无变化零请求 |
| cookie 通道不做 | 站点 API 只认 Bearer；真正续期的 refresh cookie 是 HttpOnly，页面读不到 |
| UI_HTML 内嵌脚本禁反斜杠转义 | 模板字面量会吃掉 `\n` → 整页静默失效；守卫测试在 daemon-test |

## 7. 测试矩阵

| 层 | 套件 | 依赖 |
|---|---|---|
| 用户脚本引擎 | `tools/engine-test.mjs` | mock 8788 |
| 油猴页面流 | `tools/.e2e-*.js`（inject）+ `tools/.run-suite.mjs` | mock 8788/8790 + CDP 车道 |
| daemon 纯函数 | quality / translate / processors / prompt / glossary-io / lg-align / agent / agent-skills `-test.mjs` | 无 |
| daemon 冒烟 | `daemon/daemon-test.mjs`（102 例：管线/调度/质检/Agent/工作区/LG 导入/连接/托盘端口） | mock 8790 |
| 浏览器 e2e | `.e2e-agent-ui.js`（助手页）、`.e2e-lg-gui.js`（导入 GUI）、`.e2e-daemon-sync.js`（连接/自动同步） | mock 8790 + stub 7343 + CDP 车道 |
| 真机 | TM 重装（sha256 整文件比对）→ 实站全流程 | 测试 profile + LNA 旗标 |

## 8. 版本与发布

`@version`（userscript）与 `daemon/version.mjs` 同步；发布 = CHANGELOG 未发布段转正 + 打 tag `v*` + GitHub Release（附 userscript 资产）。dev 构建 `@version` 带 `-dev`、无更新 URL。
