# Changelog

All notable changes 按版本记录；版本号跟随油猴脚本 `@version`。

## 未发布（v0.8.0-alpha.3-dev）

自 v0.8.0-alpha.2 之后的增量（均已合入 main，未打 tag）：

### 上游同步：auto-novel `c11cdbfe → fd90b2d4`（2026-10-20，41 提交，旧 GPT 工作区退役）

上游这一轮把**旧 GPT 工作区整个删掉了**：`/workspace/gpt` 重定向到 `/workspace/gpt-pipeline`、`/workspace` 默认重定向到 `/workspace/sakura-pipeline`，`GptWorkspace.vue`/`GptWorkerModal.vue`/`Interactive.vue` 删除。翻译器仓与任务仓的归属没变（GPT workers 在 `workspace-gpt-pipeline`、jobs 仍与 `workspace-gpt` 共用；Sakura pipeline 两仓都是 `workspace-sakura`），但旧 `workspace-gpt.workers` 从此没有任何页面维护，属于死数据。逐条核对见 `docs/upstream-sync.md`（基线已改为 `fd90b2d4`）。

- **退役新旧工作区同步功能**：删除模块「复制翻译器到BETA工作区」「工作区翻译器自动同步」，以及 `WORKSPACE_SYNC_STATE`/`WORKSPACE_PAIR`/三路合并/`syncWorkspaceTranslators`/`_NTRGlossaryDev.syncWorkspaceTranslators` 等辅助与导出；历史快照键 `ntr-workspace-sync` 不再读写（保留原值，可手动清理）。删除测试 `.e2e-translator-copy.js`、`.e2e-workspace-sync.js`。
- **普通链路只读新工作区**：新增 `readWorkspaceGptWorkers()`，只读 `workspace-gpt-pipeline`（按 id 去重、丢弃缺 id/endpoint）；翻译器下拉、AI 术语提取、Daemon 凭据推送、站点自检全部改走它。`StorageUtils.addGPTWorker` 缺省目标改为 pipeline（不再随页面落旧仓）；`keysForPath` 把 `/workspace/gpt` 过渡路径映射到 `{workers: pipeline, jobs: gpt}`；站点自检条目改名为「GPT 工作区翻译器存储」。
- **新模块「合并旧工作区翻译器」**（替代两个同步模块）：一键把旧 `workspace-gpt.workers` 合并到 `workspace-gpt-pipeline`——新 id 追加、同 id 默认跳过（可勾选「覆盖同名翻译器」）、跳过 `type:'web'` 与缺 id/endpoint 条目；目标仓 jobs/uncompletedJobs 原样保留、旧仓一个字节不改；写入走 `_setData`（归一化 + StorageEvent），通知汇总新增/覆盖/跳过数量；可重复执行且幂等。它是普通链路之外**唯一**读取旧 workers 的入口。
- **备份改为 jobOnly**：`WORKSPACE_SECTIONS.gpt` 标记 `jobOnly: true`——导出时 `workers` 恒为 `[]`，导入时忽略备份里的旧 GPT 翻译器并提示用迁移模块；`workspace-gpt` 的 jobs/uncompletedJobs 备份/恢复语义不变。文件格式仍 v1，旧备份可导入；面板该行翻译器列显示「—（不备份）」，标签改为「GPT 共享任务队列（workspace-gpt）」。
- **后端 API 复核无需改代码**：`server/src` 仅 3 个文件变化——`PUT /api/novel/{provider}/{id}/translation` 的 toc key 改为 `chapterId ?: titleJp`（本项目不调用该元数据写接口）、`GET /api/novel/{provider}/{id}` 的同名章节 toc 合并值变化（字段/结构不变）、Pixiv 目录 `createAt` 开始有值（类型不变）。我们使用的 translate-v2/chapter-task/章节上传/`/file`/术语表 PUT/认证 401 分流全部未变；Go Banner API 的另一组变化与本项目无关。明细见 `docs/upstream-sync.md`「2026-10-20 后端 API 差异明细」。
- **会话与前端存储**：会话键仍是 `web-kit:session:v1`；`useWorkspaceStore` 从 `lazy` 改 `createGlobalState` 但存储语义不变；pipeline 新增 `prepareExecution`/`allowModels` 属站点前端内部。
- 测试：新增 `.e2e-workspace-migrate.js` **18/18**；重写/更新 `.e2e-translator-select.js` **15/15**、`.e2e-translator-mgmt.js` **21/21**、`.e2e-storage-utils.js` **8/8**、`.e2e-workspace-backup.js` **53/53**、`.e2e-sitecheck.js` **33/33**、`.e2e-daemon-sync.js` **24/24**、`.e2e-collect-tasks.js` **16/16** 与真机探针 `.probe-wb-live.js`（改到 `/workspace/gpt-pipeline`）。回归：`engine-test` **98/0**、`daemon-test` **151/0**、`translate-test` **25/0**、`lg-align-test` **49/0**、`quality-test` **38/0**、`proxy-test` **32/0**；浏览器 `.e2e-config.js` 3 组全绿、`.e2e-panel-basics.js` **30/30**、`.e2e-sync-storage.js` **7/7**、`.e2e-backup.js` **15/15**。

