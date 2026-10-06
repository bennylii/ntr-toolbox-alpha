# daemon —— GPT 翻译 worker（站点工作区兼容）

本地常驻进程：用 Node 替代 auto-novel「GPT 工作区」的浏览器 worker——逐章翻译并回传，
语义与站点完全一致（分段 1500 字/30 行、`#编号` 协议、术语表按命中行注入、行数不匹配重试、
expire/normal/all 档位、`oldGlossaryId === glossaryId` 跳过），并修复工作区的内存问题：
**译文上传后立刻释放章节文本**（浏览器工作区把每章原文+译文留在 Map 里是泄漏源头），
进度与段级缓存放 SQLite，任意中断可续。

## 前置

- Node ≥ 24（用内置 `node:sqlite`；实验性警告无害）；
- 一个 OpenAI 兼容的 LLM 端点（与工作区 GPT 翻译器同源即可）；
- 站点凭据：在站点页面点油猴模块「**同步 Daemon**」（推荐），或 `node daemon/index.mjs auth <token>`。

## 命令

```
node daemon/index.mjs add       <novel-url>        # 登记（/novel/{provider}/{id} 或 /wenku/{id}）
node daemon/index.mjs run       [--book key]       # 术语管线：提取→核实→回扫→直写/提案（含快照）
node daemon/index.mjs check     [--book key] [--codes A,B] [--limit N] [--propose] [--tsv]   # 质检：七码报告
node daemon/index.mjs rules     list|add|rm|enable|disable   # 文本处理链规则（pre/post 替换、保留段）
node daemon/index.mjs prompt    show|set|clear               # 提示词模板（prefix/base/thinking/suffix）
node daemon/index.mjs glossary-io import|export              # LG 术语表互通（JSON；写站点=快照+回读校验）
node daemon/index.mjs export-src --book key [--out file]     # 导出站点原文为 LG 可译纯文本（+对齐清单）
node daemon/index.mjs import-lg --book key --txt file --manifest file [--apply] [--limit N]   # LG 译文结果对齐导入（gpt 端）
node daemon/index.mjs agent     [--book key] [--message "..."] [--session id] [--auto]   # 本地助手（工具调用）
node daemon/index.mjs translate [--book key] [--level expire|normal|all] [--concurrency 2] [--max-chapters N]
node daemon/index.mjs watch     [--interval 30]    # 常驻：定期按 expire 档补翻
node daemon/index.mjs serve     [--port 7331]      # 控制台 /ui + 控制面 /status /runs /auth /run …（/run 单队列串行）
node daemon/index.mjs status
node daemon/index.mjs forget    <bookKey>
```

全局旗标（调度器，见下节）：`--max-in-flight N`、`--rpm N`、`--transport-retries N`、`--max-prompt-chars N`、`--strict-prompt`。

典型流程：`serve`（或 `watch`）常驻 → 浏览器点「同步 Daemon」推凭据与翻译器 → `add` 登记书 → `translate`。

## 控制台（设置 GUI）

`node daemon/index.mjs serve` 后打开 <http://127.0.0.1:7331/ui>。组织方式（LG 式）：

