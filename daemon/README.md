# daemon —— GPT 翻译 worker（站点工作区兼容）

> 架构与设计决策总览见 [`docs/architecture.md`](../docs/architecture.md)（组件图/数据模型/子系统/ADR/测试矩阵）。

本地常驻进程：用 Node 替代 auto-novel「GPT 工作区」的浏览器 worker——逐章翻译并回传，
语义与站点完全一致（分段 1500 字/30 行、`#编号` 协议、术语表按命中行注入、行数不匹配重试、
expire/normal/all 档位、`oldGlossaryId === glossaryId` 跳过），并修复工作区的内存问题：
**译文上传后立刻释放章节文本**（浏览器工作区把每章原文+译文留在 Map 里是泄漏源头），
进度与段级缓存放 SQLite，任意中断可续。

## 前置

- Node ≥ 24（用内置 `node:sqlite`；实验性警告无害）；
- 一个 OpenAI 兼容的 LLM 端点（与工作区 GPT 翻译器同源即可）；
- 站点凭据：在站点页面点油猴模块「**Daemon 连接**」（推荐），或 `node daemon/index.mjs auth <token>`。站点 2026-10 起会话键是 `web-kit:session:v1`（旧 `auth-v2` 只作回落），油猴侧按 `web-kit:session:v1` → `auth-v2` → `auth` 顺序取——读到的是哪个键，控制台站点自检与提示里会写出来（见 `docs/upstream-sync.md` ①）。

## 命令

```
node daemon/index.mjs add       <novel-url>        # 登记（/novel/{provider}/{id} 或 /wenku/{id}）
node daemon/index.mjs run       [--book key]       # 术语管线：提取→核实→回扫→直写/提案（含快照）
node daemon/index.mjs check     [--book key] [--codes A,B] [--limit N] [--propose] [--tsv]   # 质检：七码报告（v2 对齐 LG；结果落 warnings 表）
node daemon/index.mjs rules     list|add|rm|enable|disable   # 文本处理链规则（pre/post 替换、保留段）
node daemon/index.mjs prompt    show|set|clear               # 提示词模板（prefix/base/thinking/suffix）
node daemon/index.mjs glossary-io import|export              # LG 术语表互通（JSON；写站点=快照+回读校验）
node daemon/index.mjs export-src --book key [--out file]     # 导出站点原文为 LG 可译纯文本（+对齐清单）
node daemon/index.mjs import-lg --book key --txt file --manifest file [--apply] [--limit N]   # LG 译文结果对齐导入（gpt 端）
node daemon/index.mjs agent     [--book key] [--message "..."] [--session id] [--auto]   # 本地助手（工具调用）
node daemon/index.mjs translate [--book key] [--level expire|normal|all] [--concurrency 2] [--max-chapters N]
node daemon/index.mjs watch     [--interval 30]    # 常驻：定期按 expire 档补翻
node daemon/index.mjs serve     [--port N]        # 控制台 /ui + 控制面；端口 = 旗标 > config.serve.port > 7331，实际端口写 daemon/.serve-port
node daemon/index.mjs status
node daemon/index.mjs forget    <bookKey>
```

全局旗标（调度器，见下节）：`--max-in-flight N`、`--rpm N`、`--transport-retries N`、`--max-prompt-chars N`、`--strict-prompt`。

典型流程：`serve`（或 `watch`）常驻 → 浏览器点「Daemon 连接」推凭据与翻译器 → `add` 登记书 → `translate`。