### 上游同步：auto-novel `5fc49d30 → c11cdbfe`（2026-10-17，53 提交，8 项漂移处置）

站点源码又动了一批。核对结论与逐条处置写进新文档 **`docs/upstream-sync.md`**（对齐基线 pin + 权威文件清单 + 下次同步步骤——「上游更新了」以后先读它）。本轮处置的 8 处：

- **① 会话存储键变更（致命，很可能是 10-16 真站 401 的成因）**：站点删掉 `web/src/api/auth/session.ts`、改用外部包 `@novelia/web-kit`，会话键 `auth-v2` → **`web-kit:session:v1`**（值 `{token, adminMode}`，**无旧键迁移**）。原实现三处只读 `auth-v2` → 站点一部署就读不到 token、daemon 全线 401。修法：`user.js` 抽 `SITE_SESSION_SOURCES` + `readSiteToken()`（`web-kit:session:v1` → `auth-v2` → `auth.profile.token` 依次回落，返回 `{token, key}`），`initToken()` / `daemonReadToken()` / 站点自检条目三处全部改走它；自检与提示会写出**命中的是哪个键**，读不到时列全部三个键名。
- **② BETA 页 worker 仓与任务仓分家**（上游 `64d6f805`）：`/workspace/gpt-pipeline` 的 worker 读 `workspace-gpt-pipeline`、任务队列与老工作区**共用 `workspace-gpt`**。原实现按「pathname 含 workspace/gpt」单键读写 → 队列对、**worker 写错仓**（BETA 页加的翻译器进了老工作区、pipeline 仓从不被 round-trip）。修法：`StorageUtils.keysForPath(pathname)` 返回 `{workers, jobs}`，`update()` 先写 workers 仓、不同再写 jobs 仓；`addGPTWorker` / 删除翻译器 / 清空任务各取自己那半（清空任务仍取 `workspace-gpt`——与老工作区共用，行为不变）。
- **③ 站点导出格式：章标题前多两个空行**（上游 `11fbbb9f`，`makeTxt.kt` 的 `writeTocItemTitle()` 首行 `write("\n\n")`）：原「标题后固定偏移 + ±2 窗口」在新格式与卷/分组标题块下必然失配 → 改成**块作用域前向扫描**（在「本标题到下一个标题」之间逐位置试切 `count` 行、sha1 命中为止，标题偏移由命中反推），旧格式、新格式、卷标题块三种都对得上；mock 夹具同步改成新格式。
- **④ 缺译标记章**：部分翻译的站点导出里，未译章只写一行标记（web `GPT翻译缺失。`/`百度|有道|Sakura翻译缺失。`、丢章 `该章节缺失。`、文库 `// 该分段翻译缺失。`）——原实现因「非空行数对不上」把**整本**拒掉。修法：识别标记（整行 trim 全等才算，正文里的「…翻译缺失。」不误判）→ 按清单 `count` 展开空行（严格模式另记 `zhDrift` 防后续章错位）→ 提交侧判「该章没有译文…跳过上传」，已译章照常导入；提交回读比对前双侧剥离孤立标记行。
- **⑤ 文库「站点导出格式自动对齐」是死路（确认后删掉）**：服务端对文库 `mode=jp` 直接抛「文库小说不允许日语下载」、下载是**逐卷**端点（无整本）、导出无标题块结构且章序是 `sorted()`（toc 未排序）。原实现拼的 URL 既缺 `volumeId` 又用被禁的 mode，即便通了也对不上。修法：**不再发请求**，命中即报错提示改用本工具「导出原文」的契约格式 txt（`verifyImport` 的行数不符报告里也带该提示）。
- **⑥ 文库 `translate-v2` 字段**：上游只返回 `{glossaryId, toc:[{chapterId, glossaryId?}]}`（`glossaryUuid`/`glossary`/标题是 web 专有）→ 文库上 `glossaryUuid` 恒空，`normal`/`expire` 档每次全量重翻。修法：`SiteClient` 文库分支归一字段（toc 项的 `glossaryId` → `glossaryUuid`、书级 `glossaryId` 作为当前版本、`glossary` 补 `{}`；未译章是**键缺失**而非 `null`，按 `=== undefined` 判定）。
- **⑦ 术语表 PUT「内容没变 → 400」**：上游 web 返 `修改为空`、文库返 `术语表没有改变`。原注释「内容幂等」是错的 → 命中这两种文案按**幂等成功**处理（合并结果与站点一致是正常情形），其它 400 照旧抛错。
- **⑧ 401 一码三义**：真 token 问题带 `WWW-Authenticate: Bearer error="invalid_token"`，封禁/权限不足（术语表写入需 member 且注册满 30 天）不带。修法：`SiteClient.#unauthorizedError` 按响应头分流——带 → `code='unauthorized'`（触发 need-auth 自愈）；不带 → `code='forbidden'`（不触发 need-auth、不中止不重试、按业务失败报原由）；`lg-align.mjs` 的 `isUnauthorized` 只认 `unauthorized`。