- **项目 = 登记的书**，是一级容器：任务派发、规则覆盖、助手会话都挂在项目下；
- 侧栏顶部「**当前项目**」切换器全站跟随（`通用` = 全局视角），选择持久化；顶栏显示当前项目；
- **项目**页：项目卡片（标题 / 来源 / 状态 / 已译章数 / 最近 run / 队列 / open 提案），操作 = 设为当前 / 派发任务 / 忘记；点卡片展开详情（进度明细、规则覆盖数、绑定会话可跳助手页）；URL 登记新项目也在此页；
- **任务**：派发 `translate / glossary / check`（档位、限章数、提案开关），书下拉默认当前项目；
- **规则**：pre/post 替换、保留段——列表 = 全局 + 当前项目条目（标注来源）；新增默认作用当前项目，「作用域」可切全局；
- **提示词**：**全局模板**（所有项目共用，LG 式）四槽编辑；按书覆盖仅 API/CLI 保留（高级用法，UI 不暴露）；
- **助手**：新会话自动挂当前项目；侧栏会话按项目分组（「通用」组收无书会话）；绑书会话的系统提示注入【当前项目】，工具的 book 参数缺省即此书；
- **设置**：全局设置（作用于所有项目）——六个区块：**翻译模型池**（端点增删改，key 只写不回显、留空 = 按 id 保持原值）／**助手/术语模型池**（独立端点与并发限流；清空 = 跟随翻译池）／**翻译池调度与限流**／**助手池调度与限流**／**助手参数**（审批模式、maxSteps、工具结果截断、上下文预算）／**站点与凭据**（origin + token 直填）。站点「同步 Daemon」推送仍会整表覆盖**翻译池**（最后写入者赢），但**不再覆盖**显式配置过的助手池；
- **状态**：当前项目概要 + llm 双池统计（并发峰值/冷却/重试）、用量、RSS 采样；
- **技能**：全局资源（`skills/` 目录，LG 式 SKILL.md 包），不随项目变化。

安全：跨域仅放行 `n.novelia.cc` 与 `127.0.0.1/localhost`（其它 Origin 的写请求与预检直接 403）；服务只监听 127.0.0.1。

### 托盘（Windows，零依赖）

不想留一个终端窗口时，双击 **`daemon\tray.vbs`**（或 `powershell -NoProfile -ExecutionPolicy Bypass -File daemon\tray.ps1`）：托盘区出现蓝色 **N** 图标，daemon 以隐藏进程跑在它手下，控制台照常 <http://127.0.0.1:7331/ui>。

- 菜单：**打开控制台**（双击图标同效）、**状态**（书数 / 已译章数 / 队列 / RSS 气泡）、**打开日志**（`daemon/.tray.log`）、**重启 daemon**、**退出**（一并停掉托盘拉起的 daemon）；
- 启动时若端口已有 daemon 在跑，托盘只接管显示（不持有进程，退出仅关托盘）；daemon 意外退出会弹气泡提醒；
- 日志：daemon 输出追加到 `daemon/.tray.log`（已被 `*.log` 忽略，需要时手动清）；
- 开机自启：`Win+R` → `shell:startup` → 放入 `tray.vbs` 的快捷方式；
- 实现是 PowerShell NotifyIcon（WinForms），无 npm 依赖、无编译步骤；测试口：`-TestSpawn`（拉起临时 db 的 daemon → 等就绪 → 杀掉）与 `-SmokeGui N`（只初始化托盘 GUI，N 秒后自退）。

## 调度与限流（默认单线程，适配 Gemini 逆向 / 单槽上游）

所有 LLM 调用都经 `daemon/scheduler.mjs`（规格 `docs/cleanroom/spec-06-llm-scheduler.md`），分**两个独立池**：

- **翻译池**（`config.workers` + `config.llm`）：翻译管线专用；油猴「同步 Daemon」推送与设置页编辑都写这里；
- **助手/术语池**（`config.agent.workers` + `config.agent.llm`）：助手 Agent 与术语管线用（工具调用模型），**独立的并发门/冷却/RPM，与翻译互不抢在途额度**；未显式配置时镜像翻译池，显式配置后油猴推送不再覆盖（设置页「清空」回到跟随模式）；

- **全局并发门**：`--max-in-flight N`（默认 1）——同刻最多 N 个在途请求、FIFO 排队；劈半重试、提取、核实同样受管；
- **接口池**：多 worker（同端点多 key）轮转；单 key 连续失败按 15s/30s/60s 阶梯冷却，成功清零；全部冷却时等待最早解冻者；
- **上游限流**：遵循 Retry-After / `retryAfterMs`（下限 1s、上限 300s）；传输层最多 `--transport-retries N`（默认 3）次，等待发生在并发额度之外；凭据类错误不重试；
- **RPM 节流**：`--rpm N`（默认 0 = 不限）；
- **上下文守卫**：`--max-prompt-chars N`（默认 12000，≈16K token 内）超限只告警；`--strict-prompt` 时直接失败、不发请求；
- **用量记账**：上游 `usage` 优先、缺失按字符估算；每轮 run 落 `usage` 表，`status` 汇总；
- 持久配置：`config.llm = { maxInFlight, rpm, transportRetries, maxPromptChars, strictPrompt }`（CLI 旗标优先）。

