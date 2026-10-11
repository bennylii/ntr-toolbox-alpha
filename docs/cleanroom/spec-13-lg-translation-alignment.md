# spec-13：LG 译文对齐导入（export-src / import-lg / GUI）（行为规格）

借鉴对象：LinguaGacha `src/backend/file/txt/txt-format.ts`（TXT 一行一 item、空行亦 item、写出逐行 join、空译文回退原文——**结果行号与输入天然一致**，这是对齐成立的前提）。
实现位置：`daemon/lg-align.mjs`（纯函数 + 队列 runner）+ CLI `export-src` / `import-lg` + 控制面 `POST /lg/export|upload|verify`、`/run job=lg-import` + Agent 工具 `export_lg_source` / `import_lg_result`。
定位：不用 daemon 内置翻译时，把站点原文导出给 LinguaGacha 翻整本，再把结果**按行号对齐**导回站点 GPT 端；对不上就拒绝，杜绝错位提交。

## 1. 导出（export-src / /lg/export / export_lg_source）

- `collectChapters`：按 translate-v2 toc 顺序取全章 `paragraphJp`（与翻译器无关）；
- `buildSourceExport`：全书段落按序拼接为「一行一段」纯文本（`linesTotal`）+ 清单 `manifest {version, book:{key,kind,providerId,novelId}, linesTotal, chapters:[{chapterId, volumeId, title, start, count, jpSha1}]}`（jpSha1 = 该章原文 join 后 sha1）；
- 文件：`daemon/exports/lg-src-<书名>.txt` + 同名 `.manifest.json`（同名覆盖，清单同步更新）；单队列忙时拒绝导出。

## 2. 导入校验（import-lg dry-run / /lg/verify）

结果行解析 `splitResultLines`：容忍 BOM / CRLF / 末尾换行。三层校验：

1. **总行数** = 清单 `linesTotal`，不符 → 全局拒绝（`globalError`，无任何章映射）；
2. **每章**：切片行数 = 清单 count，且空/非空模式与站点当前 `paragraphJp` 逐行一致（行错位检测）；
3. **每章源 sha1** 与导出时一致（源站更新/漂移 → 该章拒绝）。

附加统计：`疑似未翻` = 结果行 === 原文行且非空（LG 空译文回退原文的特性）——dry-run 报告先看这个数再提交。
通过章携带 `{glossaryId(站点当前), paragraphsZh}` 供提交；未过章 `paragraphsZh=null`。

### 2.1 站点「下载原文」格式（mode=jp）自动对齐

站点简介页「下载原文」拿到的是另一种 txt：头部（书名/作者/标签/统计）→ `############` → 简介，之后每章 = `# 标题` + 1 结构空行 + 逐段正文，章块之间还有结构空行；卷/分组标题自身也占「`# 标题` + 空行」两行（它们没有章条目）。经 LinguaGacha 翻译后仍是同格式（LG 保行数），所以可以折回契约行数组：

- **触发条件（保守，不误伤契约格式）**：结果行数 ≠ 清单 `linesTotal`，且文本里出现 `############` 或 `^# ` 标题行；满足才抓站点原文（`GET .../file?mode=jp&filename=jp.<novelId>.txt`，一次 2MB 级请求）；
- **对齐规则** `convertSiteFormat({zhLines, jpLines, manifest})`：从首个 `# ` 行起，每章按「标题 + 跳 1 空行 + count 段」定位，并在 ±2 行窗口内用**逐章 sha1** 找回块起点（卷/分组标题顶掉两行时兜底）；随后逐段比对空/非空模式。**任一章对不上即整体失败**（返回 `{ok:false, reason}`），绝不输出错位数据；
- **输出**：与 `export-src` 契约完全等价的「一行一段」行数组（内存，不落盘），交给同一套三层校验与提交路径；
- **失败语义**：抓原文是 2MB 级请求，代理链路抖动时容易整场失败 → `alignLgResult` 按轮次重试（默认 3 轮 + 轮间歇），全轮失败把原因放进 `alignError`：runner 抛「…（站点格式自动对齐失败：fetch failed——代理链路抖动时稍后重跑）」、`/lg/verify` 回 `convertError` 由面板显示，而不是只报「行数不符」；
- **Callers 一致**：`/lg/verify`、`lg-import` runner、CLI `import-lg`、Agent `import_lg_result` 共用 `alignLgResult`；契约格式路径**零额外请求**；
- **清单归属**：`manifest.book.key` 与当前项目不一致时直接拒绝（防串项目）；
- 离线转换 / 逐章诊断：`node tools/.lg-import-sitefmt.mjs --book <key> --zh <LG译文.txt> --manifest <清单.json> [--jp 快照] [--out 结果] [--report 诊断.json]`（与 daemon 同一内核）。

## 3. 提交（import-lg --apply / /run job=lg-import / import_lg_result）

- 逐章 `uploadChapter`（spec 契约：`{glossaryId, paragraphsZh, sakuraVersion:'0.9'}`，段落数严格一致）→ 站点与 daemon 均视为「GPT 工作区已译」；
- `limit N` 限量；失败章记录并继续；`未过校验` 章跳过；
- **GUI 路径**：`/lg/export` → 用户在 LG 翻完 → 面板上传结果 txt（`/lg/upload`：≤20MB、扩展名 txt/json/md、文件名消毒 → `uploads/`）→ `/lg/verify` 渲染逐章报告 → 「提交通过章」入队 `lg-import`；
- 队列 runner（`createLgImportRunner`）：读文件 → 校验（复检）→ 逐章提交（进度经 job-queue `progress` 通道：verify → 提交中 x/y（失败继续）→ done 摘要）→ run 记录落库；
- 单队列与翻译互斥；文件路径白名单：`exports/` 与 `uploads/` 之下（防任意文件读）。

## 4. Agent 工具

- `export_lg_source({book, out?})` 自动执行（写 `exports/`，返回路径与行数）；
- `import_lg_result({book, txtPath, manifestPath, apply, limit})` **需审批**：preview = 完整校验报告（不下发译文全文），execute = 校验 + 逐章提交。

## 5. 边界

- 前提是「LG 不增删行」；任何行数/空行模式/漂移都会被三层校验拦下，**宁可拒绝不错位**；
- 上传的副本保留在 `uploads/` 供复核（手动清）；`exports/` 同名导出覆盖；
- 章节译文提交只走本规格或翻译管线（spec-06 关联），工作区 CodeAct 不做章节写。

## 6. 验证对照

- 纯函数 `lg-align-test.mjs` 17 例（导出行映射、清单结构、解析容忍、全对齐、疑似未翻、三类拒绝、漂移、章失败 + 站点格式 7 例：识别/头部与卷标题不误伤/空行模式拒绝/sha1 漂移拒绝/行数符零请求/不像站点格式不转换/清单串项目 fatal）；
- daemon-test「LG 导入」9 例（端点/上传白名单/校验/队列全流程/进度断言 + 站点格式两例：`/lg/verify` 自动对齐 3/3、`/run lg-import` 站点格式全量提交且 `stats.converted=true`）；
- 浏览器 e2e `tools/.e2e-lg-gui.js`：mock 车道一把跑完（契约格式 + 站点格式自动对齐两段，43 项断言）；真机车道用 `window.__LG_GUI_TEST` 分阶段（`export/open/verify-start/verify/apply/await`）+ `node tools/cdp.mjs setfiles "<选择器>" <真实 txt>` 塞盘上文件，长流程不受单条 CDP 命令超时限制。