### 连接（端口 / 探测 / 同步来源）
- **端口**：设置页「连接」区改默认端口（**重启生效**）；托盘 `tray.ps1` 默认不传 `--port`（自读 config），`Wait-Ready` 跟随 `.serve-port`；显式 `-Port N` 仍可覆盖；
- **`GET /ping`**：无需凭据，返回 `{ ok, name, port, version }`——油猴角标与外部脚本探测用（带 CORS，走同一白名单）；
- **同步来源**：`POST /auth` 记录 `lastSync { at, origin, UA 摘要, workersCount, mode: auto|manual }`（只记元数据不记 token）→ `/status` 与设置页「连接」区可见（自动/手动）——多浏览器推送时一眼分辨是谁在生效；**油猴「Daemon 连接」开启「自动同步」（默认开）后**：页面加载即自动推送，站内 token 刷新后 ≤5s 自动重推（指纹去重，无变化零请求），不再需要手动点；daemon 报 401（need-auth）时页面开着即可自愈；
- **从站点同步（控制台按钮）**：设置页「站点与凭据」的「从站点同步」→ `POST /auth/request` 置一条同步请求（5 分钟过期）→ 油猴在 ≤5s 的 daemon 探测里从 `/ping.pendingAuth` 看到标志，**绕过指纹去重**立即推一次凭据 → daemon 收到 `/auth` 清位；按钮会在 35s 内等推送到达并回报结果（前提：站点页面开着且已登录——token 只在站点页面 localStorage 里；**日常浏览器里的用户脚本也要更新到含此功能的版本并刷新页面**，测试 profile 里装的不算）；
- **跨域白名单**：内置默认 `n.novelia.cc` + `127.0.0.1/localhost`（不可移除）；设置页「连接」区可加附加条目（hostname 或 origin，即时生效）。

## 控制台（设置 GUI）

`node daemon/index.mjs serve` 后打开 <http://127.0.0.1:7331/ui>。组织方式（LG 式）：

- 外观：**Windows 经典（PB/VB 年代）+ 扁平直角**——**灰打底**：工作区、侧栏、分组框、表格都是 `#c0c0c0`，字段白底（对话区是一块白底"文档窗口"浮在灰工作区上），1px `#808080` 描边、零圆角；**经典蓝只做点缀**：窗口标题栏与侧栏页眉用 VB6/Office97 蓝渐变 `#0a246a → #a6caf0`，悬停/选中藏青 `#000080` + 白字（导航、会话行、表格行浅蓝 `#d6e2f5`），主按钮与输入焦点藏青，经典提示条 `#ffffe1`。图标用系统自带的 Segoe MDL2 Assets 单色字形；经典体系只有浅色，**没有深色主题**；字体 Tahoma + Microsoft YaHei UI。滚动条两侧对称预留（`scrollbar-gutter: stable both-edges`）：助手页的消息列与输入框、以及各页的 980px 内容列都不会因滚动条出现而横移（否则右边会多出半条滚动条的空白）。

- **项目 = 登记的书**，是一级容器：任务派发、规则覆盖、助手会话都挂在项目下；
- 侧栏顶部「**当前项目**」切换器全站跟随（`通用` = 全局视角），选择持久化；顶栏显示当前项目；
- **项目**页：项目卡片（标题 / 来源 / 状态 / 已译章数 / 最近 run / 队列 / open 提案），操作 = 设为当前 / 派发任务 / **导出 LG 源文** / **导入 LG 译文** / 忘记；点卡片展开详情（进度明细、规则覆盖数、绑定会话可跳助手页）；URL 登记新项目也在此页；
  - **导出 LG 源文**：逐章取原文写成纯文本 + 对齐清单（落 `daemon/exports/`，路径显示在卡片里；交给 LinguaGacha 建项目翻译，保持行数）；
  - **导入 LG 译文**：选 LG 导出的结果 txt（清单默认用本会话导出时那份，可另选覆盖）→「校验」逐章核对（行数/空行模式/源 sha1；卡片里直接看到 ✓/✗ 报告与「疑似未翻」行数）→「提交通过章」（可限 N 章）入队 `lg-import`，进度看任务页；上传的副本存 `daemon/uploads/`（可手动清）。与 CLI 的 `export-src`/`import-lg` 是同一套函数，行为完全一致；**站点简介页「下载原文」经 LG 翻译的整本 txt 也能直接选**（自动识别 `mode=jp` 导出格式并抓站点原文对齐，报告里会标注「↻ 已识别站点导出格式」）；