测试：`lg-align-test` **49/0**（+11：新旧空行变体、卷标题块、标记章严格/宽松、标记后章不错位、非标记文本不误判、标记章跳过上传、文库 0 请求 + 提示、权限类 401、整行标记后瞻（正文首行恰为标记串不误判）、文库命中站点格式短路（0 请求、不空转退避）、回读双侧标记不同如实报不一致）、`daemon-test` **151/0**（+6：术语表 400 幂等、401 分类三例（`invalid_token` / 裸 `Bearer` / 不带该头）、mock 保真两条（401 车道经真实 HTTP 分流 / PUT 内容未变返 400），原「HTTP 状态错误不重试」用例改写为「裸 401 → forbidden 码」）、`translate-test` **25/0**（+1 文库字段归一 + `planTargets` 三档）、`engine-test` 98/0、`quality-test` 38/0、`proxy-test` 32/0；浏览器车道 `.e2e-daemon-sync.js` 23/23（+5 会话键回落链）、`.e2e-workspace-backup.js` 48/48（+8 BETA 双仓分写）、`.e2e-lg-gui.js` 51/51（契约 + 站点格式 + 回读三段，mock 车道）。mock 同步改严：导出夹具带新格式空行与 `GPT翻译缺失。` 标记章、文库 translate-v2 只回 `glossaryId`、术语表 PUT 内容未变返 400、新增两条 401 车道（带/不带 `WWW-Authenticate`）。文档：新增 `docs/upstream-sync.md`；spec-02（`keysForPath`/会话键）、spec-04（BETA worker/任务归属）、spec-10（PUT 400 幂等）、spec-11（会话键 + 401 分流）、spec-13（站点格式对齐/标记章/文库不适用）与 `docs/architecture.md`、`README.md`、`daemon/README.md`、`AGENTS.md` 同步更新。

### 用户脚本