## Agent（本地助手，工具调用）

`node daemon/index.mjs agent`（缺 `--message` 进交互模式；`/stop` 中止当前轮、`/exit` 退出）。

- **模型要求**：OpenAI 兼容 Chat Completions 且支持 `tools/tool_calls`；走独立的**助手/术语池**（`config.agent.workers`，设置页直接配置），与翻译池（逆向 Gemini 单线程）互不抢并发；请求同样经调度器（并发门/冷却/限速/RPM 与用量记账）。
- **循环**：系统提示 + 历史 → 模型 → 顺序派发工具 → 回填 `role:'tool'` 结果 → 直到无工具调用；单轮步数上限 24（可配）、支持中止与失败续聊。
- **会话**：`agent_sessions/agent_messages/agent_decisions` 落 SQLite；时间线全量保留，超阈值时把旧段摘要化（`summaryUpTo` 之后才进模型）。`--session <id>` 续用上次会话。
- **项目绑定**：会话可绑书（控制台新会话挂「当前项目」；`POST /agent/session {bookKey}`、CLI `agent --book` 同效）；绑书会话每轮注入【当前项目】上下文——工具的 book 参数缺省即此书，操作其它书需用户明说；侧栏会话按项目分组，「通用」组收无书会话。
- **工作区（CodeAct，LG 同款）**：
  - `workspace_run {script}`：把模型写的 JS（ESM）丢进沙箱子进程跑——`fork` + `node --permission`（可读工作区、可写 `changes/` 与 `work/`，禁子进程/worker/原生扩展；网络可用；120s 超时 SIGKILL）。全局 `ws` 经 IPC 桥接：`ws.contract`（契约）、`ws.doing(text)`（进度直达助手页）、`ws.read({kind:'read', subkind:'chapter', chapterId})`（站点章节按需拉取，不落盘）。stdout/stderr 全量落 `work/runs/<id>/`，进模型上下文每流截 64KiB；返回 `{scriptPath, exitCode, signal, stdout, stderr}`；
  - 数据集快照（每次 run 重建）：`project_meta.json`、`progress/`、`rules/`、`glossary/`、`prompts.json`、`runs/`（JSONL 行内带 fp）+ `reference/workspace.md`；`changes/` 也在 run 前清空重置（LG 同款）；
  - `workspace_apply {}`（需审批）：提交 `changes/**.jsonl` 变更清单——解析 → fp 漂移/缺失/冲突检测 → 预览摘要（审批预览=实际提交差异）→ 逐 op 提交 → 回执 `{status: applied|partial|rejected|unchanged, applied, rejected, destroyed, results}`；`destroyed`（有漂移/缺失）或全量成功后清空清单；glossary 域合并后走"快照 → 全量替换 → 回读校验"；与翻译任务单队列互斥；
  - 变更域 v1：rules / glossary / prompts；章节译文提交不经过工作区（用 run_translate / import_lg_result）；
  - 目录：`daemon/work/<sessionId>/`（已 gitignore）；通用会话（未绑书）没有工作区。
