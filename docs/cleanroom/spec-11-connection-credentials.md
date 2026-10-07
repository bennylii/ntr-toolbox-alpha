# spec-11：连接与凭据同步（daemon ⇄ 油猴）（行为规格）

借鉴对象：无上游（自设计；「变化才推」的指纹去重与 keep 模块自节流同思路）。
实现位置：`daemon/server.mjs`（`GET /ping`、`POST /auth`、CORS 白名单）、`daemon/index.mjs`（端口解析、need-auth 文案）、`daemon/tray.ps1`（端口自读）、`ntr-toolbox-alpha.user.js`（Daemon 连接模块 + 自动同步）。
定位：浏览器端把站点凭据（auth-v2 token）与 GPT 工作区翻译器喂给 daemon 的唯一通道；带可观测性与自愈（token 刷新后自动重推）。

## 1. 端点契约

- `GET /ping`：免凭据；返回 `{ok:true, name:'ntr-daemon', port, version}`；CORS 走同一白名单——油猴角标与外部脚本探测用；
- `POST /auth`：body `{token, workers, origin, auto}` →
  - `config.token/workers/origin` 落库；workers 热更新翻译池（`setWorkers`），助手池「跟随模式」下同步镜像、显式配置过则不覆盖；
  - `config.lastSync = {at, origin, ua(浏览器名+版本主干), workersCount, tokenSet, mode: 'auto'|'manual'}`——**只记元数据，不记 token**；
  - 响应 `{ok:true, workers:n}`。

## 2. 白名单（CORS）

- 内置默认：`n.novelia.cc` + `127.0.0.1`/`localhost`（http/https），**不可移除**；
- `config.serve.origins`：附加条目（hostname 或完整 origin），设置页可编辑（≤32 条），即时生效；非法条目忽略；
- 非 GET 请求/预检的 Origin 不在白名单 → 403；预检统一应答 `Access-Control-Allow-Private-Network: true`（Chrome LNA/PNA）。

## 3. 端口

- 解析顺序：`--port` 旗标 > `config.serve.port` > 7331；serve 启动即把实际端口写 `daemon/.serve-port`（托盘与脚本探测用）；
- 改端口（设置页「连接」区）**重启生效**；托盘默认不传 `--port`（自读 config），`-Port N` 显式覆盖。

## 4. 油猴侧自动同步

- 挂点：面板主循环每 tick 调用的 `refreshDaemonGlance`（30s 节流，零新增定时器）；「自动同步」开关默认**开**；
- 流程：ping 在线 → 指纹 `JSON({token, workers, origin})` 与 `localStorage['ntr-daemon-auth-fp']` 比较 →
  - 未变：零网络请求（短路）；
  - 首次（无存档指纹）：静默推送（仅状态行更新）；
  - 有旧指纹且变化（站内 token 刷新）：推送 + 一次性提示「凭据已自动更新到 Daemon」；
- token 读取走 `initToken()` 回落链（auth-v2 → auth.profile）；推送失败静默（状态行/角标已表达）；
- 手动「Daemon 连接」与自动同步共用 `daemonPushCredentials`（manual 保留成功/失败通知与 LNA 提示）。

## 5. LNA/PNA 与故障语义

- 真实用户首次从 HTTPS 页面访问本机 daemon 会有浏览器「本地网络访问」授权（一次性）；模块错误提示含该指引；
- headless 测试车道必须 `--disable-features=LocalNetworkAccessChecks`，否则 fetch 直接失败（daemon 侧一切正常）；
- daemon 收到 401（need-auth）时的自愈路径：页面开着 ≤30s 自动重推；或手动点「Daemon 连接」；或 `daemon auth <token>`。

## 6. 边界与刻意差异

- **不做 cookie 通道**：站点 API 只认 Bearer（真机验证）；续期用 refresh cookie 是 HttpOnly，页面读不到——推 cookie 无收益且多存敏感数据；
- lastSync 只存元数据；多浏览器推送按 lastSync 的 origin/UA/mode 分辨（auto/manual）；
- 无长连接/无服务端推送：全部为浏览器侧主动 HTTP（ping/auth + 控制面轮询）。

## 7. 验证对照

- daemon-test：`/ping` 形状、lastSync 字段与 auto/manual、白名单放行/拒绝、`.serve-port` 落盘（子进程起于 config 端口）；
- 浏览器 e2e `tools/.e2e-daemon-sync.js`（stub 7343 提供 /ping、/auth 计数、/reset）：去重零推送 → token 变化自动重推（auto 标记 + 提示）→ 再 tick 不重复；手动流保持。