- **「工作区备份」模块：站点工作区的翻译器 + 任务队列可导出/导入**（新模块 + 新覆盖层面板；契约 `docs/cleanroom/spec-02-helper-layer.md` §5.1/§5.2）。覆盖三个 localStorage 键 `workspace-gpt` / `workspace-gpt-pipeline` / `workspace-sakura`（老镜像域键名 `sakura-workspace` 也认，导入落到本域实际在用的键），可选把脚本自己的术语队列（IndexedDB）一起打包成一份文件。
  - **文件格式 v1**：`{kind:'ntr-workspace-backup', version:1, sourceKeys, keysOmitted, stores:{gpt,gptPipeline,sakura}, scriptQueue?}`；数组元素逐字段原样带出（`concurrency`/`profile`/legacy `type`/记录 `progress`），除「不含 API key」的掩码外不做任何规范化 —— 导出→导入逐字段还原。
  - **导入语义对齐站点**：翻译器按 id 合并（upsert）或整表替换；队列按 `task` 串对账 —— 同名且本地未完成 → 跳过、同名已完成 → 覆盖（站点 `workspaceJob.ts` 语义），`uncompletedJobs` 同 task 覆盖（站点 `addJobRecord` 语义）；**镜像站点的加载期迁移**（GPT 库丢 `type:'web'`、Sakura 库删 `testContext` 并把 `testSegLength` 转 `segLength`）；掩码备份的空 key **不吃掉本地凭据**；`assertWorkspaceBundle` 校验不过就一个字节都不写；应用前自动下载当前状态快照作回滚点。
  - **面板**：概览（三个键的翻译器/待排队/已完成记录 + 术语队列任务数）、分区勾选导出（含/不含 key）、文件或粘贴导入、**预览差异**（新增/覆盖/不变/跳过/删除计数 + 跨域键映射与迁移提示 + 每条任务按站点 `TranslateTaskDescriptor` 渲染成可点书链接）、合并/整表替换两种模式。
  - 顺带修掉一处判断缺陷：合并时「同 id 同内容」原本用 `JSON.stringify` 比较（比键序），换个写入顺序就会被误判成「覆盖」并白写一遍 —— 改为顺序无关深比较 `StorageUtils.deepEqual`。
  - 测试：新增 `.e2e-workspace-backup.js` **40/40**（结构/忠实性/掩码与 key 保留/合并与替换/迁移镜像/跨域键映射/StorageEvent 派发/异常不写数据/面板通）；回归 `.e2e-translator-mgmt.js` 18/18、`.e2e-backup.js` 15/15、`.e2e-queue-glance.js` 9/9、`.e2e-workspace-sync.js` 29/29、`.e2e-translator-copy.js` 18/18、`.e2e-sync-storage.js` 7/7、`.e2e-panel-basics.js` 30/30、`engine-test.mjs` 98/0；`.e2e-config.js` 的「模块集合」基线原先取自**存储里那份（可能是旧版本的）配置**，加了新模块就会假红 —— 改为以当前实例（代码）的模块集为基线（该套件要钉的是「拿老配置重载后模块集合不丢不加」）。
  - **真机验收（n.novelia.cc，9333 测试 profile + TM）**：按交付流程 `gen-dev` → TM 点「重新安装」→ `tools/.probe-tm-hash-ws.mjs` 取到的存储正文 sha256 与本机 dev 构建**整文件一致**。`tools/.probe-wb-live.js`（只读探针式验收脚本，跑完自动还原）在 `/workspace/gpt` 上面板点击驱动 **16/16**：概览读到真键名（本域只存在 `workspace-gpt`，另两键标注「本域无该键」）；导出（复制 JSON）与 localStorage 逐字段一致；**合成条目 + 合成 `StorageEvent` → 站点页面列表即时出现该翻译器与队列任务**（站点的 `useLocalStorage` 确实吃我们派发的事件——「写 localStorage 让站点感知」这条链路在真机成立）；删掉队列任务后导入快照**逐字段还原（含 key 与 record 的 `progress`）**；预览给出「队列 新增 1」与可点书链接；应用后站点列表照旧；**全程指向站点 origin 的非 GET 请求为 0**。测试后 `workspace-gpt` 还原为原值（45 字节空工作区）、下载的快照文件已删。注：测试期间该测试 profile 的站点会话失效（站点自己在 401 后清掉 `auth-v2`，页面转登录页）——与本次改动无关（新增代码零 auth 读写，已 grep 验证：新增段里 `auth` 出现 0 次），需要时在测试 profile 重新登录；日常 profile 不受影响。**事后查明**：那次 401 的真因是站点把会话键换成了 `web-kit:session:v1`（见上方「上游同步」①）——当时脚本只读 `auth-v2`，读到的是遗留旧值。

### daemon

