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
node daemon/index.mjs translate [--book key] [--level expire|normal|all] [--concurrency 2] [--max-chapters N]
node daemon/index.mjs watch     [--interval 30]    # 常驻：定期按 expire 档补翻
node daemon/index.mjs serve     [--port 7331]      # 控制面 /status /progress /auth /run
node daemon/index.mjs status
node daemon/index.mjs forget    <bookKey>
```

典型流程：`serve`（或 `watch`）常驻 → 浏览器点「同步 Daemon」推凭据与翻译器 → `add` 登记书 → `translate`。

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
MOCK_ORIGIN=http://127.0.0.1:8790 node daemon/daemon-test.mjs   # 冒烟：全管线/跳过/续跑/控制面
```
