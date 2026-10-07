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

- 纯函数 `lg-align-test.mjs` 10 例（导出行映射、清单结构、解析容忍、全对齐、疑似未翻、三类拒绝、漂移、章失败）；
- daemon-test「LG 导入 GUI」7 例（端点/上传白名单/校验/队列全流程/进度断言）+ 浏览器 e2e `tools/.e2e-lg-gui.js`。
