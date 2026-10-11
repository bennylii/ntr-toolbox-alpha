# Changelog

All notable changes 按版本记录；版本号跟随油猴脚本 `@version`。

## 未发布（v0.8.0-alpha.3-dev）

自 v0.8.0-alpha.2 之后的增量（均已合入 main，未打 tag）：

### daemon

- **站点请求重试次数可调**：控制台设置页「站点与凭据 → 站点请求重试」0–8（`config.site.retries`，默认 3，保存即生效）；实测整本 167 章逐章抓取时约 1/3 请求首发失败、3 次重试每轮仍剩 2 章左右，调到 8 次基本清零。
- **LG 译文导入支持站点「下载原文」格式（mode=jp）**：站点简介页下载的整本 txt（书名/作者/标签/统计 → `############` → 简介，之后每章 `# 标题` + 空行 + 正文）经 LinguaGacha 翻译后仍是同格式，以前会被「行数不符」拒绝。现在 `/lg/verify`、`lg-import` 队列 runner、CLI `import-lg` 与 Agent 工具 `import_lg_result` 会在「行数不符且文本像站点导出」时**自动抓站点原文逐章 sha1 对齐**（卷/分组标题占两行的 ±2 偏移窗口、逐段空/非空模式校验；任一章对不上即拒绝，绝不输出错位数据），契约格式路径零额外请求；抓原文是 2MB 级请求，链路抖动时**分轮重试**、全轮失败把原因带进错误消息（不再只报「行数不符」）。控制台校验报告标注「已识别站点导出格式（mode=jp），并抓站点原文逐章 sha1 对齐 N 章」，队列 stats 带 `converted`。顺带：清单 `book.key` 与当前项目不一致时直接拒绝（防串项目）。新纯函数 `convertSiteFormat` / `fetchSiteExportLines` / `alignLgResult` 在 `lg-align.mjs`（lg-align-test 17/0，+7）；mock 补 `mode=jp` 夹具（与 chapter-task 同源）、daemon-test 129/0（+2：`/lg/verify` 站点格式自动对齐 3/3、`/run lg-import` 站点格式全量提交）；`tools/.lg-import-sitefmt.mjs` 改为复用同一内核。真机验收（控制台 GUI 点击脚本，非命令行）：`web:syosetu/n7608cw` 导出 34651 行 / 167 章 → 选站点格式 txt 校验 **167/167 章通过**（带自动对齐提示）→ 提交 5 章队列 done（uploaded 5 / failed 0 / converted=true），证据在 `daemon/exports/backup-n7608cw-*/`。
- **站点请求传输层重试**：`SiteClient` 对网络层失败（`ECONNRESET` / `fetch failed` / 超时）默认重试 3 次（退避 300ms×n，`onRetry` 让 CLI 打出「站点请求失败，重试 n」）；HTTP 状态错误（401/400/404/5xx）不重试，语义不变（章节提交与术语表 PUT 都是内容幂等的整章/整表写）。墙内站点只经代理可达、链路抖动频繁——实测整本导入的逐章校验通过率由此从 115/167 升到 165–167/167；测试 daemon-test 129/0（+4 用例：重试后成功 / 耗尽即抛 / 401 不重试 / PUT 重试幂等）。
- **网络代理（出网）**：控制台设置页新增「网络代理」区块（第八个）——站点 API、翻译池、助手/术语池与 Agent 工作区沙箱脚本的出网统一走本机代理（HTTP 绝对形式 + HTTPS CONNECT 隧道，支持 `user:pass@` 凭据）；**保存即生效**，无需重启（未用 Node 内置 `NODE_USE_ENV_PROXY`——它只在进程启动前解析且首值缓存）；直连列表默认 `127.0.0.1,localhost,::1`（mock/测试零影响，关闭时行为与旧版一致）；「测试」按钮做「直连 / 代理」对比探测（`POST /proxy/test`）；不支持 SOCKS5。

### LG 对齐六项（②⑥①⑤③④）