- **任务**：派发 `translate / glossary / check`（档位、限章数、提案开关），书下拉默认当前项目；
- **规则**：pre/post 替换、保留段——列表 = 全局 + 当前项目条目（标注来源）；新增默认作用当前项目，「作用域」可切全局；
- **提示词**：**全局模板**（所有项目共用，LG 式）四槽编辑；按书覆盖仅 API/CLI 保留（高级用法，UI 不暴露）；
- **助手**：新会话自动挂当前项目；侧栏会话按项目分组（「通用」组收无书会话）；绑书会话的系统提示注入【当前项目】，工具的 book 参数缺省即此书；对话区支持 markdown 渲染（代码块带语言标签与复制按钮）、每条消息的时间/token、工具调用折叠卡（状态点 + 参数/结果分区）、审批面板结构化预览、生成中光标与步数、智能跟随滚动 +「回到底部」、空态建议提示；窄窗口下侧栏自动收成图标条；
- **会话操作**：消息悬停可「复制」「编辑」（用户消息 → 内联编辑器「保存并重发/取消」）与「重新生成」（仅末条助手消息，丢弃该轮回答后以原文重跑，用户消息保留）；顶栏与侧栏会话行可「重命名 / 删除」（删除连带该会话的消息与审批记录；跑轮次中会被拒绝）。语义：编辑/重新生成都按截断点重跑（删除 seq ≥ 截断点的消息），若历史摘要跨过截断点则整段清掉（摘要由模型生成，无法重算）；
- **设置**：全局设置（作用于所有项目）——八个区块：**连接**（端口 / 跨域白名单附加条目 / 上次同步来源）／**翻译模型池**（端点增删改，key 只写不回显、留空 = 按 id 保持原值）／**助手/术语模型池**（独立端点与并发限流；清空 = 跟随翻译池）／**翻译池调度与限流**／**助手池调度与限流**／**助手参数**（审批模式、maxSteps、工具结果截断、上下文预算）／**站点与凭据**（origin + 「从站点同步」按钮 + token 直填 + **站点请求重试次数** 0–8）／**网络代理**（出网代理开关 / 地址 / 直连列表 / 直连-代理对比测试）。站点「Daemon 连接」推送仍会整表覆盖**翻译池**（最后写入者赢），但**不再覆盖**显式配置过的助手池；
- **状态**：当前项目概要 + llm 双池统计（并发峰值/冷却/重试）、用量、RSS 采样；
- **技能**：全局资源（`skills/` 目录，LG 式 SKILL.md 包），不随项目变化。

安全：跨域仅放行 `n.novelia.cc` 与 `127.0.0.1/localhost`（其它 Origin 的写请求与预检直接 403）；服务只监听 127.0.0.1。

### 启动 / 托盘（Windows，零依赖，全 PowerShell）

**一键入口**（双击即用，无 vbs）：

- 仓库根 **`daemon.cmd`**：双击 = 启动（端口没有 daemon 就拉起托盘并等就绪，然后打开控制台；已在跑则只打开控制台）；也支持 `daemon.cmd restart|stop|status|console [端口]`——`restart` 按端口定位进程后重启（用于换新代码），`status` 打印书数/已译/队列与网络代理状态；
- **`daemon\tray.cmd`**：只要托盘（静默，无窗口），可选端口参数 `tray.cmd 7331`。
- **托盘唯一（不叠加）**：`start` 只在没有托盘时拉起（daemon 没跑但有残留托盘时，先清掉再拉一个，保证最后一个托盘一定管着新 daemon）；`restart` 先清旧托盘再换新 daemon；`stop` 连托盘一起收。所以反复 `daemon.cmd restart` 不会出现「托盘里两个 7331 实例」。

实现都是 PowerShell：`daemon/launch.ps1`（启动/重启/停止/状态）+ `daemon/tray.ps1`（托盘本体）。不想留终端窗口时用它们；托盘区出现蓝色 **N** 图标，daemon 以隐藏进程跑在它手下，控制台照常 <http://127.0.0.1:7331/ui>。

