# 上游同步记录（auto-novel 站点源码）

本文件记录**我们与上游站点源码 auto-novel 的对齐基线**：每次同步在这里钉一个 commit + 日期 + 核对结论，避免"上游又更新了"变成考古。

> 与 LinguaGacha 的关系：LG 侧 pin 在 `README.md` / `AGENTS.md`（`MANUAL_BUILD_v0.125.0`，spec-06..10 逐条引用文件行号）。本文件是 auto-novel 侧的对应物。

## 基线

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/auto-novel/auto-novel`（本地 clone `C:\Users\bennyli\auto-novel`，`upstream` 远端） |
| 本次核对 commit | **`c11cdbfe`**（`fix(api): 配置独立的代理出口`） |
| 抓取日期 | 2026-10-17（`git fetch upstream --prune`，走 6789 代理） |
| 上一次核对 | `5fc49d30`（2026-10-11，本地工作树当时停在这里） |
| 增量 | 53 个提交；契约面（`web/src/{api,domain,stores,model}`、`server/**`、`packages/translator`）39 文件 |
| 核对方式 | `git show upstream/main:<path>` 读内容，**不 merge、不改上游工作树** |
| 本轮处置 | ①–⑧ 全部实施（2026-10-17 同日，代码 + 测试 + mock 夹具）；⑨ 无需动作 |

## 权威文件清单（站点契约的源头）

| 面 | 文件 |
|---|---|
| HTTP 端点 | `web/src/api/{client,WebNovelApi,WenkuNovelApi}.ts`；服务端 `server/src/main/kotlin/api/Route*.kt` |
| 导出文本格式 | `server/src/main/kotlin/infra/web/repository/makeTxt.kt`、`infra/wenku/repository/WenkuNovelVolumeRepository.kt` |
| 工作区/任务数据 | `web/src/model/Translator.ts`、`web/src/stores/{key,useWorkspaceStore,workspaceJob}.ts` |
| 术语表 | `web/src/model/Glossary.ts`、`web/src/components/NovelGlossaryEditor.vue`、服务端 `Route*Novel.kt` 的 `glossary` 路由 |
| 认证 | `web/src/webKit.ts` + 外部包 `@novelia/web-kit`（来自 `auto-novel/auth`，源码不在本仓库） |

## 2026-10-17 核对结论

> ①–⑧ 均已处置（同日实施 + 测试），逐条见各小节末尾的「✅ 处置」。⑨ 为无需动作的记录。

### ① 【致命】会话存储键变更：`auth-v2` → `web-kit:session:v1`

- 证据：本次删除了 `web/src/api/auth/session.ts`（原来持有 `auth-v2` 键）；新认证入口 `web/src/webKit.ts` 调 `createWebKit({auth:{app:'n',url:__AUTH_URL__}})`，实现在外部包 `@novelia/web-kit`（`auto-novel/auth@f3db8de`，`packages/web-kit/src/auth/session.ts`）里：`const SESSION_STORAGE_KEY = 'web-kit:session:v1'`，存 `{ token, adminMode }`，**无旧键迁移**。
- 我们：`ntr-toolbox-alpha.user.js:1909`、`:8428-8435` 只读 `auth-v2`（回落 `auth.profile`）；健康检查模块 `:2550-2553` 也只认 `auth-v2`。
- 后果：站点一旦部署这版，**脚本读不到 token → daemon 拿不到凭据 → 全线 401**。这很可能就是 2026-10-16 真站 401「查不出原因」的成因（当时 daemon 用的是 localStorage 里遗留的旧 `auth-v2` 值）。
- 处置：**读 `web-kit:session:v1` → `auth-v2` → `auth`（按此顺序）**，三处一并改（取 token 链、健康检查、面板文案/诊断）。
- ✅ 处置：`user.js:83-96` 抽出 `SITE_SESSION_SOURCES` + `readSiteToken()`（三键按序取 token，返回 `{token, key}`），`initToken()`（`:8463-8466`）、`daemonReadToken()`（`:1925-1957`）、健康检查条目（`:2574-2579`，改名「会话存储（站点会话键）」并回报命中的键名）三处全部改走它；读不到时的提示文案列出三个键名。测试：`tools/.e2e-daemon-sync.js` 第 6 段 5 项（三键各自命中 + 优先级 + 都缺时回落空），浏览器车道 23/23 通过。

### ② 【高】BETA 工作区的 worker/队列归属在上游改了（`64d6f805`，10-16）

- 证据：`GptPipelineWorkspace.vue:41-45` —— `workerStore = useWorkspaceStore(isSakura ? 'sakura' : 'gpt-pipeline')`，而 `jobStore = useWorkspaceStore(props.translatorId)`（BETA 页 `translatorId='gpt'`）→ **worker 读 `workspace-gpt-pipeline`，任务队列读 `workspace-gpt`（共用）**。这与 `5fc49d30` 时"整仓都用 `gpt-pipeline`"不同，提交标题即「修复 Sakura pipeline 翻译与共享队列状态」。
- 我们：`StorageUtils.update():7522-7527` 用 `pathname.includes('workspace/gpt')`，在 BETA 页整仓读写 **`workspace-gpt`** → 队列正确、**worker 错**（pipeline 仓从不被我们的 round-trip 触碰）；`moduleDeleteTranslator:172-173` 用 `endsWith('gpt')` → BETA 页静默失效；`moduleClearJobs:687-688` 同判定 → 行为恰好正确。
- 处置：抽出 `workspaceKeysForPath(path)` 返回 `{workers, jobs}`；BETA 页 workers 走 pipeline 仓、jobs 走 `workspace-gpt`。
- 我们 `user.js:7971` 的提示文案「BETA 的任务队列与老工作区共用 workspace-gpt」**现在是对的**，不必改（`2096` 注释要一起对齐）。
- ✅ 处置：`user.js:7547-7560` 新增 `StorageUtils.gptPipeline = 'workspace-gpt-pipeline'` 与 `keysForPath(pathname)`（sakura 页两仓都 sakura；`workspace/gpt-pipeline` 页 workers=pipeline / jobs=gpt；`workspace/gpt` 页两仓都 gpt；其它返回 null 表示不改动）；`update()`（`:7562-7570`）先写 workers 仓、不同则再写 jobs 仓；`addGPTWorker(..., storeKey)` 由调用方传 `keysForPath().workers`；删除翻译器（`:197`）与清空任务（`:712`）各取自己那半；删除成功提示按 `keysForPath` 判定是否 sakura。测试：`tools/.e2e-workspace-backup.js` B0 段 7 项（含 `history.pushState` 切到 BETA 页后 `update()` 双仓分写、`addGPTWorker` 落在 pipeline 仓），浏览器车道 48/48 通过。

### ③ 【高】导出格式变更：章节标题前多两个空行（`11fbbb9f`）

- 证据：`makeTxt.kt:76-78` `writeTocItemTitle()` 首行新增 `write("\n\n")`，即每个 toc 项标题（章与卷/分组项都是）前多两个空行。
- 我们：**兼容，无需改逻辑**——`convertSiteFormat` 靠扫描 `^#\s` 定位标题、其后仍固定 1 个结构空行（`pos + 2` 仍是首段正文）；`convertSiteFormatLoose` 的块内边界只要求尾部全空，多两个空行不影响。
- 处置：mock 夹具要跟上（否则测试验的是旧格式）；加一条「两种章块间空行数都能对齐」的回归用例。
- ✅ 处置：**不能只改夹具**——原实现的「标题后固定偏移 + ±2 窗口」在新格式（标题前两空行）+ 卷/分组标题块（它们也占一个 `# 标题` 块却没有章节条目）下必然失配。改成块作用域前向扫描：`daemon/lg-align.mjs:127-155` 逐标题定位、在「本标题到下一个标题之间」按 sha1 命中切原文块，标题位置由命中反推（不再假设偏移）。测试：`daemon/lg-align-test.mjs` 新增旧/新两种空行变体 + 卷标题块的用例；mock 夹具（`mock-llm/server.mjs` 的 `mode=zh`/`mode=jp` 导出）已同步改成「标题前两空行」，49/0 通过。

### ④ 【中】缺译标记未识别 —— 站点导出的第三种结构差异

- web（`makeTxt.kt:82-87,108-131`）：整章未译 → 该章写成 `GPT翻译缺失。\n\n`（或 `百度/有道/Sakura翻译缺失。`）且正文 0 行；站点丢章 → `该章节缺失。\n\n`。随后仍写 `\n\n\n`。
- 文库（`WenkuNovelVolumeRepository.kt:109-130`）：整卷下载为**逐行正文、无标题无头部**；某章无译文 → 整章只写一行 `// 该分段翻译缺失。`。
- 我们：`looksLikeSiteFormat()`（`lg-align.mjs:96-99`）只看 `############` 与 `^#\s`，文库文件两者皆无 → 直接判定"不是站点格式"；web 文件则进了对齐但只要有一章带标记，严格/宽松两种模式都会因非空行数对不上而**整体拒绝**。
- 处置：新增「标记展开」—— 识别上述标记并按清单 `entry.count` 展开成等量空行（未译章随后由 `verifyImport` 的空/非空模式校验正常判为不可提交，不会污染已译章）。
- ✅ 处置：`daemon/lg-align.mjs:109-110` 新增 `MISSING_TRANSLATION_MARKER` / `isMissingTranslationMarker`（`百度|有道|GPT|Sakura翻译缺失。`、`该章节缺失。`、`// 该分段翻译缺失。`，且只在整行 trim 后全等时命中——正文里正常出现的「…翻译缺失。」不误判）。严格模式：标记章按 `entry.count` 补空串、并累加 `zhDrift`（否则后面所有章的译文切片整体错位）；宽松模式：`marked` 章跳过非空行数校验同样补空。提交侧：`verifyImport` 对全空 dst 的章给原因「该章没有译文（站点导出里是「翻译缺失」标记），跳过上传」；`verifySubmitted` 比对前 `neNoMarker()` 双侧剥离孤立标记行。测试：lg-align-test 8 项（严格/宽松的标记章、标记后章不错位、非标记文本不误判、标记章跳过上传、提交回读双侧剥离）。

### ⑤ 【中】文库「站点导出格式自动对齐」这条路本身走不通（本次确认）

- 证据（`c11cdbfe` 基线，与 10-11 版一致）：服务端 `WenkuNovelVolumeRepository.kt:119-121` 对 `mode=Jp` 直接 `throw RuntimeException("文库小说不允许日语下载")`；前端 `WenkuNovelApi.ts:109-140` 的 `mode` 类型就是 `'zh' | 'zh-jp' | 'jp-zh'`，且 **URL 是逐卷的** `/api/wenku/{novelId}/file/{volumeId}?...`（无整本端点）。
- 我们：`lg-align.mjs:229-235 fetchSiteExportLines` 的文库分支拼 `/api/wenku/{id}/file?mode=jp…` → 既缺 `volumeId`（404）又用被禁的 `mode`（400），而且即便通了，假设的「`############` + `# 标题` 块」结构在文库导出里根本不存在。
- 处置：删掉该死分支，文库命中站点格式时给明确提示（"文库无整本导出接口且不支持 mode=jp，请用本工具「导出原文」得到的契约格式 txt"）。若要支持"文库单卷站点导出"，需按 `volumeId` 过滤清单 + 让用户选卷，另开一轮。
- ✅ 处置：`daemon/lg-align.mjs:274` 的文库分支不再发请求，直接抛上述提示；`verifyImport` 行数不符时追加文库专属提示（`:332`）。测试：lg-align-test「文库站点导出 → 明确报错且 0 请求」+ 文库提示用例。**文库的导入路径就是契约格式 txt（本工具「导出原文」产物）**，这条已在 `docs/cleanroom/spec-13` 写明。

### ⑥ 【中】文库 `translate-v2` 响应字段（仍未变，我们仍错）

- 证据：`RouteWenkuNovel.kt:584-594` 只返回 `{glossaryId, toc:[{chapterId, glossaryId?}]}`；`glossaryUuid`/`glossary`/标题是 web 专有（`RouteWebNovel.kt:929-946`）。
- 我们：`site-client.mjs:121` 照抄 web 形状 → 文库 `glossaryUuid` 恒 `''` → `translate-pipeline.mjs:48-50` 判 `fresh=true, expired=false` → **`normal`/`expire` 档在文库上每次全量重翻**；`item.title` 恒空 → 导出清单章名为空。
- ✅ 处置：`daemon/site-client.mjs` 的 `getTranslateTasks` 文库分支归一字段——toc 项的 `glossaryId`（上游省略键=未译，Kotlinx `explicitNulls=false`，所以用 `=== undefined` 判定）映射到 `glossaryUuid`、书级 `glossaryId` 作为当前版本 `glossaryUuid`、`glossary` 补 `{}`；web 分支不动。测试：`daemon/translate-test.mjs` 新增文库用例（未译章判 fresh / 已译章带 uuid / 书级 glossaryId 作为当前版本），并覆盖 `planTargets` 的 normal·expire·all 三档。

### ⑦ 【低】术语表 PUT「内容未变 → 400」

- `RouteWebNovel.kt:887-888`「修改为空」、`RouteWenkuNovel.kt:474-476`「术语表没有改变」。我们 `site-client.mjs:87-89` 的注释「内容幂等：重试安全」是错的。
- ✅ 处置：`daemon/site-client.mjs:105-112` —— 400 且响应体命中 `修改为空|术语表没有改变` 时按**已达成目标状态**返回成功（内容一致），其它 400 照旧抛错；注释改成「整表替换 + 传输失败重试安全；上游对『内容没变』主动返 400，按幂等成功处理」。测试：`daemon/daemon-test.mjs` 新增「PUT 内容未变 → 400 视为成功」+「其它 400 仍失败」两项；mock（`mock-llm/server.mjs:300`）按 web/wenku 分别回这两种文案。

### ⑧ 【低】401 三义混用

- `Authentication.kt`：真 token 问题带 `WWW-Authenticate: Bearer error="invalid_token"` + 纯文本 `Token不合法或者过期`；但 401 也用于封禁与权限不足（术语表 PUT 需 member 且注册满 30 天）。web-kit 的 whoami 角色集为 `admin/trusted/member/restricted/banned`。
- 我们三处 401 一律提示"token 失效"并触发 need-auth 链路。
- ✅ 处置：`daemon/site-client.mjs:65-72` 新增 `#unauthorizedError(res)` —— 读 `www-authenticate`（含 `error="invalid_token"`）与响应体：真 token 问题 → `code='unauthorized'`（「401 未授权：站点凭据失效，请重新同步凭据」）；无该头 → `code='forbidden'`（「401 无权限：账号被限制或权限不足——术语表写入需 member 且注册满 30 天」）。`#json` / `getText` / `putGlossaryRaw` 三处统一走它。消费侧：`lg-align.mjs:14-15` 的 `isUnauthorized` 只认 `code==='unauthorized'`（或老式无 code 的 401 文案），**forbidden 不再触发 need-auth、不中止不重试**。测试：daemon-test 新增「401 带 `WWW-Authenticate` → unauthorized / 裸 401 → forbidden」分类用例（原裸 401 用例同步改名）；lg-align-test 新增「权限类 401 → 不当成凭据失效（不中止、不重试、报原由）」。mock 新增两条车道（`/api/**` 路径含 `mock-token-bad` 带该头、`mock-forbidden` 不带）。

### ⑨ 【记录】其它上游变化，对我们无影响

- `web/src/stores/key.ts` 移除 `Blacklist` / `ReadPosition`（黑名单与阅读位置改为服务端）——我们不读写这两个键。
- API 层 `web/src/api/**` 只是文件搬家（`novel/` 子目录扁平化）+ 认证客户端换成 `webKit`，**URL 与超时（60s）均未变**。
- `workspaceJob.ts` 新增 `summarizeQueueResults()`（排队结果提示文案，可借用到我们 GUI 的排队反馈）；`GptWorkspace/SakuraWorkspace` 的 `getNextJob` 增加 `finishAt === undefined` 过滤（已完成任务留在 jobs 里但被跳过）。
- `packages/translator` 接入 pi-ai 多协议（新增 `responses` profile / anthropic / OpenRouter 请求头修复）。我们写 worker 时**不写 `profile`**，故无影响；若将来要写，注意 `profile.id` 取值集合已变（曾为 `openai|deepseek|gemini`）。
- 新增 Go 后端骨架与横幅管理后台 —— 与我们无关。

## 遗留风险（复核后仍保留的已知点）

兼容性复核（2026-10-17，提交前）逐条过了一遍改动面，下列为**明知而保留**的点——都只影响「报错/告警」而不产生错位数据，出现时再处理：

- **块作用域扫描不能跨过正文里以 `# ` 开头的段落**：站点格式对齐按「本标题 → 下一个标题」划块，若某章正文段落本身以 `# ` 开头，该章的搜索窗口会被截断 → 结果是**明确拒绝**（「原文块对不上」），不会错位。
- **回读校验的假一致**：`verifySubmitted` 只在两侧都是「整章唯一一行标记」时按标记文本比对（不同标记会报不一致）；若两侧标记文本相同但内容其实都缺失，仍会报「一致」——回读只是校验工具，不写任何数据。
- **401 分流依赖 `WWW-Authenticate`/正文**：真凭据失效带 `Bearer …invalid_token`（或裸 `Bearer`）挑战、正文 `Token不合法或者过期`；若中间层把两者都改掉，会被归为 `forbidden`（不触发 need-auth 自愈）。上游当前实现不会出现这种情况。
- **BETA 页 DOM 无浏览器级覆盖**：mock 没有 `/workspace/gpt-pipeline` 页面，`keysForPath` 的双仓分写只有 API 级用例（`.e2e-workspace-backup.js` B0）；真机验证靠 `tools/.probe-wb-live.js`。

## 下次同步怎么做

1. `https_proxy=http://127.0.0.1:6789 git -C C:\Users\bennyli\auto-novel fetch upstream --prune`
2. `git log <本文件记录的基线>..upstream/main` + `git diff --stat <旧>..<新> -- web/src server/src packages/translator`
3. 只深挖改动落在「权威文件清单」里的部分；用 `git show upstream/main:<path>` 读，**不 merge**
4. 逐条更新本文件的结论表 → 需要改代码的写进 `docs/cleanroom/spec-*.md` → 改 → 测试 → 把新 commit 写回本文件「基线」表