- **审批**：默认 manual —— 标记 `requiresApproval` 的工具（写术语表/回滚/改规则与提示词等）会挂起为 decision，CLI 里 y/N 确认；`--auto` 跳过审批（等价 auto 模式）。追问（`ask_user`）同样是 decision。
- **工具（A1–A3）**：
  - 只读（自动）：`list_books`、`book_status`、`read_book`（按行窗口）、`read_translations`（对齐对窗口）、`list_proposals`、`list_snapshots`、`quality_report`、`list_skills`、`read_skill`、`export_glossary`、`export_lg_source`（站点原文 → LG 纯文本+清单）；
  - 执行（需审批）：`run_translate`（补翻并上传译文）、`run_glossary`（术语管线，可能直写）、`run_check`（只读质检，自动）；
  - 写入（需审批）：`glossary_apply`（快照+全量替换+回读校验）、`glossary_rollback`（回滚前自动再存快照）、`import_glossary`（LG JSON；regex 条目入本地规则且默认禁用）、`import_lg_result`（LG 译文结果导入 GPT 端，preview=完整校验报告）；`set_rule`/`delete_rule`、`set_prompt`；`close_proposal` 为本地状态、自动执行；
  - 交互：`doing`（进度）、`ask_user`（追问）。
- **单队列**：执行类工具与 `/run` 共用进程内 FIFO（同一时刻只跑一个 runBook），不会和浏览器/其它会话抢同一本书。
- **控制面新增**：`GET /snapshots`、`POST /snapshots/restore`、`POST /proposals/close`、`POST /proposals/apply`（人工/A4 GUI 用）。
- **技能**：`skills/` 下的 SKILL.md 包会作为目录注入系统提示，模型用 `read_skill` 读取正文与 `references/**`；现有 glossary-extract / acceptance-scan / text-preserve，工作流三件套 glossary-workflow / translation-workflow / quality-workflow，以及两个隐藏前置技能：`writing-guide`（写作准则：translation-guide / creative-guide 两份细则，被三个工作流声明为必读前置）与 `agent-charter`（任务宪章：虚构边界、角色成年、忠实叙事、首行锚定、禁语与稀释——系统提示要求任务开始前先加载）。隐藏技能不进可见目录，但 `read_skill` 可读、`@点名` 可用。
- **多实例/测试**：`--db <path>` 可指定另一个 SQLite（并行车道互不干扰）。

### 输入框指令（@技能 / 斜杠命令 / 会话系统指令）

- **`@技能名`**：消息任意位置可点名技能（可多个），该轮系统提示会注入技能正文（截 6000 字），无需再 read_skill；只认技能目录里存在的名字，未知名 → 400 并附清单（CLI 同样生效）；
- **`/命令`**（仅行首，UI 本地执行）：`/new [标题]`、`/stop`、`/auto [on|off]`、`/help`、`/tools`、`/skills`、`/translate <book> [level] [max]`、`/glossary <book>`、`/check <book> [propose]`（后三个直接入队，等价「任务」页）；未知命令本地提示；
- **会话系统指令**：助手页「系统指令」按钮 → 编辑并保存当前会话 → 每轮以「【用户系统指令】」注入系统提示（snapshot 带回）；
- 输入 `@` / 行首 `/` 有候选弹层（↑↓ 选择、Enter/Tab 补全、Esc 关闭）。

### 控制台「助手」页（A4）

`serve` 后打开 <http://127.0.0.1:7331/ui> → 「助手」标签：会话选择/新建、对话流（工具调用以卡片展示）、审批与追问面板（允许本次 / 拒绝 / 选项回答）、停止当前轮、审批模式开关、会话用量与连接状态。

- 事件流：`GET /agent/events?session=&since=`（SSE，带 revision 与 15s 心跳；前端断线自动降级为 1.5s 轮询）；
- 接口：`POST /agent/message|decision|stop|session`、`GET /agent/snapshot|sessions|config`（`POST /agent/config` 存默认审批模式）；
- 用同样的接口也可以接自己的前端（返回字段见实现或 `daemon-test.mjs` 的 A4 段）。

## 文本处理链（预处理 / 后处理）