- 菜单：**打开控制台**（双击图标同效）、**状态**（书数 / 已译章数 / 队列 / RSS 气泡）、**打开日志**（`daemon/.tray-<端口>.log`）、**重启 daemon**、**退出**（一并停掉托盘拉起的 daemon）；
- 启动时若端口已有 daemon 在跑，托盘只接管显示（不持有进程，退出仅关托盘）；daemon 意外退出会弹气泡提醒；
- 端口：默认跟随 `config.serve.port`（读 `daemon/.serve-port`）；`-Port N` 显式传参可覆盖；
- 日志：daemon 输出追加到 `daemon/.tray-<端口>.log`（按端口分文件——cmd 的 `>>` 会独占文件句柄，共用一份会让「另一个端口」的实例起不来；已被 `*.log` 忽略，需要时手动清）；
- 开机自启：`Win+R` → `shell:startup` → 放入 **`daemon\tray.cmd`** 的快捷方式；
- 实现是 PowerShell NotifyIcon（WinForms），无 npm 依赖、无编译步骤；测试口：`-TestSpawn`（拉起临时 db 的 daemon → 等就绪 → 杀掉）与 `-SmokeGui N`（只初始化托盘 GUI，N 秒后自退）。

## 网络代理（出网）

站点 `n.novelia.cc` 在墙内需要代理才能访问；daemon 的出网（站点 API、翻译池、助手/术语池）与控制台设置页「**网络代理**」区块共用一份配置：