- **② 技能带可执行脚本**：`read_skill` 返回值新增 `baseUrl`（技能包目录的 `file:` URL）——agent 在 `workspace_run` 沙箱里可用 `await import(new URL('scripts/xxx.mjs', baseUrl).href)` 加载技能自带脚本（对齐 LG 的 `matchLiterals` 模式）；沙箱 execArgv 把内置技能根（repo `skills/`）加进 `--allow-fs-read` 白名单（只读——写内置包撞权限模型天然拒绝，用户技能根仍读写）。现有技能包全是纯文档，属纯使能基建（手测：白名单下 import 成功、去掉即 `ERR_ACCESS_DENIED`）。
- **⑥ quality-workflow 审校技能充实（纯内容）**：七码表每码补「取证命令」列；新增「审校循环」节——批量取证优先 `workspace_run` 扫 `warnings/entries.jsonl`（无绑书回落 `list_warnings` 分页）、自启发种子循环 + 种子账本 `work/review-seeds.json`（LG 同构：`completedRounds` + `seeds.{轮次:[{pattern, consumed}]}`，每轮必须更新、禁止跨轮补写、≥3 轮收敛）、处置映射（个别行 → 修句**提案**、整章 → `run_check` 复核后建议 `run_translate` expire 档、术语类 → 转 glossary-workflow、`RETRY_THRESHOLD` → 只读人工）、汇报规范（只挑重点码 + 落地率口径引用 acceptance-scan）；新增 `references/review.md` 七码逐节（判据 → 误报排除 → 处置）。红线写明：只产提案，不直写译文。
- **⑤ 调度器自动并发伸缩（默认值变化）**：`maxInFlight` 填 **0 = 自动伸缩**（起步 4，连续成功 `autoRampEvery`（默认 10）次 +1，上限 16；429/503/`retryAfterMs` 减半，下限 1）——此前 0 被 `|| 1` 吞成 1。许可池改档抽 `_setAutoLimit` 供固定/自动共用，`setOptions({maxInFlight:0})` 可热切；`stats()` 在 auto 档显示当前动态许可（并带 `auto` 标志，控制台状态页显示「并发自动（当前 N）」）；修掉设置链路三处 0 被吞（index 两池初始值、`server.schedulerOptionsFrom`、控制台两个保存按钮 + 输入框 `min=0`），说明文案补「填 0 = 自动伸缩」。daemon-test +2（429 后 4 → 2；`autoRampEvery=2` 时 3 次成功 → 5，热切回固定档 2 立即生效）。

### 连接与凭据

- **控制台「从站点同步」按钮**（设置页「站点与凭据」）：点一下让站点页面把当前短效 token 推过来——`POST /auth/request` 置一条同步请求（5 分钟过期）→ 油猴在 daemon 探测里从 `/ping.pendingAuth` 看到标志后**绕过指纹去重**立即推一次凭据 → `/auth` 收到即清位；按钮在 35s 内等推送到达并回报结果（「已同步（UA · N 个翻译器）」／「未收到推送：确认站点页面已打开并且已登录」）。前提是站点页面开着且已登录——token 只存在站点页面 localStorage，daemon 无法自取；手工粘贴 token 入口保留。
- 油猴 daemon 探测节流 **30s → 5s**（免凭据的本机回环请求，代价可忽略）：自动同步自愈更快（token 刷新后 ≤5s 重推），也让上面那个按钮几秒内生效；仍由指纹短路保证无变化零请求。
- 测试：daemon-test 123/0（+1 标志生命周期/过期语义）、`.e2e-daemon-sync.js` 18/18（+4 强制推送段）、新增控制台车道 `tools/.e2e-token-sync.js` 11/11；queue 九套件与四条控制台车道复跑全绿；改用户脚本按流程走 engine-test 98/0 + `gen-dev` + 篡改猴重装（sha256 整文件一致）。

### 控制台（会话操作）

