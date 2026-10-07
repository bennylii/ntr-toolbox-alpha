# spec-12：Agent 工作区 / CodeAct（行为规格）

借鉴对象：LinguaGacha `docs/AGENT_RUNTIME.md`、`src/backend/agent/workspace/*`（契约与沙箱思路，独立实现；零依赖化）。
实现位置：`daemon/agent-workspace.mjs` + `daemon/workspace-bootstrap.mjs`（工具与沙箱）、`daemon/agent-loop.mjs`（注册）、控制台/CLI 皆可用。
定位：给 Agent 一个「写脚本批处理数据 + 变更清单事务提交」的工作区，替代逐条工具调用；读批数据不进对话上下文。

## 1. 工作区布局（`daemon/work/<sessionId>/`，已 gitignore）

```
contract.json            契约（数据集/变更/apply；运行时冻结为 ws.contract）
project_meta.json        当前项目（绑书会话的书 key/标题/状态/进度）
progress|rules|glossary|warnings|runs/entries.jsonl   数据集快照（JSONL，行内带 fp）
prompts.json             全局提示词四槽（text/fp；默认槽 text=null 也有 fp）
reference/workspace.md   由同一份 schema 表生成的参考文档
changes/<域>/<op>.jsonl  唯一可写区（提交意图）；workspace_run 启动时清空重置（LG 同款）
work/runs/<12hex>/       script.mjs + stdout.log + stderr.log（跨调用保留）
work/runtime/bootstrap.mjs  子进程引导（从模块目录拷入——沙箱只可读工作区）
```

- 快照策略：每次 `workspace_run` 重建数据集 + 清空 `changes/`；`work/` 保留；
- 通用会话（未绑书）没有工作区：`workspace_needs_project`。

## 2. workspace_run

- 参数 `{script}`（完整 ESM JS）；执行：`fork` + `--permission`，execArgv =
  `--allow-fs-read=<root>`、`--allow-fs-write=<root>/changes`、`--allow-fs-write=<root>/work`、
  `--import=<bootstrap>`；env `NODE_OPTIONS=''`（剥继承旗标）；cwd = 工作区根；stdio = `[ignore, stdoutFd, stderrFd, ipc]`（子进程直写日志文件）；
- **沙箱边界**：可读整个工作区、可写 `changes/` 与 `work/`；子进程/worker/原生扩展被 Node 权限模型默认拒绝；**网络开放**（与 LG 一致，契约中注明）；120s 超时 SIGKILL；abort 信号同终止；
- **ws API**（bootstrap 经 IPC 桥接，父进程逐请求校验、非法即杀）：
  - `ws.contract`：契约对象（contract.json 的冻结视图）；
  - `await ws.doing(text)`：进度直达助手页（≤200 字符）；
  - `await ws.read({kind:'read', subkind:'chapter', chapterId, volumeId?})`：站点章节 `{paragraphJp, oldParagraphZh, glossaryId}`（不落盘，按需拉取）；
- 握手：bootstrap 阻塞等待 `{type:'start'}` 后再放行主脚本；disconnect 即退出（防孤儿）；请求期间 ref 通道、空闲 unref（脚本自然退出）；
- 返回 `{scriptPath, exitCode, signal, stdout:{path,bytes,content?}, stderr:{...}}`：单流 >64KiB 只给路径（全量在日志文件）；stdout 可解析为 JSON 时解析为对象；
- 语义：每次调用独立进程，跨调用数据靠文件；脚本失败/超时已完成的文件写入保留。

## 3. 数据集与 fp

- 行内 `fp` = `sha256(JSON(行对象)).base64url.slice(0,4)`——快照时算好随行携带，提交时重算比对（对象漂移检测）；
- `prompts` 数据集：默认槽也给出 fp（`text:null` 语义），使「首次设值」可核对漂移；
- `glossary` 行携带站点原始 value（含 `#备注` 格式）。

## 4. workspace_apply

- 参数 `{}`——变更意图全部在 `changes/<域>/<op>.jsonl`（模型由脚本预先写好）；
- 变更域 v1：`rules`（creates/updates/deletes，identity=id）、`glossary`（creates/updates/deletes，identity=src；提交时合并 → 快照 → 全量替换 → 回读校验）、`prompts`（updates/deletes，identity=kind，全局槽）；
- 流程：解析（逐行 schema 校验，坏行 → `invalid_change`）→ 对照当前事实（`target_missing` / `fp_mismatch` / 同批同 identity 冲突 → `merge_conflict`；creates 撞已有 src → `merge_conflict`）→ 预览摘要（**审批预览 = 实际提交差异**）→ 审批（requiresApproval；manual 走 decision broker）→ 逐 op 提交 → 回执；
- 回执 `{status: 'applied'|'partial'|'rejected'|'unchanged', applied:{rules,glossary,prompts}, rejected:[{scope,op,reason,line,id/src/kind,message}], destroyed, results}`；
- `destroyed`（出现 fp_mismatch/target_missing）或全量成功 → 清空 `changes/`（前者表示快照过期，下轮 run 重建）；`partial` 保留清单供修复重提；
- 与翻译任务单队列互斥（`queueBusy()` 拒绝）；章节译文提交**不经过工作区**（用 `run_translate` / `import_lg_result`）。

## 5. 边界与刻意差异（对 LG）

- 无 `ws.emitImage` / PDF host / sources 投影（场景不存在；契约注明）；
- 无预装 npm 包树（脚本只用 Node 内置能力）；数据经 `ws.read` 按需拉取而非全量落盘快照（站点数据在远端）；
- LG 的 `retry_count`/item 模型不适用（我们按章对齐对检查）——质检证据走 `warnings` 数据集。

## 6. 验证对照

- daemon-test「Agent 工作区」段 7 例：run 全流程（读数据集/doing/read 章节/写 changes）、沙箱双拒（写工作区外 / child_process）、applied 全绿批（含回读校验）、fp 漂移 → rejected+destroyed+清空、partial、坏 JSONL 行拒好行提交；
- 「/ui 内嵌脚本可解析」守卫同样覆盖工作区页面提示文案变更。