- **配置形状**：`config.proxy = { enabled, url, noProxy }`——`url` 只支持 `http://` / `https://`（可带 `user:pass@` 凭据），**不支持 SOCKS5**；`noProxy` 是逗号分隔的直连列表（默认 `127.0.0.1,localhost,::1`，也可写域名，命中本域与其子域）；
- **保存即生效**：不重启 daemon（每次请求现读配置；这也是没有用 Node 内置 `NODE_USE_ENV_PROXY` 的原因——内置开关只在进程启动前解析环境变量且首值终身缓存）；
- **对比测试**：设置页「测试（对比直连 / 代理）」按当前填写的值各探测一次站点 origin（各 8s 超时），直接看到「直连失败 / 代理成功」——也可直接调 `POST /proxy/test { proxy, targetUrl? }`；
- **工作区脚本**：`workspace_run` 的沙箱子进程在 fork 时注入 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY/NODE_USE_ENV_PROXY`，模型脚本自己的 fetch 与 daemon 走同一代理（代理关闭时不注入，保持原样）；
- **不影响本机**：直连列表默认含回环地址，mock（8788/8790）、托盘 `/status`、控制台自身流量都不经代理；代理关闭时全部直连，行为与旧版一致；
- **传输层重试**：站点请求（`SiteClient`）对网络层失败默认重试 3 次（退避 300ms×n），CLI 打「站点请求失败，重试 n/3」；HTTP 状态错误（401/404/…）不重试。次数在控制台设置页「站点与凭据 → 站点请求重试」可调（0–8，保存即生效）——墙内代理链路抖动（`ECONNRESET` / `fetch failed`）很常见：实测整本 167 章逐章抓取约 1/3 请求首发失败，3 次重试每轮仍有 2 章左右失败，调到 8 次基本清零；
- **curl 兜底（默认开）**：实测**个别站点对 Node/undici 的指纹会稳定 ECONNRESET**（`n.novelia.cc` 经 Clash 6789：undici 连打 8 次全失败、同代理 curl 成功率约 85%，`/proxy/test` 的直连/代理两列都红），重试到顶也过不去。开启后：传输层失败（`ECONNRESET` / `fetch failed` / 超时等，`isTransportError` 判定；HTTP 状态错误与调用方主动 abort 不触发）时，用 **curl 子进程**把同一个请求重发一次（`-L` 跟 302、`--retry`、`--max-time`、走同一代理/直连判定、`signal` 中止会 kill 子进程），日志打「回落 curl 传输（经代理 …）」；curl 不存在或也失败时保持原错误。开关在「网络代理」区块（`config.proxy.curlFallback`，默认开），`POST /proxy/test` 返回值带 `curlFallback` / `curlAvailable`。实现用**异步 spawn**（同步 `spawnSync` 会阻塞事件循环 → daemon 自己的 HTTP 服务与同进程测试假服务器都收不到请求）；
- CLI（`translate` / `run` / `check` / `agent` / `status`）读同一份配置，`status` 会打印当前代理状态。

## 调度与限流（默认单线程，适配 Gemini 逆向 / 单槽上游）

所有 LLM 调用都经 `daemon/scheduler.mjs`（规格 `docs/cleanroom/spec-06-llm-scheduler.md`），分**两个独立池**：

- **翻译池**（`config.workers` + `config.llm`）：翻译管线专用；油猴「Daemon 连接」推送与设置页编辑都写这里；
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
  - 只读（自动）：`list_books`、`book_status`、`read_book`（按行窗口）、`read_translations`（对齐对窗口）、`list_proposals`、`list_snapshots`、`quality_report`、`list_warnings`（读落库的质检警告：摘要+明细+证据）、`list_skills`、`read_skill`、`export_glossary`、`export_lg_source`（站点原文 → LG 纯文本+清单）；
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
- **内置保护预设**（对齐 LG `builtin/text_preserve/preset`）：`base`（`<br>` 等）恒用；`kag` / `renpy` / `rpgmaker` / `wolf` 层在控制台「规则」页切换（`config.textPreserve.preset`，`none` 关闭全部）；预设条目内置只读、不占 rules 表，与用户 `text_preserve` 规则按 pattern 合并（用户优先）；空白符/URI 两项仅参与质检比对（checkOnly），不进预处理链；
- 管理：`node daemon/index.mjs rules add --kind post_replacement --pattern '【模拟译】' --replace '【译】' [--book key] [--regex] [--cs] [--priority N]`、`rules list|rm <id>|enable <id>|disable <id>`。

## 质检（check）

- **七码**（规格 `docs/cleanroom/spec-07`，v2 对齐 LinguaGacha）：`FOREIGN_CHAR_RESIDUE`（字素分割+书写系统分类，输出片段证据；短大写缩写豁免）/ `SIMILARITY`（原始文本包含或字符集 Jaccard > 0.8；JA→ZH 需残留证据护栏）/ `LINE_COUNT_MISMATCH` / `GLOSSARY`（术语未落地，scanAcceptance 语义）/ `TEXT_PRESERVE`（保留段实装：按**内置保护预设 + 用户规则**提取两侧片段逐位比对，带证据；空白片段按 LG 语义过滤）/ `PUNCTUATION_MISMATCH`（标点组序列，顺序敏感）/ `RETRY_THRESHOLD`（章级重试 ≥2，纯提示）；
- **运行**：`check` 任务（CLI / 任务页 / `/run job=check`）、agent `run_check`·`quality_report`；全部确定性启发式、无 LLM、不写站点（`--propose` 仅把样例转提案，`--tsv` 导表）；
- **警告落库**：每次 check **全量替换**该书 `warnings` 表（章节/行号/码/细节/证据 JSON）；消费面：`GET /warnings?book=&code=&limit=`、agent 只读工具 `list_warnings`、工作区数据集 `warnings/entries.jsonl`、控制台项目详情（按码计数 + 前 20 条）。

## 翻译上下文（相邻段参考；默认关闭）

- 开启后，每个段的请求会在正文 `#n:` 块**之前**多带两块：`【参考上文】（只用于理解语境，不要翻译，也不要出现在输出里）：` 与 `【参考下文】（同上）：`；system 提示一字不动（系统指令不随上下文变化）。
- **上文**语义镜像 LinguaGacha v0.125.0 的 `preceding_lines_threshold`（`planning/translation-planner.ts:21,265-293` 的「句末标点门槛」）：从上一段末尾往前收**以句末标点结尾的连续行**（`. 。 ? ？ ! ！ … ' " 」 』`），遇到不达标的行就停——所以有时一行都不带；可跨段回溯（最多 N 行）。
- **下文**（LG 没有的方向）对称设计：从下一段开头往后收，**收到句末标点为止（含该行）**——因此正文行普遍以句末标点结尾时通常正好 1 行。
- 行数与开关：控制台「设置 → 翻译上下文」（`config.translate.contextBefore/contextAfter`，0–20，0 = 关闭，保存后下一轮生效）；CLI `translate --context-before N --context-after N`（不给旗标则用 config）；`/run` 的 `options` 可单次覆盖。**默认 0 = 与旧行为逐字一致**（`translate-test` 钉死）。
- 成本与缓存：上下文计入「提示词上限」（`maxPromptChars`，默认 12000）——触上限就调大上限或减行数；**段缓存键在上下文非空时追加上下文分量**，所以「关闭 → 打开」这类变化会让已缓存的段重译一次（之后同设置命中），「打开 → 关闭」则旧键仍命中（零缓存流失）。日志打 `段 i/n：参考上文 X 行 / 下文 Y 行`（不打印原文）。
- 与 LG 的两处刻意偏离：① 双向（LG 只有上文）；② **补发重试（③ 条目级）也带上下文**（LG 重试丢上下文）。
- 只影响 daemon 自己发出的请求；站点页面里那个浏览器 worker 的请求仍由站点代码拼装（不带上下文）。

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
- **也吃站点「下载原文」格式**：站点简介页「下载原文」拿到的是 `mode=jp` 整本导出（书名/作者/标签/统计 → `############` → 简介，之后每章 = `# 标题` + 空行 + 正文；**2026-10 起标题前另有两个空行**，旧版没有——两种都能对齐），LG 翻完仍是同格式。控制台「导入 LG 译文」/CLI `import-lg` 会在**行数不符且文本像站点导出**时自动抓站点原文、逐章 sha1 对齐（块作用域前向扫描定位原文块，标题前空行数 0/1/2 与卷/分组标题块都能吸收；逐段空/非空模式校验；任一章对不上即拒绝），校验报告会显示「↻ 已识别站点导出格式（mode=jp），并抓站点原文逐章 sha1 对齐 N 章」，队列 stats 带 `converted`。抓整本原文是一次 2MB 级请求，代理链路抖动时会分轮重试，全轮失败会把原因写进错误（「…（站点格式自动对齐失败：fetch failed——代理链路抖动时稍后重跑）」）；契约格式路径零额外请求。离线转换/排查用 `node tools/.lg-import-sitefmt.mjs --book <key> --zh <LG译文.txt> --manifest <清单.json>`（同一内核）；
  - **缺译标记章**：部分翻译的站点导出里，未译章写成一行标记（web：`GPT翻译缺失。`/`百度|有道|Sakura翻译缺失。`，丢章 `该章节缺失。`；文库：`// 该分段翻译缺失。`）。识别后按清单 `count` 展开空行，校验时判「该章没有译文…跳过上传」——已译章照常导入，不再整本被拒；正文里正常出现的「…翻译缺失。」文本不会误判；
  - **文库不走这条路**：站点对文库禁用 `mode=jp`、下载逐卷且导出无标题块结构（章序还是 `sorted()`）——命中站点格式时**不发请求**，直接提示改用本工具「导出原文」的契约格式 txt；文库的导入路径就是契约格式；
