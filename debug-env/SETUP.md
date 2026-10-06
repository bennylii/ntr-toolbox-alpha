# NTR Toolbox Alpha 调试环境搭建指南

本仓库**无需构建、无依赖安装**（单文件用户脚本 + 零依赖 daemon）。调试按三条路子走，按需组合：

## 1. mock 车道（推荐：离线、可自动化，无需站点账号）

一个进程同时模拟「LLM 上游 + 站点页面/API」：

```sh
node mock-llm/server.mjs                  # 8788 主车道
PORT=8789 node mock-llm/server.mjs        # 8789 并行车道（有别的会话在用时）
```

- 假 LLM：`/v1/chat/completions`，故障注入 `?fail=429|timeout|abort|truncate|badjson|think|empty`、`?script=ok,empty,...`、`?slow=`、审计 `?audit=N`；
- 假站点：`/novel` `/wenku` `/favorite` 页面与 `/api/...` DTO（正文给 `mock-src`），`GET /__stats` 看请求统计；
- 静态路由 `/ntr-toolbox-alpha.dev.user.js` 可直接喂给 Tampermonkey 安装。

## 2. 测试用 Chrome（独立 profile，绝不用日常 Chrome）

```sh
chrome.exe --remote-debugging-port=9333 --user-data-dir="<repo>\chrome-test-profile" \
  --proxy-server="http://127.0.0.1:6789" --no-first-run --no-default-browser-check
```

- 外网仅走本地代理 `http://127.0.0.1:6789`；`chrome-test-profile/` 已 gitignore（含登录态，绝不入库）；
- 并行车道换端口：`--remote-debugging-port=9334 --user-data-dir="<repo>\chrome-e2e-profile"`（该 profile 没有 TM、没有登录态，只能走注入）。

## 3. 注入 / 断言（零依赖 CDP 工具，Node ≥ 22）

```sh
node tools/cdp.mjs open <url>            # 导航（CDP_PORT 环境变量换端口，默认 9333）
node tools/cdp.mjs inject                # 注入 ntr-toolbox-alpha.user.js（去 UserScript 头）
node tools/cdp.mjs evalf tools/.e2e-xxx.js
node tools/cdp.mjs shot out.png
node tools/cdp.mjs logs
node tools/engine-test.mjs               # GlossaryEngine 单测（需 mock 在跑）
node tools/.run-suite.mjs tools/.e2e-xxx.js "http://127.0.0.1:8788/wenku/mock-src"   # e2e 套件
```

注意：**TM 的 `@match` 不含 127.0.0.1**，mock 页上装好的 TM 脚本不会注入（属正常）——mock 测试一律走 `cdp.mjs inject`。

## 4. 真机（TM + 实站）

1. `node tools/.gen-dev.mjs` 生成 `ntr-toolbox-alpha.dev.user.js`；
2. 测试 profile 里打开 `http://127.0.0.1:8788/ntr-toolbox-alpha.dev.user.js` 点安装（装的是篡改猴测试版/Beta；重装对话框落在扩展的 `ask.html`，按钮按 `<input value="更新/重新安装">` 匹配点击，装完**必须刷新页面**）；
3. 校验装上的版本：`node tools/.probe-tm-hash-ws.mjs`，与 dev 构建**整文件** sha256 比对；
4. HTTPS 页面访问本机 daemon 受 Chrome 本地网络访问（LNA）管辖：真实用户首次需在地址栏授权；headless 车道加 `--disable-features=LocalNetworkAccessChecks` 才能自动化。

## 5. daemon 控制台与站位

```sh
node daemon/index.mjs serve --port 7331   # 或双击托盘 daemon/tray.vbs（隐藏运行）
# 控制台 http://127.0.0.1:7331/ui
```

- 站点被墙时：控制台「设置 → 网络代理」填 `http://127.0.0.1:6789` 并点「测试（对比直连 / 代理）」（保存即生效，无需重启）；
- 站点页面点油猴模块「Daemon 连接」把凭据推给 daemon（开着页面会自动同步）；
- daemon 侧测试：`PORT=8790 node mock-llm/server.mjs` → `node daemon/daemon-test.mjs`；纯函数套件见 `daemon/README.md`「测试」。

## 6. 线下页面替身

`debug-env/` 是离线站点页面替身（小说列表 / 详情 / 两个工作区），无网络也能开发与截图。
