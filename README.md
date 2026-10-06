# ntr-toolbox-alpha

[n.novelia.cc](https://n.novelia.cc) 的油猴脚本：对 [TheNano 的 NTR ToolBox](https://greasyfork.org/scripts/527754)（All Rights Reserved）功能行为的 **clean-room 重构**，并新增一套 **AI 术语表提取 / 审核 / 队列** 管线（提示词与轮次收敛移植自 KeywordGacha），覆盖「下载正文 → 抓术语 → 预览-diff → 写入站点术语表」全流程。代码为独立实现，以 MIT 许可发布。

> ⚠️ 与 GreasyFork 上的原版 `@name` 不同、可同时安装，但两者会在同一站点各挂一个面板，同时启用会互相遮挡，建议只启用其一。

## 功能

- **AI提取术语表** — 分块 → LLM 提取 → 爬楼式轮次收敛（失败块次轮重试）；`预览 / 写入` 两种模式；翻译器下拉（读 GPT 工作区 / BETA 工作区）、临时端点（测试用）、调试日志（Console + 环形缓冲 + 导出）。
- **术语队列** — IndexedDB 持久化的任务队列：
  - 断点续跑（分块缓存，成功块不重发）、行覆盖率显示；
  - 「重试」只补没覆盖到的正文行；「重跑」整本重算；工具栏「重试未完成」一键收拢没跑完的任务（都只改状态，开跑由「开始/续跑」控制）；
  - 「筛选」（再次筛选/审计）：模型批量打「建议删」标记，预览弹层里可再筛/撤销；
  - 运行参数实时生效：并发 / RPM / 逾时 在「术语队列」设置里可覆盖（0 = 跟随「AI提取术语表」）；
  - 「运行翻译器 ▾」可对未跑完的任务整体换 worker。
- **导入术语表(KWG)** — KWG 默认 `output.json` 数组 / 扁平 JSON / `原文 => 译文` 文本 / 剪贴板 / 点选或拖入文件，统一进 diff 弹层（新增/冲突/相同/仅已有）。
- **回滚术语表** — 每次写入前自动快照（每目标保留最近 20 版）→ 选版本 → diff 预览 → 回滚。
- **站点自检** — 启动/路由切换时检查脚本依赖的「站点挂点」是否因改版变动，变动时面板角标告警。
- **Daemon 连接** — 把站点凭据（auth-v2 token）与 GPT 工作区翻译器推给本地 daemon：一键探测+同步；「自动同步」默认开（页面加载即推、token 刷新后 ≤30s 自动重推、指纹去重无变化零请求）；连接状态行 + 行尾在线/离线角标。
- 翻译器小工具：添加/删除/启动翻译器、复制翻译器到 BETA 工作区、工作区翻译器自动同步、填充术语表（可自动翻页至末页）。
- 本地 daemon（GPT 翻译 worker + 控制台 + Agent + LG 互通）见 **`daemon/README.md`**；安装后油猴会自动把凭据同步过去。

## 安装

1. 安装 Tampermonkey。
2. 安装 `ntr-toolbox-alpha.user.js`（或 `ntr-toolbox-alpha.dev.user.js`，开发构建：`@version` 带 `-dev` 后缀、无更新 URL）。

## 开发

源码就一个文件：**`ntr-toolbox-alpha.user.js`**（改了直接改它）。本地 daemon 在 `daemon/`（详见 `daemon/README.md`；架构与设计决策总览见 `docs/architecture.md`）。

```sh
node tools/.gen-dev.mjs          # 生成 ntr-toolbox-alpha.dev.user.js
node tools/engine-test.mjs       # 引擎单测（需要 mock 在跑）
# e2e 套件（在页面上下文里执行，返回 JSON 断言）：
node tools/.run-suite.mjs tools/.e2e-queue-retry-btn.js "http://127.0.0.1:8788/wenku/mock-src"
# daemon 侧测试（详见 daemon/README.md「测试」）：
PORT=8790 node mock-llm/server.mjs
node daemon/daemon-test.mjs      # 冒烟（全管线/质检/Agent/工作区/LG 导入/连接配置…）
```

### 测试环境

1. **mock LLM / 假站点**（端口 8788）：`node mock-llm/server.mjs`
   - 假上游 `/v1/chat/completions`：故障注入 `?fail=429|timeout|abort|truncate|badjson|think|empty`、序列 `?script=ok,empty,...`、`?slow=`、审计模式 `?audit=N`；
   - 假站点页面（`/novel|/wenku|/favorite` 空白页 + `/api/...` 假 DTO，正文给 `mock-src`）；`GET /__stats` 统计；
   - `/ntr-toolbox-alpha.dev.user.js` 静态路由，可直接给 Tampermonkey 安装。
2. **测试用 Chrome**（独立 profile，绝不用日常 Chrome）：
   ```sh
   chrome.exe --remote-debugging-port=9333 --user-data-dir="<repo>\chrome-test-profile" \
     --proxy-server="http://127.0.0.1:6789" --no-first-run --no-default-browser-check
   ```
   `chrome-test-profile/` 已在 `.gitignore`（含登录态，绝不入库）。
3. **CDP 驱动**（零依赖，node ≥ 22）：
   ```sh
   node tools/cdp.mjs open <url>       # 导航
   node tools/cdp.mjs inject           # 注入 ntr-toolbox-alpha.user.js（去 UserScript 头）
   node tools/cdp.mjs evalf tools/.e2e-xxx.js
   node tools/cdp.mjs shot out.png
   ```
4. `debug-env/`：离线站点页面替身（小说列表 / 详情 / 两个工作区），无网络也能开发与截图。

### 约定

- 所有写入类测试**必须拦截 `PUT .../glossary`**，绝不向线上站点写测试数据。
- 外网仅走本地代理 `http://127.0.0.1:6789`。
- `chrome-test-profile/`、`chrome-measure-profile/` 不入库。

## clean-room 重构说明

- 重构**已完成**：以 `tools/.t2s-backup.user.js`（上游 v0.7.2 原版备份，已随重构完成移除、git 历史仍可取回）作为行为 diff 基准，按「行为规格 → 独立实现 → e2e 等价验证」推进（规格见 `docs/cleanroom/`，spec-01..05 全部实施），不逐行翻译原代码。
- 上游原作的代码表达（All Rights Reserved）不进入本仓库的许可范围；重构产出的实现代码以 MIT 许可由本仓库作者所有。

## 许可与致谢

- 本仓库代码（重构实现 + AI 术语表管线）以 **MIT** 许可发布，版权归仓库作者。
- 功能设计参考了 TheNano 的 NTR ToolBox（GreasyFork 527754，All Rights Reserved），感谢原作；原作的代码版权归原作者所有。