- **也吃「折叠空行版」站点格式**：有些来路的站点导出译文把**连续空行折成了单个空行**（行数与站点原文不同构，严格模式按绝对行号切片必然错位，整本被拒）。现在严格模式失败后**自动回落「块序 + 非空行映射」**：原文块仍按标题后 `count` 行 sha1 硬定位（块内锚定，卷/分组标题不越界），译文块按块序号取，要求两侧非空行数一致，再把译文非空行按序铺回原文段落数组（空段落原位回填空串）；硬校验不打折（块数一致 / 逐章原文 sha1 / 逐章非空行数一致 / 重建行数 == 清单行数），任一章不过即整体拒绝。报告标注 `convertMode`（`strict` / `loose`）与「已识别站点导出格式（折叠空行版）：按块序 + 非空行映射对齐 N 章」；
- **提交后回读校验**（控制台项目卡「回读校验」按钮 / 队列 `lg-readback`）：把站点**已提交**的整本译文拉回来（`/file?mode=zh&translations=gpt`，11MB 级一次请求）与本地 txt 逐章比对非空行——本地侧支持契约格式（按清单 `start/count` 切片）与站点导出格式（按 `# 标题` 块序）；站点侧章节块按序对应清单章节（缺清单则抓 TOC），两侧章节数不符即拒绝。报告给「N/M 章一致」+ 不一致章的首差行（本地 ↔ 站点片段）+ 站点侧假名残留行数，结果落 `runs(job='lg-readback')`；站点标题与本地译名不同译法也能对上（这就是不按标题比对的原因）；
- **断点续跑 + 401 监测**：逐章提交成功后把「章 id + 译文内容 sha」写进 `chunks`（`lg-import-state`，`forgetBook` 会清），**重跑自动跳过内容一致的已完成章**（内容变了 sha 变 → 自然重传，自愈），进度显示「断点跳过 N 章」，回读面板/项目详情显示「断点：已提交 N 章」（`GET /lg/import-state`）。401 不再被逐章 catch 吞成「章节获取失败」：先原地退避重试 2 次（8s，覆盖会话抖动），仍 401 则**中止本批**、置 `book.state='need-auth'`、**自动置 `authRequest`**（等于帮你点了「从站点同步」，站点页面开着时油猴 ≤5s 重推新 token）、进度打 `phase:'need-auth'`、run 记 failed（`stats.needAuth`）；控制台项目卡显示红色「凭据失效」+「重新同步凭据」，导入面板给出「继续提交（跳过已完成章）」按钮，任务页队列行直接显示 `progress.message`；
- **三层校验**：总行数 = 清单 `linesTotal`（否则全局拒绝）；每章行数 + 空/非空模式与站点当前 `paragraphJp` 一致（行错位检测）；每章原文 sha1 与导出时一致（源站更新/漂移 → 该章拒绝）；
- **疑似未翻**：结果行 === 原文行（非空）的行数会统计进报告（LG 空译文回退原文的特性），dry-run 里先看这个数再 `--apply`；
- **提交即 GPT 翻译器兼容**：逐章走站点既有 `POST .../translate-v2/gpt/chapter/{id}`（带当前 `glossaryId`、`sakuraVersion 0.9`、段落数严格一致），导入后站点与 daemon 都把该章视为已译；`--apply` 后可跑 `translate --level expire` 验证零目标；
- **Agent 工具**：`export_lg_source({book, out?})` 自动执行（写 `daemon/exports/`）；`import_lg_result({book, txtPath, manifestPath, apply, limit})` 需审批，preview 即完整校验报告；
- **站点下载的原文经 LG 翻译（另一种常见来路）**：站点简介页「下载原文」拿到的是 `mode=jp` 整本导出（书名/作者/标签/统计 → `############` → 简介，之后每章 = `# 标题` + 空行 + 正文），LG 翻完是**同格式**译文——它不是 `export-src` 的「一行一段」契约，先用 `node tools/.lg-import-sitefmt.mjs --book <key> --zh <LG译文.txt> --manifest <export-src 清单>` 转成契约格式（逐章 sha1 + 空/非空模式硬校验，任一章不过就拒绝写出），再走上面的 `import-lg`；
- 边界：导入期间若站点原文更新（sha1 漂移）对应章自动跳过；文件读写仅限 `--out`/`exports/` 指定路径。