- **LG 导入三件套（折叠空行容错对齐 / 提交后回读校验 / 401 断点续跑监测）＋ 传输层 curl 兜底**。起因是一次真机整本提交（`web:syosetu/n5731ie`，449 章 23 万行）：站点「下载原文」经某工具翻译后**连续空行被折成单个空行**（译文 232393 行 vs 站点 236141 行，非空行数完全相同），严格模式按绝对行号切片必然错位、整本被拒；提交中途站点会话抖动返回 401，旧实现把它当普通单章失败逐章吞掉（最终 run 记 done、GUI 显示「上传 0 失败 0」），且重跑全量重传；提交完想知道站点上到底有没有、是不是这份，也没有任何工具。四件事一起补齐：

  - **① 折叠空行容错对齐（`convertSiteFormatLoose` + `splitBlocks`）**：严格模式失败后自动回落「块序 + 非空行映射」——`splitBlocks` 按 `# 标题` 切块（块序号在站点原文与译文两侧一一对应，卷/分组标题各占一块），原文块**块内锚定**（标题后 1/2/3/4 行起取 `count` 行且 sha1 命中，并要求块内剩余行全空——否则窗口会探进下一块，这是首版实现踩到的坑：卷标题块正文为空，±2 窗口会误配到下一章），译文块按块序号取非空行，要求两侧非空行数一致，再把译文非空行按序铺回原文段落数组（空段落原位回填空串）。硬校验不打折：块数一致 / 逐章原文 sha1 / 逐章非空行数一致 / 重建行数 == 清单行数，任一章不过即整体拒绝。`alignLgResult` 报告 `convertMode: 'strict'|'loose'` 与「已识别站点导出格式（折叠空行版）：按块序 + 非空行映射对齐 N 章」。**真数据实测**：n5731ie 的折叠空行版译文经此路径重建后与站点实际内容逐章 **449/449 一致**（462 块、13 个卷标题、含首段为空段的章）。
  - **② 提交后回读校验（`verifySubmitted` + `lg-readback` 队列任务 + GUI）**：抓站点 `mode=zh&translations=gpt` 整本译文（`SiteClient.getBookZhText` 加 `translator` 参数，web 一次 11MB 级请求 / 文库逐章拼 `oldParagraphZh`）与本地 txt 逐章比对非空行。本地侧支持契约格式（按清单 `start/count` 切片）与站点导出格式（块序）；站点侧「有正文的块」按序对应清单章节（缺清单则抓 TOC 定顺序），两侧章节数不符即拒绝（不猜）。输出 `N/M 章一致` + 不一致章首差行（本地 ↔ 站点片段）+ 站点侧假名残留行数；结果落 `runs(job='lg-readback')`，控制台项目卡「回读校验」按钮与导入面板入口（面板顶部显示「断点：已提交 N 章」，来自新增 `GET /lg/import-state`）。站点标题与本地译名不同译法也能对上——这就是不按标题、按块序比对的原因。
  - **③ 401 断点续跑监测**：`verifyImport` / `applyImportReport` 对 401 先原地退避重试 2 次（8s，覆盖会话抖动），仍 401 立即**中止本批**并返回 `needAuth` / `stopped:'need-auth'`（旧实现把 401 逐章 catch 成「章节获取失败」，N 章各发一次无效请求且最终 run 记 done）；runner 随即置 `book.state='need-auth'`、**自动置 `config.authRequest`**（等于帮你点了「从站点同步」——站点页面开着时油猴 ≤5s 重推新 token）、进度打 `phase:'need-auth'`、`finishRun('failed', {needAuth,uploaded,pending})`。**断点**：逐章提交成功后把「章 id + 译文内容 sha」写 `chunks`（键 `lg-import-state`，`forgetBook` 一并清），重跑跳过内容一致的已完成章（内容变了 sha 变 → 自然重传，自愈；统计与进度里显示「断点跳过 N 章」）。控制台：项目卡红标「凭据失效」+「重新同步凭据」（把设置页的请求+轮询逻辑抽成 `requestTokenSync()` 复用）、导入面板 `phase:'need-auth'` 渲染 +「继续提交（跳过已完成章）」按钮、任务页队列行显示 `progress.message`。
  - **④ 传输层 curl 兜底（`daemon/curl-fetch.mjs` + `proxy.mjs`，默认开、可关）**：本次实测 **Node/undici 经 Clash 6789 访问 n.novelia.cc 会被稳定 ECONNRESET**（连打 8 次全失败；同代理 curl 成功率约 85%，`/proxy/test` 直连/代理两列都红）——不修的话 GUI 上这些新功能在真机网络下点不动。`isTransportError` 只对传输层失败触发（HTTP 状态错误与调用方 abort 不触发），用 curl 子进程把同一请求重发一次（`-L` 跟 302、`--retry`、`--max-time`、走同一代理/直连判定、`signal` 中止 kill 子进程），回落时打「[proxy] undici 传输失败（ECONNRESET），回落 curl 传输（经代理 …）」；curl 不存在或也失败时保持原错误（`TypeError('fetch failed')` + `cause.code`，调用方分类不变）。开关 `config.proxy.curlFallback`（「网络代理」区块），`POST /proxy/test` 回 `curlFallback`/`curlAvailable`。**实现要点**：必须用**异步 spawn** —— 首版用 `spawnSync` 把事件循环堵死，同进程的 daemon HTTP 服务与测试假服务器都收不到请求，curl 干等到超时（proxy-test 里 90s 卡死暴露）。
  - **测试与夹具**：mock 补 `mode=zh` 整本译文导出 + `POST /chapter/` 提交内容回读（`transUploads`，chapter-task 的 `oldParagraphZh` 与 `mode=zh` 都回读提交内容）；`daemon/lg-align-test.mjs` **38/0**（+21：宽松对齐 7 / 401 收口 5 / 回读校验 5 / runner 断点与 need-auth 4）；`daemon/daemon-test.mjs` **145/0**（+4：站点格式同内容重跑断点全跳过 / 内容变化全部重传 / `GET /lg/import-state` / `lg-readback` 端到端与差异报告，原「站点格式全量提交」用例改写为断点语义）；`daemon/proxy-test.mjs` **32/0**（+6：`isTransportError` 分类 / `curlFallback` 归一化 / undici 失败回落成功 / `createCurlFetch` 走测试代理 + 302 跟随 + POST 体 / 开关关闭不兜底 / `noRetry` 不触发）；`quality-test` 38/0 与 `/ui` 内嵌脚本守卫全过。GUI e2e 钩子 `tools/.e2e-lg-gui.js` 加 `readback-open`/`readback` 阶段（`all` 一把跑完含回读段）。
  - **非目标**：`verifyImport` 的拦截门槛不变（不加假名/未翻比例硬拦，只在回读报告里显示）；不做多书批量回读；不动油猴脚本（need-auth 仍走既有凭据推送链路自愈）。