- 规则存 SQLite `rules`（`kind ∈ text_preserve | pre_replacement | post_replacement`；`bookKey=''` 为全局，其余按书；`priority` 升序执行，支持 literal/regex 与大小写敏感）；
- 默认开关见 `daemon/presets/base.json`：资源占位符投影（URL/HTML 标签/`\N[..]` 等控制码）、标点稳定化（jp 句末 `！？` → 中文全角）、ruby 清洗默认关；
- 硬不变量：行数不变、占位符不得残留、还原失败该行回退原文；
- 处理链版本参与段缓存键：规则改动自动失效旧缓存；
- 管理：`node daemon/index.mjs rules add --kind post_replacement --pattern '【模拟译】' --replace '【译】' [--book key] [--regex] [--cs] [--priority N]`、`rules list|rm <id>|enable <id>|disable <id>`。

## 提示词模板

- 四槽 `prefix / base / thinking / suffix`（`prompts` 表，`bookKey=''` 为全局；按书覆盖全局）；
- `base` 必须包含 `{format_rules}`（协议段由代码注入，模板不可覆盖）；缺占位符或过短 → 自动回退默认并告警；
- 全槽位默认时渲染结果与站点镜像系统提示**逐字一致**（零行为变化）；`{source_language}`/`{target_language}` 可替换；
- `thinking` 非空时以「【思考指引】」追加到用户消息最前（协议行不受影响）；
- 管理：`node daemon/index.mjs prompt show [--book key]`、`prompt set --slot base --text '…{format_rules}'`（或 `--file`）、`prompt clear --slot base`。

## LG 术语表互通

```
node daemon/index.mjs glossary-io import <lg.json> --book <key>            # dry-run：只出 diff 报告
node daemon/index.mjs glossary-io import <lg.json> --book <key> --apply    # 快照 → 全量替换 → 回读校验
node daemon/index.mjs glossary-io export --book <key> [--out <lg.json>]    # 导出为 LG JSON
```

- 导入格式：LG 的 JSON 数组 `[{src,dst,info,regex,case_sensitive}]` 或 `{src: dst}` 映射；
- `regex: true` 条目 → `rules` 表（kind=pre_replacement，**默认禁用**，确认后 `rules enable <id>`）；`case_sensitive` 标记忽略（站点术语表为纯文本匹配）；
- 其余条目 = 术语表候选（值 = `dst #info`）；改原文/可疑条目默认跳过并计入报告，`--propose` 时进提案；
- `xlsx` 与 `.lg` 工程文件暂不支持（列为可选）。

## LG 译文对齐导入（用 LinguaGacha 翻整本书）

不想（或不能）用 daemon 内置翻译时，可以把站点原文导出成 LG 可翻译的纯文本，用 LinguaGacha 翻完再原样导回站点 GPT 端。行号对齐由「配对清单 + 三层校验」保证，错位直接拒绝提交：

```
node daemon/index.mjs export-src --book <key> [--out <file>]          # 导出纯文本 + <file>.manifest.json 对齐清单
#   → 把 txt 建成 LG 项目（一行一段，空行也占一行），翻完导出同格式 txt
node daemon/index.mjs import-lg --book <key> --txt <LG结果.txt> --manifest <清单.json>            # dry-run：逐章校验报告
node daemon/index.mjs import-lg --book <key> --txt <LG结果.txt> --manifest <清单.json> --apply    # 通过章提交站点 GPT 端
#   [--limit N] 本次最多提交 N 章；有翻译任务在跑时会被单队列拒绝
```

- **兼容前提**（来自 LG 源码）：LG 的 TXT 格式一行一条 item、空行也是条目、写出逐行 join（空译文回退原文）→ 结果 txt 的行数与行号和输入天然一致。因此**不要在 LG 里增删行、不要开启会改行数的处理**；
- **三层校验**：总行数 = 清单 `linesTotal`（否则全局拒绝）；每章行数 + 空/非空模式与站点当前 `paragraphJp` 一致（行错位检测）；每章原文 sha1 与导出时一致（源站更新/漂移 → 该章拒绝）；
- **疑似未翻**：结果行 === 原文行（非空）的行数会统计进报告（LG 空译文回退原文的特性），dry-run 里先看这个数再 `--apply`；
- **提交即 GPT 翻译器兼容**：逐章走站点既有 `POST .../translate-v2/gpt/chapter/{id}`（带当前 `glossaryId`、`sakuraVersion 0.9`、段落数严格一致），导入后站点与 daemon 都把该章视为已译；`--apply` 后可跑 `translate --level expire` 验证零目标；
- **Agent 工具**：`export_lg_source({book, out?})` 自动执行（写 `daemon/exports/`）；`import_lg_result({book, txtPath, manifestPath, apply, limit})` 需审批，preview 即完整校验报告；
- 边界：导入期间若站点原文更新（sha1 漂移）对应章自动跳过；文件读写仅限 `--out`/`exports/` 指定路径。