## 真机契约备忘（mock 已同步改严）

- `GET /api/novel/{p}/{id}/file` 必须带 `filename` 参数，缺了 404（`createFileUrl` 的 `filename` 无默认值）；
- `/file` 的 `mode=jp` 是站点「下载原文」整本导出（头部 → `############` → 每章 `# 标题` + 空行 + 正文，章块间 3 空行、卷/分组标题各占两行；**2026-10 起标题前另有两个空行**）——LG 译文自动对齐靠它，见「LG 译文对齐导入」段；**文库没有整本原文导出**（`mode=jp` 被服务端拒绝、下载逐卷 `/api/wenku/{id}/file/{volumeId}`）；
- 文库 `POST .../translate-v2/{t}` 只返回 `{glossaryId, toc:[{chapterId, glossaryId?}]}`（无 `glossaryUuid`/`glossary`/标题）——`SiteClient` 已把 toc 项的 `glossaryId` 归一成 `glossaryUuid`、书级 `glossaryId` 作为当前版本，`normal`/`expire` 档在文库上才有意义；
- 术语表 `PUT .../glossary` 是整表替换：**内容没变时上游主动返 400**（web `修改为空` / 文库 `术语表没有改变`）——`SiteClient` 按幂等成功处理，其它 400 照旧报错；
- 401 有两义：带 `WWW-Authenticate: Bearer error="invalid_token"` = 凭据失效（`code='unauthorized'`，触发 need-auth 自愈）；无该头 = 封禁/权限不足（`code='forbidden'`，不触发 need-auth、不重试）。术语表写入需 member 且注册满 30 天；
- web 版 `POST .../translate-v2/{t}/chapter-task/{ch}` 的 `sync` 查询参数必填（缺了 404；
  `sync=true` 仅站点「同步原文」档使用，翻译链路固定 `false`）；