- **翻译请求带「参考上文/参考下文」（相邻段上下文；默认关闭）**：语义镜像 LinguaGacha v0.125.0 的 `preceding_lines_threshold`（`planning/translation-planner.ts:21,265-293` 的句末标点门槛：从上一段末尾往前收**以句末标点结尾的连续行**，遇不达标行即停、可跨段回溯、最多 N 行），「参考下文」（LG 没有的方向）为对称扩展：往后收到句末标点为止（含该行）。渲染成 user 消息里的两块（`【参考上文】（只用于理解语境，不要翻译，也不要出现在输出里）：` / `【参考下文】（同上）：`，位于术语表之前；system 提示一字不动），块内行首 `#` 转全角防止被 `#n:` 解析器误认。开关：控制台「设置 → 翻译上下文」（`config.translate.contextBefore/contextAfter`，0–20，0 = 关闭）+ CLI `--context-before/--context-after` + `/run options` 单次覆盖。
  - **零行为变化的默认**：关闭态用户消息与旧实现逐字相同（`translate.mjs` 纯函数用例钉住）；段缓存键**仅在上下文非空时**追加上下文分量 → 关闭态与旧键逐字相同（零缓存流失），「关闭 → 打开」会让已缓存段重译一次（「打开 → 关闭」旧键仍命中）。`daemon-test` 新用例同时钉住「只有上下文真正变化的段才重发」。
  - **两处刻意偏离 LG**：① 双向（LG 只有上文）；② **③ 条目级补发重试也带上下文**（LG 重试丢上下文——补发只剩缺行时上下文最有用）。术语表激活仍只看正文行命中（上下文不参与）。
  - **真机预演（只读探针 `tools/.probe-context-preview.mjs`，零写入/零 LLM 请求）**：真站点 `web:syosetu/n7608cw` 前 3 章实测 —— 正文行以句末标点结尾的比例 **326/359（90.8%）**；上文 2 行 / 下文 1 行时 **14 个段里 10 个带上文、11 个带下文**（每章首段天然无上文），上下文累计 19 + 11 行，user 消息字符 **14001 → 15640（+11.7%）**，正文行数与上传契约不变；章内只有 1 个段时上下文无用（1500 字符/30 行没到限的短章），多段章才受益。
  - 测试与夹具：`translate-test` 24/0（+7：关闭态逐字不变 / 块渲染与 `＃` 转义 / 单行段尾部不受影响 / 句末门槛与上限 / 跨段回溯与章首章末 / 下文对称与空行 / 首轮与补发都带上下文）；mock 新增 `mock-ctx` 夹具（40 段短句 → 30+10 两段）与 `/__stats` 的 `lastTranslate.context`、`translateLog`（最近 5 条）；`daemon-test` 141/0（+5：缓存键三种切换 + config 生效 + `/settings` translate 往返与 0–20 夹紧）；其余纯函数套件（quality 38/0、agent 23/0、lg-align 17/0、agent-skills 13/0、processors 11/0、prompt 10/0、glossary-io 7/0、proxy 26/0）全绿。
