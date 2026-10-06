# AGENTS.md — 给在此仓库工作的 AI 代理

## 项目概览

[n.novelia.cc](https://n.novelia.cc) 的 Tampermonkey 用户脚本 **ntr-toolbox-alpha**：对 TheNano 的 NTR ToolBox（GreasyFork 527754，All Rights Reserved）功能行为的 **clean-room 重构**，并新增 **AI 术语表提取 / 审核 / 队列** 管线。单文件用户脚本，无构建步骤、无依赖安装。实现代码 MIT（见 README「clean-room 重构说明」）。

## 结构

```
ntr-toolbox-alpha.user.js      唯一源文件（改它；没有 src/）
ntr-toolbox-alpha.dev.user.js  由 .gen-dev.mjs 生成（@version 追加 -dev、@name 加 (dev)），不要手改
tools/                         开发/测试脚本（.e2e-*.js = 页面上下文断言套件；.probe-*.js = 小探针）
docs/cleanroom/                各模块重构前的行为规格（spec-01..05，全部已实施）
mock-llm/server.mjs            假 LLM + 假站点（端口 8788）
debug-env/                     离线站点页面替身（无网络也能开发/截图）
docs/                          管线说明（html + png）
```

## 常用命令

```sh
node mock-llm/server.mjs                     # 起 mock（8788）：假 /v1/chat/completions + 假站点 /novel /wenku /favorite
PORT=8789 node mock-llm/server.mjs           # 并行车道 mock（8789，另起端口避免与他人实例抢 8788）
node tools/.gen-dev.mjs                      # 生成 ntr-toolbox-alpha.dev.user.js（交付前必跑）
node tools/engine-test.mjs                   # GlossaryEngine 单测（需 mock 在跑）
node tools/.run-suite.mjs tools/.e2e-xxx.js "http://127.0.0.1:8788/wenku/mock-src"   # 跑 e2e 套件
node tools/cdp.mjs open <url> | inject | evalf <file> | shot <png> | logs   # 直接操作浏览器（CDP_PORT 环境变量换端口）
```

测试用 Chrome（独立 profile，绝不用日常 Chrome）：

```sh
chrome.exe --remote-debugging-port=9333 --user-data-dir="<repo>\chrome-test-profile" \
  --proxy-server="http://127.0.0.1:6789" --no-first-run --no-default-browser-check
```

**并行测试车道**（有另一个会话/人在用 8788+9333 时用这套，完全隔离）：

```sh
PORT=8789 node mock-llm/server.mjs
chrome.exe --remote-debugging-port=9334 --user-data-dir="<repo>\chrome-e2e-profile" \
  --proxy-server="http://127.0.0.1:6789" --no-first-run --no-default-browser-check
CDP_PORT=9334 node tools/.run-suite.mjs tools/.e2e-xxx.js "http://127.0.0.1:8789/..."
```

注意：`chrome-e2e-profile/` 是全新 profile，**没有 TM、没有登录态**——mock e2e（走 inject）专用；TM 重装与实站验证仍走 9333 主车道。套件内把「临时端点」设到 8788 的（wenku-dryrun/tempendpoint 等）在车道上跑要先把该设置值改成 8789。

## 交付流程（改了 user.js 之后）

1. 跑相关 `.e2e-*` 套件（至少 queue 相关全绿），`node tools/engine-test.mjs` 也跑。
2. `node tools/.gen-dev.mjs` 生成 dev 构建。
3. Tampermonkey 里重装：打开 `http://127.0.0.1:8788/ntr-toolbox-alpha.dev.user.js` → 点安装按钮（测试 profile 里装的是**篡改猴测试版/Beta**）。重装后**必须刷新页面**新代码才生效。自动化点「更新」注意：headless 车道下安装对话框落在 TM 扩展的 `ask.html` 页（targets[0]），按钮是 `<input value="更新">`——按 **value** 匹配后 `.click()`。
4. 验证装上的版本 = 本地文件：`node tools/.probe-tm-hash-ws.mjs`（连 TM service worker 取存储正文 sha256），与 `ntr-toolbox-alpha.dev.user.js` **整文件** sha256 比对（去掉用户脚本头再算会不一致——TM 存的是整文件）。
5. 真机 HTTPS 页面访问本机 daemon 受 Chrome 本地网络访问（LNA）管辖：真实用户首次会看到授权提示；**headless 测试车道必须加 `--disable-features=LocalNetworkAccessChecks`** 才能自动化验证（否则 fetch 直接 Failed to fetch，daemon 侧一切正常也连不上）。

## clean-room 重构约定（已完成）

- 上游派生代码的 clean-room 重写**已全部完成**（spec-01 配置/通知/token → spec-02 helper 层 → spec-03 面板框架 → spec-04 模块定义 → spec-05 注入样式），上游原版备份 `tools/.t2s-backup.user.js` 已移除（需要行为对照时从 git 历史取回：`git show 4e993e8:tools/.t2s-backup.user.js`）。
- 若未来要从上游借鉴新功能：仍按「写行为规格 `docs/cleanroom/spec-*.md` →（缺测试则先补定格测试）→ 从 spec 独立实现 → 全套 e2e 等价验证」推进；**不逐行翻译**原版表达（结构/命名/注释全部另起）。
- 数据兼容红线（全项目期间不变）：`CONFIG_VERSION=23`、localStorage 键（`NTR_ToolBox_Config` 等）、IndexedDB 库名（`ntr-glossary`、`volumes`）、DOM id/class（`#ntr-panel` 等）、全局 API（`_NTRToolBox`、`_NTRGlossaryDev`、`_NTRToolBoxInstance`）、默认翻译器名前缀 `'NTR translator '`。

## 硬性约定（安全 / 数据）

- 外网仅走本地代理 `http://127.0.0.1:6789`。
- **绝不打开或读取用户的日常 Chrome profile / 数据**；浏览器测试只在 `chrome-test-profile/` 里做。
- 写入类 e2e 必须拦截 `PUT .../glossary`，**绝不向线上站点写 mock/测试数据**（站点规范：不要滥用术语表）。
- 每次测试后清理痕迹（队列任务、localStorage 键、弹层 DOM）。
- `chrome-test-profile/`（含登录态）永不提交；`.gitignore` 已覆盖。
- 不提交任何真实 API key；测试 key 用假值。

## 已知陷阱

- **队列 init 的 2.5s 定时器**：初始化后约 2.5 秒会把 `running` 任务改成 `pending`（不受「自动续跑」设置门控），并可能触发 `runLoop()`。测试套件要么在内存里把「自动续跑」置 false 并还原，要么在开头 `await sleep(2800)` 等它先跑完。
- **mock 的 429 会触发引擎冷却**（几秒内不再发请求），想要"失败"请用 `?fail=empty`（不冷却）。
- **`Q.put()` 不会触发队列面板重绘**：写库后要 `await Q.openPanel(); await sleep(400);` 或 `refreshPanel()` 才能点到新行的按钮。
- `?run=` 参数防 URL 缓存：同一 mock 用例重复跑时带上 `Date.now()`。
- 批量跑多个套件时偶发 `CDP timeout: Runtime.evaluate`（抖动），单独重跑一次通常即好。
- `GlossaryQueue` 状态在 IndexedDB（库名见源码），用例结束记得 `Q.stop()` + 清任务 + 移除 `#ntr-queue-overlay`。
- 新设置行/按钮在「术语队列」右键设置面板，源码里 `queueSettings()` / `jobRuntime()` 是运行时覆盖入口（并发/RPM/逾时，0 = 跟随主设置）。
- TM 的 `@match` 只覆盖真实站点域名，不含 127.0.0.1 —— mock 页上装好的 TM 脚本**不会**注入（属正常），mock 测试一律走 `cdp.mjs inject`。

## 上游与许可

功能设计参考 TheNano 的 NTR ToolBox（GreasyFork 527754，All Rights Reserved），原作代码版权归原作者；本仓库实现代码（重构产出 + AI 术语表管线）以 MIT 许可发布，版权归仓库作者。