- **重新生成 / 编辑重发 / 重命名 / 删除会话**（后端 + 控制台一起）：
  - 控制面新增四个 POST 端点：`/agent/session/rename`（空标题 400）、`/agent/session/delete`（跑轮次中 409；挂起审批先按拒绝收尾）、`/agent/message/regenerate`（保留该条用户消息，只丢其后的助手/工具消息后以原文重跑）、`/agent/message/edit`（校验 seq 与角色）。
  - 存储层新增 `deleteAgentMessagesFrom` / `deleteAgentSession`；`agent-session` 新增 `resetSummaryIfBeyond`——摘要由模型生成不可确定性重算，`summaryUpTo` 一旦跨过截断点就整段清掉（否则摘要会引用已删消息）；`runTurn` 新增 `appendUserMessage=false`（重跑不落重复用户消息）。
  - 控制台：消息悬停「编辑」（用户消息→内联编辑器「保存并重发/取消」）与「重新生成」（仅末条助手消息）；顶栏与侧栏会话行「重命名/删除」；截断会让 seq 复用，操作后整表重建消息节点。
  - 测试：agent-test 23/0（+5）、daemon-test 122/0（+6）、新增浏览器车道 `.e2e-agent-session-ops.js` 16/16。

### 助手会话界面

- **助手页从"纯文本流"重做为完整聊天界面**（此前只有一行行纯文本 + 朴素 `<details>` 工具块）：markdown 渲染（标题/列表/引用/表格/行内代码/围栏代码块 + 语言标签与复制按钮、裸 URL 自动链接且只有 http(s) 成链接、其余全部转义）、用户消息气泡右对齐 + 助手通栏、每条消息的时间与 token 用量、工具调用折叠卡（状态点 + 参数/结果分区 + 复制）、审批面板结构化预览（原始 payload 可折叠）、「生成中」闪烁光标与步数指示、智能跟随滚动（用户上翻不拉回）+「回到底部」、空态问候 + 4 条可点建议、侧栏会话行相对时间与运行点、窄窗自适应（≤700px 侧栏收成图标条）。
- 渲染方式：消息按 `seq` 增量 diff（不再每个 SSE 事件整表重绘，保住滚动位置与 `<details>` 展开态）；`renderMarkdown` 等纯函数放模块作用域、经 `${MD_SOURCE}` 内联进页面（既避开 `UI_HTML` 模板字面量的转义陷阱，又能在 Node 侧单测，daemon-test +7 例）。
- **技能面板（只读）**：助手页顶栏新增「技能」——列出 skills/ 全部技能包 + 描述 + 「隐藏」徽标（`disable-model-invocation`，不进 agent 目录但仍可读取）；点技能展开文件 chips（SKILL.md / references/*），点文件看原文（100k 字截断提示）。后端 `/agent/skills` 补 `hidden` 字段且 `files` 改为路径数组，新增 `GET /agent/skill/file`（复用 `skills.read()` 的防逃逸守卫：拒绝 `..`/绝对路径/越界，404/400 分码）；打开面板顺带刷新输入框 `@技能` 候选缓存。daemon-test +2 断言（files 数组/hidden 标注）与 +1 用例（读原文/404/越界/未知技能）。
- **技能双根：内置只读 + 用户技能可编辑（面板与 agent 沙箱）**：技能目录升级为 LG 式双根——内置（repo `skills/`，只读）+ 用户（`daemon/skills-user/`，gitignore，启动即建），**user 同名覆盖 builtin**。面板每项带「内置/用户」徽标：内置看原文（标注只读），用户技能可**编辑保存**（textarea + tmp+rename 原子写，2MB 上限）、**删除此文件**（SKILL.md 是包边界拒单删）、**删除技能**（整包）与面板内**新建**（名字校验 `^[a-z0-9]+(-[a-z0-9]+)*$` + Windows 保留名拒绝）。写端点 `POST /agent/skill/{save,create,delete}` 复用 read() 的路径守卫 + `[skills]` 审计日志。**agent 也能生成技能**：沙箱 execArgv 把用户技能根加进读写白名单（`workspace_run` 脚本可直接写 `<name>/SKILL.md`）。**时效根治**：catalog 从构建时快照改为 `refresh()` 现扫（agent-loop 每轮 + server 三处查询前重扫；system 注入的技能目录每步走 `deps.skills.promptText()` 现值）——新增/编辑技能**免重启**即被 @点名、read_skill 与提示词注入看到。daemon-test +1 全流程用例（create→免重启可见→save→回读→@点名→delete，含内置拒改/越界拒/重复 409/SKILL.md 单删拒）；e2e 车道 agent-ui 12/12 + mention 13/13 回归，面板全流程 CDP 实测通过。
- **会话头部用量条升级**：状态栏在「请求 N」后追加「N 轮 / X tokens / ~Y tok/s」——轮数 = assistant 消息数，tok/s = Σcompletion ÷（末条−首条 assistant 时间差），全部由前端从 snapshot 的 per-message `at`+`usage` 现算（后端零改动）；压缩裁剪后无消息时回落为只显示请求数；e2e 契约「请求 ≥ 2」保持不变。

### 控制台 UI

- **全站换肤为 Windows 经典（PB/VB 那个年代的味道）+ 扁平直角**：**灰打底**——工作区、侧栏、分组框、表格都是 `#c0c0c0`，字段白底，对话区是一块白底"文档窗口"浮在灰工作区上；1px `#808080` 描边、零圆角；**经典蓝只做点缀**——窗口标题栏与侧栏页眉 VB6/Office97 蓝渐变 `#0a246a → #a6caf0`、悬停/选中藏青 `#000080` + 白字（导航、会话行）、表格行 hover 浅蓝 `#d6e2f5`、主按钮与输入焦点藏青、当前项目卡标题条藏青；经典提示条配色（审批面板与 toast 用 `#ffffe1`）；16px 方块滚动条（窄屏回落 10px）；**深色主题退场**（经典 Windows 体系里不存在深色）；字体 Tahoma + Microsoft YaHei UI 12px。
- **图标换 Segoe MDL2 Assets 单色字形**（侧栏 7 项、工具卡、发送键、空态图标）；实现上一律 `String.fromCodePoint(0xE8BD)` 生成，不写 `\u`/CSS `content` 转义——彻底绕开 `UI_HTML` 模板字面量的转义陷阱。
- **各页重排**：任务（派发/队列/最近 run 三段分组框 + 经典网格表）、设置（八个分组框 + 行内 worker 表单）、规则（预设 + 表单 + 表格化列表）、提示词（四槽分组框）、项目（经典面板卡：当前项目带藏青标题条 + 详情表格）、状态（原 JSON 串改为「标签 + 值」属性表 + 双池 / 用量 / RSS 三段）。
- 助手会话界面只换外观（能力见上「助手会话界面」节）；`renderMarkdown` 等纯函数仍在模块作用域经 `${MD_SOURCE}` 内联（可在 Node 侧单测）。
- 既有 DOM 契约全部保留（`#agent-*`、`#agent-log .tool` / `.msg.system`、`.mi/.sel`、行内 display 语义、`data-*`、e2e-lg-gui 断言的按钮文案与文件 input 顺序）；daemon-test 的 `/ui` 结构断言同步保留。

### 修复

- **助手页高度算错**：`.agent-page` 用 `calc(100vh - 顶栏)` 硬算高度，却坐在带内边距的内容区里 → 内容区多出 50px 溢出、冒出竖直滚动条、**输入区被推出视口**；改为 `height:100%` + 内容区 `.agent-active` 模式（让开内边距与滚动条）。
- **右侧留白错位**：聊天区滚动条占在窗口内部，把居中的 928px 消息列挤左 8px，而输入框/审批面板在窗口外不跟着动 → 对话一长就"输入框比消息列右凸 8px"；非助手页则因 `scrollbar-gutter: stable` 常驻 16px 右侧死区（项目页不滚动时页面整体左偏 8px）。统一改为 `scrollbar-gutter: stable both-edges`（两侧对称预留）：三态实测（无滚动条/4 条/30 条消息）消息列与输入框偏差 0.00，各页左右各 30px。
- **`.content` 类名串味**：页面滚动容器与助手消息正文都用 `class="content"`，给容器加底色后助手回复整块被染色 → 容器规则限定为 `.main > .content`。

### 工具 / 启动

- **点击测试基建**：`tools/cdp.mjs` 新增 `setfiles <选择器> <文件…>`（CDP `DOM.setFileInputFiles`，真实文件走磁盘、不经页面字符串，1.7MB 也不怕）与 `CDP_TIMEOUT_MS`（覆盖单条命令的 300s 超时，真机长阶段用）；`tools/.e2e-lg-gui.js` 支持 `window.__LG_GUI_TEST` 阶段化驱动（`all`/`export`/`open`/`verify`/`apply`/`await`）与真实的 bookKey/文件/期望值，mock 车道一把跑完 43/43（原契约格式段 + 新增「站点导出格式自动对齐」段）。
- **托盘不再叠加**（修掉「反复重启后托盘出现两个 7331 实例」）：`daemon.cmd start` 只在没有托盘时拉起（daemon 没跑但有残留托盘时先清理再拉，保证唯一）；`restart` 先清旧托盘再换新 daemon；`stop` 连托盘一起收。四种边界实测：在跑时 start 不新增、restart 后仍 1 个、stop 后托盘归零、干净 start 恰好 1 托盘 + 1 daemon。
- **启动方式去 vbs、全 PowerShell**：新增仓库根 **`daemon.cmd`**（双击 = 启动：端口没有 daemon 就拉起托盘并等就绪后打开控制台；已在跑只开控制台；另支持 `restart|stop|status|console [端口]`——restart 按端口定位进程，用于换新代码）与 **`daemon/tray.cmd`**（只要托盘），逻辑在 `daemon/launch.ps1` / `tray.ps1`；删除 `daemon/tray.vbs`（双击 .ps1 会被记事本截胡，所以保留一个 .cmd 双击壳）。
- 顺带修掉托盘日志的老问题：日志改为按端口分文件 `daemon/.tray-<端口>.log`——原先共用 `.tray.log` 时 cmd 的 `>>` 独占文件句柄，会导致「已有实例在跑时，另一个端口的实例静默起不来」。

### 文档 / 仓库

- **LinguaGacha 流程同文对比入库（`tools/lg-compare/` + `docs/lg-compare.md`）**：同一篇 300 行日文小说摘录分别走 LinguaGacha v0.125.0 的官方 CLI 流程（进程内装配 + 内置 stub 端点，不需要 Electron）和本仓库 `daemon/translate.mjs` 真实核心，两侧每个请求的完整 system/user 提示词全量落盘（`artifacts/*.jsonl`）。实测：LG 9 请求/进请求 178 行（空行零请求、纯符号行预过滤、token 上限分段 13–26 行/请求、术语表 `src -> dst #info` 按 work unit 命中激活、条目级 id 对账 + 缩段重试、`<why>` 结构化思考块）；daemon 10 请求/300 行全进（1500 字符/30 行固定分段、空行占编号、段级重试 + 二分、`jp => zh` 按段命中注入）。报告含六维对比、双方提示词全文与 5 条可借鉴点（仅记录未改码）；LG 侧驱动由 `run-lg-flow.mjs` 复制进 LG 仓库 vitest 跑完即删，LG 仓库跟踪文件零改动。
- **Agent 模式与技能系统同维实测（同一套 `tools/lg-compare/`，`run-lg-flow.mjs agent` + `daemon-agent-driver.mjs`）**：LG 侧装配真 `AgentService`（零 Electron）+ 真 CodeAct 沙箱（`build-workspace` 运行时），stub 扮演 agent 模型发 tool_calls——真 read_skill（builtin/skills/glossary）→ 真 workspace_run 跑提取脚本 → 真 workspace_apply（manual 审批挂起 → 驱动放行）→ 3 条术语事务落 rules 表 → agent 内 run_batch_item_translation 全文翻译（2/9 请求带术语段，与 CLI 激活语义一致）；期间被 LG 真 schema 校验拒过一次（create 缺 `sort` 字段）后修正。daemon 侧真 `createAgentLoop` + 真 skills/ 目录（技能目录进 system + `read_skill` 真正文 + @writing-guide 点名内联）+ 真 decision broker（审批写入/ask_user 提问自动作答）。报告新增「Agent 模式与技能系统」一节：编排者 vs 运维助手定位、SDK 托管 vs 自研循环、工具/技能/审批三张对照表、agent 维度 4 条可借鉴点（技能即预设/技能带脚本/ask_user 默认项/审校分工）。
- 安装/更新流程写清楚（README「安装」+ AGENTS「交付流程」）：三个装法（仓库文件 / 走 mock 装正式构建 / `gen-dev` 后的 dev 构建）、**mock 必须先起着**（8788 没进程时浏览器就是"连接被拒"）、脚本头无 `@updateURL` 所以 **Tampermonkey 不会自动更新**、测试 profile 里重装 ≠ 日常浏览器也更新（两边各自要装并刷新）；daemon/README 补「从站点同步」按钮的前提。
- LinguaGacha 上游源码 junction 挂载到仓库根（`linguagacha/` → `C:\cache\linguagacha`，pin `MANUAL_BUILD_v0.125.0`——spec-06..10 的借鉴出处，另留 `upstream-main` 分支备查；独立仓库不入库）：AGENTS 结构与上手表、README 导航表补行。

## v0.8.0-alpha.2（2026-10-07）

自 v0.8.0-alpha.1 之后的增量：

### 用户脚本

- 「同步 Daemon」→「**Daemon 连接**」：`/ping` 探测式同步、连接状态只读行 + 行尾在线/离线角标（30s 节流）、**凭据自动同步**（默认开：页面加载即推、token 刷新后 ≤30s 自动重推、指纹去重无变化零请求）；模块改名迁移保留 Daemon 地址设置。

### daemon

- **控制台项目一级化（LG 式）**：项目 = 登记的书（一级容器）；侧栏「当前项目」切换器全站跟随；「书籍」页升级为「项目」页（卡片：进度/最近 run/队列/提案 + 详情）；任务/规则/助手/状态跟随当前项目；助手会话按项目分组、绑书会话注入【当前项目】上下文；
- **Agent 工作区（CodeAct，LG 同款）**：`workspace_run`（`--permission` 沙箱脚本执行 + `ws` API：contract/doing/read 章节）与 `workspace_apply`（`changes/**.jsonl` 变更清单 → fp 漂移检测 → 审批 → 事务提交 → 回执）；工作区数据集含 warnings；
- **质检 v2（对齐 LG）**：`FOREIGN_CHAR_RESIDUE` 字素+书写系统分类（片段证据、拉丁短串豁免）、`SIMILARITY` 原始文本比较 + JA→ZH 残留护栏、`PUNCTUATION_MISMATCH` 标点组序列、`TEXT_PRESERVE` 实装（保留段逐位比对+证据）；警告落库 `warnings` 表 → `GET /warnings`、agent `list_warnings`、工作区 `warnings/entries.jsonl`、控制台项目详情；
- **内置保护规则预设**：base/kag/renpy/rpgmaker/wolf 五层（对齐 LG 预设库），规则页切换（`config.textPreserve.preset`），与用户规则按 pattern 优先合并；质检按非空白片段比对（LG 语义）；
- **LG 译文导出/导入进 GUI**：项目页「导出 LG 源文 / 导入 LG 译文」，上传结果 txt → 逐章校验报告（行号三层对齐）→ 提交通过章入队 `lg-import`（面板内实时进度）；
- **连接配置与状态可见化**：端口持久化（`config.serve.port` + 托盘自读）、`GET /ping`、`lastSync`（origin/UA 摘要/翻译器数/`mode: auto|manual`）、跨域白名单可扩展（内置默认不可移除）、设置页「连接」区；
- **设置页 v2**：双模型池（翻译 vs 助手/术语，独立并发限流；助手池显式后不被油猴推送覆盖）、池端点增删改（key 只写回掩码）、token 直填、助手参数（审批/maxSteps/上下文预算）；
- **Windows 托盘**（零依赖 PowerShell NotifyIcon）：隐藏运行 daemon，菜单 = 控制台/状态/日志/重启/退出，意外退出气泡，`shell:startup` 自启。

### 兼容性

- 质检 v2 命中判定变化属预期（更接近 LG）；`runs` 旧数据不动；控制台设置/规则结构兼容旧配置存档（新设置自动回填、模块改名有迁移）。

## v0.8.0-alpha.1（2026-10-06）

首个打点版本：Tampermonkey 用户脚本 + 本地 Node daemon 一起发布。

### 用户脚本（`ntr-toolbox-alpha.user.js`）

- TheNano NTR ToolBox 的 clean-room 重构（spec-01..05 全部实施，行为等价验证）
- AI 术语表提取 / 审核 / 队列：分块 → LLM 提取 → 爬楼式轮次收敛；预览/写入两种模式；断点续跑（分块缓存）；再筛选（模型批量「建议删」）；回滚快照（每目标 20 版）；行覆盖率；运行参数实时生效
- KWG 术语表导入（JSON / 扁平 / `原文 => 译文` / 剪贴板 / 拖拽，统一 diff 弹层）
- 翻译器小工具：添加/删除/复制到 BETA 工作区、填充术语表、工作区同步
- 「同步 Daemon」：把站点凭据与 GPT 翻译器推送给本地 daemon
- 站点自检：启动/路由切换时检查站点挂点，改版告警

### daemon（`daemon/`，Node ≥ 24，零 npm 依赖，状态全在 SQLite）

- **翻译 worker**：站点 GPT 工作区的 Node 替代——逐章翻译回传（分段 1500 字/30 行、`#编号` 协议、术语表按命中行注入、行数不匹配重试、expire/normal/all 档位）；译文上传后立刻释放章节文本（修工作区内存泄漏）；进度与段级缓存落库可续
- **术语管线**：提取 → 核实 → 指南门槛 → 直写/提案（写入前快照、回读校验）；质检七码报告
- **LLM 调度器**：全局并发门（默认 1 = 单线程逆向 Gemini）、key 池轮转 + 阶梯冷却、Retry-After 遵循、RPM 节流、提示词预算（strict 可选）、用量记账；**双模型池**——翻译池 vs 助手/术语池（独立并发门/限流，互不抢占）
- **本地助手 Agent**：LG 式工具调用循环（只读/执行/写入三层工具 + 审批 diff 预览 + 追问）、SQLite 会话与摘要压缩、技能目录（8 个，含 writing-guide / agent-charter 隐藏前置）、控制台「助手」页（SSE 实时流）
- **控制台 GUI**（OpenWebUI 风格，`serve` 后 /ui）：任务派发 / 规则 / 提示词模板 / 书籍 / 状态；设置页：双模型池端点管理（key 只写回掩码）、token 直填、助手参数（审批模式 / maxSteps / 上下文预算）；输入框 @技能点名 / 斜杠命令
- **LG 互通**：术语表 JSON 导入/导出；`export-src` → LinguaGacha 翻译 → `import-lg` 对齐导入（配对清单 + 总行数/每章行数与空模式/源 sha1 三层校验，按站点 GPT 端契约提交）
- **Windows 托盘**（零依赖 PowerShell NotifyIcon）：隐藏运行 daemon；菜单 = 控制台 / 状态 / 日志 / 重启 / 退出；意外退出气泡提醒；`shell:startup` 自启
- 文本处理链（占位符投影/保留段/替换/标点稳定化，行数不变量）、提示词模板（默认与站点镜像逐字一致）、自愈监控（RSS 看门狗 + 看门狗拉起）

### 兼容与安全

- 站点契约经真机核对：`/file` 必带 `filename`、chapter-task `sync` 必填、HTTPS 页面访问本机走 LNA/PNA（CORS 已回 PNA 头）、章节提交体与工作区完全一致
- 控制台跨域白名单（n.novelia.cc + localhost）、仅监听 127.0.0.1；API key 明文不出本机（接口只回掩码）
- 外网请求走本地代理；不向线上站点写测试数据（写入类 e2e 拦截）