- **站点请求重试次数可调**：控制台设置页「站点与凭据 → 站点请求重试」0–8（`config.site.retries`，默认 3，保存即生效）；实测整本 167 章逐章抓取时约 1/3 请求首发失败、3 次重试每轮仍剩 2 章左右，调到 8 次基本清零。
- **LG 译文导入支持站点「下载原文」格式（mode=jp）**：站点简介页下载的整本 txt（书名/作者/标签/统计 → `############` → 简介，之后每章 `# 标题` + 空行 + 正文）经 LinguaGacha 翻译后仍是同格式，以前会被「行数不符」拒绝。现在 `/lg/verify`、`lg-import` 队列 runner、CLI `import-lg` 与 Agent 工具 `import_lg_result` 会在「行数不符且文本像站点导出」时**自动抓站点原文逐章 sha1 对齐**（卷/分组标题占两行的 ±2 偏移窗口、逐段空/非空模式校验；任一章对不上即拒绝，绝不输出错位数据），契约格式路径零额外请求；抓原文是 2MB 级请求，链路抖动时**分轮重试**、全轮失败把原因带进错误消息（不再只报「行数不符」）。控制台校验报告标注「已识别站点导出格式（mode=jp），并抓站点原文逐章 sha1 对齐 N 章」，队列 stats 带 `converted`。顺带：清单 `book.key` 与当前项目不一致时直接拒绝（防串项目）。新纯函数 `convertSiteFormat` / `fetchSiteExportLines` / `alignLgResult` 在 `lg-align.mjs`（lg-align-test 17/0，+7）；mock 补 `mode=jp` 夹具（与 chapter-task 同源）、daemon-test 129/0（+2：`/lg/verify` 站点格式自动对齐 3/3、`/run lg-import` 站点格式全量提交）；`tools/.lg-import-sitefmt.mjs` 改为复用同一内核。真机验收（控制台 GUI 点击脚本，非命令行）：`web:syosetu/n7608cw` 导出 34651 行 / 167 章 → 选站点格式 txt 校验 **167/167 章通过**（带自动对齐提示）→ 提交 5 章队列 done（uploaded 5 / failed 0 / converted=true），证据在 `daemon/exports/backup-n7608cw-*/`。
- **站点请求传输层重试**：`SiteClient` 对网络层失败（`ECONNRESET` / `fetch failed` / 超时）默认重试 3 次（退避 300ms×n，`onRetry` 让 CLI 打出「站点请求失败，重试 n」）；HTTP 状态错误（401/400/404/5xx）不重试，语义不变（章节提交与术语表 PUT 都是内容幂等的整章/整表写）。墙内站点只经代理可达、链路抖动频繁——实测整本导入的逐章校验通过率由此从 115/167 升到 165–167/167；测试 daemon-test 129/0（+4 用例：重试后成功 / 耗尽即抛 / 401 不重试 / PUT 重试幂等）。
- **网络代理（出网）**：控制台设置页新增「网络代理」区块（第八个）——站点 API、翻译池、助手/术语池与 Agent 工作区沙箱脚本的出网统一走本机代理（HTTP 绝对形式 + HTTPS CONNECT 隧道，支持 `user:pass@` 凭据）；**保存即生效**，无需重启（未用 Node 内置 `NODE_USE_ENV_PROXY`——它只在进程启动前解析且首值缓存）；直连列表默认 `127.0.0.1,localhost,::1`（mock/测试零影响，关闭时行为与旧版一致）；「测试」按钮做「直连 / 代理」对比探测（`POST /proxy/test`）；不支持 SOCKS5。

### LG 对齐六项（②⑥①⑤③④）