- HTTPS 站点页面 fetch 本机 daemon 走 Chrome 本地网络访问（LNA/PNA）：daemon 已在 CORS 预检里回
  `Access-Control-Allow-Private-Network: true`；浏览器侧首次可能仍需在地址栏允许本站的本地网络权限；
- 站点被墙（墙内直连不上 n.novelia.cc）时：先在控制台设置页「网络代理」填本机代理（如 `http://127.0.0.1:6789`）并点「测试」确认代理侧通、再跑翻译。

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
node daemon/proxy-test.mjs              # 出网代理单测（配置/直连匹配/绝对形式+CONNECT 回环集成；无需 mock）
node daemon/agent-test.mjs              # Agent 单测（参数解析/裁剪/会话/压缩/决策/循环/截断重跑；无需 mock）
node daemon/agent-skills-test.mjs       # 技能目录单测（frontmatter/发现/读取/逃逸；无需 mock）
MOCK_ORIGIN=http://127.0.0.1:8790 node daemon/daemon-test.mjs   # 冒烟：全管线/跳过/续跑/控制面/调度器/质检/处理链/模板/互通/助手/设置页双池/LG导入
powershell -File daemon/tray.ps1 -TestSpawn -Port 7377          # 托盘冒烟：拉起(临时db)→等就绪→杀掉；-SmokeGui N 只验 GUI 初始化
# 助手页 e2e（浏览器车道）：mock 在 8790，daemon 在 7355（--db daemon/.tmp-agent-ui.db），见 tools/.e2e-agent-ui.js 头部跑法
# 助手页会话操作 e2e：mock 在 8790，daemon 在 7358（--db daemon/.tmp-agent-ops.db），见 tools/.e2e-agent-session-ops.js 头部
# LG 导入 GUI e2e：mock 在 8790，daemon 在 7356（--db daemon/.tmp-lggui.db，预置 mock-trans-lg4-* 书），见 tools/.e2e-lg-gui.js 头部
#   一把跑完（契约格式 + 站点 mode=jp 格式自动对齐 + 回读校验三段）：CDP_PORT=9335 node tools/cdp.mjs open http://127.0.0.1:7356/ui && node tools/cdp.mjs evalf tools/.e2e-lg-gui.js
#   真机分阶段（长流程）：window.__LG_GUI_TEST={bookKey,txtPath,expect,limit} + phase=export/open/setfiles/verify-start/verify/apply/await/readback-open/readback，
#   文件用 CDP 原生塞盘上的真实 txt：node tools/cdp.mjs setfiles "#books-table .proj-card .proj-detail input[type=file]" "<LG译文.txt>"
# Daemon 连接 e2e：mock 8790 + tools/.run-daemon-stub.mjs（7343：/ping /auth /last /request-auth /reset），见 tools/.e2e-daemon-sync.js 头部
# 控制台「从站点同步」按钮 e2e：daemon 7359（--db daemon/.tmp-token-sync.db），见 tools/.e2e-token-sync.js 头部
```