## 真机契约备忘（mock 已同步改严）

- `GET /api/novel/{p}/{id}/file` 必须带 `filename` 参数，缺了 404（`createFileUrl` 的 `filename` 无默认值）；
- web 版 `POST .../translate-v2/{t}/chapter-task/{ch}` 的 `sync` 查询参数必填（缺了 404；
  `sync=true` 仅站点「同步原文」档使用，翻译链路固定 `false`）；
- HTTPS 站点页面 fetch 本机 daemon 走 Chrome 本地网络访问（LNA/PNA）：daemon 已在 CORS 预检里回
  `Access-Control-Allow-Private-Network: true`；浏览器侧首次可能仍需在地址栏允许本站的本地网络权限。

## 与浏览器工作区的关系

- **不要同时用浏览器工作区与 daemon 跑同一本书**：daemon 有锁，但浏览器侧不感知；
- 上传契约与站点完全相同：带当前 `glossaryId`、段落数严格一致；术语表更新会让章节变成
  expire，下一次 `translate --level expire` 自动补翻；
- 失败语义：单章失败记入统计并继续（可在 `status` 的 runs 里看到）；401 → 整轮终止并提示重新同步凭据。

## 自愈与监控

- 60s 采样 RSS/heap 入库（留 7 天）；RSS > 500MB 干净退出；
- `uncaughtException/unhandledRejection` → 记日志后 `exit(0)`，交给外部看门狗拉起（Windows 任务计划程序，
  或在 `watch` 模式下由你自行守护；所有状态在 SQLite，重启即续）。

## 测试

```
PORT=8790 node mock-llm/server.mjs     # mock（翻译用例：POST translate-v2 + 翻译提示词分支）
node daemon/translate-test.mjs          # 纯函数单测（分段/提示词/解析/重试/二分）
node daemon/quality-test.mjs            # 质检纯函数单测（七码 + 批量报告；无需 mock）
node daemon/processors-test.mjs         # 处理链单测（占位符/保留段/替换表/标点；无需 mock）
node daemon/prompt-test.mjs             # 提示词模板单测（默认逐字一致/回退/槽位；无需 mock）
node daemon/glossary-io-test.mjs        # LG 互通单测（解析/分流/往返；无需 mock）
node daemon/lg-align-test.mjs           # LG 译文对齐单测（导出行映射/解析容忍/三层校验；无需 mock）
node daemon/agent-test.mjs              # Agent 单测（参数解析/裁剪/会话/压缩/决策/循环；无需 mock）
node daemon/agent-skills-test.mjs       # 技能目录单测（frontmatter/发现/读取/逃逸；无需 mock）
MOCK_ORIGIN=http://127.0.0.1:8790 node daemon/daemon-test.mjs   # 冒烟：全管线/跳过/续跑/控制面/调度器/质检/处理链/模板/互通/助手/设置页双池/LG导入
powershell -File daemon/tray.ps1 -TestSpawn -Port 7377          # 托盘冒烟：拉起(临时db)→等就绪→杀掉；-SmokeGui N 只验 GUI 初始化
# 助手页 e2e（浏览器车道）：mock 在 8790，daemon 在 7355（--db daemon/.tmp-agent-ui.db），见 tools/.e2e-agent-ui.js 头部跑法
```