- **② 技能带可执行脚本**：`read_skill` 返回值新增 `baseUrl`（技能包目录的 `file:` URL）——agent 在 `workspace_run` 沙箱里可用 `await import(new URL('scripts/xxx.mjs', baseUrl).href)` 加载技能自带脚本（对齐 LG 的 `matchLiterals` 模式）；沙箱 execArgv 把内置技能根（repo `skills/`）加进 `--allow-fs-read` 白名单（只读——写内置包撞权限模型天然拒绝，用户技能根仍读写）。现有技能包全是纯文档，属纯使能基建（手测：白名单下 import 成功、去掉即 `ERR_ACCESS_DENIED`）。
- **⑥ quality-workflow 审校技能充实（纯内容）**：七码表每码补「取证命令」列；新增「审校循环」节——批量取证优先 `workspace_run` 扫 `warnings/entries.jsonl`（无绑书回落 `list_warnings` 分页）、自启发种子循环 + 种子账本 `work/review-seeds.json`（LG 同构：`completedRounds` + `seeds.{轮次:[{pattern, consumed}]}`，每轮必须更新、禁止跨轮补写、≥3 轮收敛）、处置映射（个别行 → 修句**提案**、整章 → `run_check` 复核后建议 `run_translate` expire 档、术语类 → 转 glossary-workflow、`RETRY_THRESHOLD` → 只读人工）、汇报规范（只挑重点码 + 落地率口径引用 acceptance-scan）；新增 `references/review.md` 七码逐节（判据 → 误报排除 → 处置）。红线写明：只产提案，不直写译文。
- **① ask_user 倒计时默认项（默认值变化）**：追问超时不再一律取消，而是**默认选第一项**（LG 行为；可在「设置 → 助手参数」关掉，关掉 = 维持超时取消）；审批（write）超时行为不变（仍拒绝）。控制台决策卡片新增倒计时提示（「N 秒后将默认选：<第一项>」，归零变「正在按默认项继续…」），超时值由 `/agent/config` 下发（`questionDefaultFirst` / `decisionTimeoutMs`，循环层现值优先）；`setOptions` 白名单加这两个键（布尔 / ≥5000 数值），`/settings` 保存即生效。daemon-test +2（超时默认选第一项 → `decision allowed` + 工具回填 `{"selected":"a","reason":"timeout_default"}`；关闭 → 维持 `ask_cancelled`）。
- **⑤ 调度器自动并发伸缩（默认值变化）**：`maxInFlight` 填 **0 = 自动伸缩**（起步 4，连续成功 `autoRampEvery`（默认 10）次 +1，上限 16；429/503/`retryAfterMs` 减半，下限 1）——此前 0 被 `|| 1` 吞成 1。许可池改档抽 `_setAutoLimit` 供固定/自动共用，`setOptions({maxInFlight:0})` 可热切；`stats()` 在 auto 档显示当前动态许可（并带 `auto` 标志，控制台状态页显示「并发自动（当前 N）」）；修掉设置链路三处 0 被吞（index 两池初始值、`server.schedulerOptionsFrom`、控制台两个保存按钮 + 输入框 `min=0`），说明文案补「填 0 = 自动伸缩」。daemon-test +2（429 后 4 → 2；`autoRampEvery=2` 时 3 次成功 → 5，热切回固定档 2 立即生效）。
- **③ 条目级对账重试**：段内**部分行**解析失败不再整段重来——新增 `parseTranslateAnswerPartial`（命中行 + 缺失行清单，语义与 `parseTranslateAnswer` 逐条一致；原函数一字不动），`translateSegment` 重试循环升级为补发模式：只对缺失行重编号组段补发（`#1..#M` 协议不变），补发计入同一 retry 上限（3 次），空行原样保留不占编号，合并输出长度恒等输入；全失败（一条编号都没对上）走原路径（普通重试、不触发二分），二分兜底与「显式行数检查」可达性同旧实现。**红线**：站点原版是整段重试，此处为内部优化偏离（仅解析部分成功时触发，上传契约与段缓存键不变）。translate-test 17/0（+4：部分缺失只补缺失行且补发请求只有 1 行 / 全失败走旧路径 / 补发耗尽 3 次后失败 / `parseTranslateAnswerPartial` 语义对照；另把原「连续失败 3 次」用例改写为「只补缺失行后成功」并补「空行不占补发编号」）。
- **④ 空行不进请求（探针实测后实装）**：新增只读探针 `tools/.probe-empty-paragraphs.mjs`（`SiteClient` 抓库内第一本书前 N 章统计空段，零写入）——实测真站点 `web:syosetu/n7608cw` 前 3 章 **557 段里 198 段为空（35.5%）**，推翻「站点 paragraphJp 无空段」的旧推断（LG 对比里的空行差异不止存在于本地 txt 摘录）。据此 `translate-pipeline.mjs` 分段前过滤空段（不占编号/token）、提交前原位回填（`translate.mjs` 新增 `splitEmptyParagraphs` / `mergeEmptyParagraphs`；上传段数与顺序不变）；mock 补 `mock-empty` 空段夹具、daemon-test +1（上传 4 段含 2 空段原位回填、请求只带 2 个非空行）、translate-test +1。结论与证据已回写 `docs/lg-compare.md`（三.5 与第四节第 2 条）。

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
