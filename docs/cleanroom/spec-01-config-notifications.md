# spec-01：配置存取 / 通知 / 会话 token（clean-room 行为规格）

重构对象：上游「配置读写（loadConfiguration/saveConfiguration）」「toast 通知（NotificationUtils）」「会话 token 读取（initToken）」。
实现位置：`ntr-toolbox-alpha.user.js` 内同名成员。本文描述**行为契约**，实现须另起结构，不逐行翻译上游表达。
等价验证：`tools/.e2e-config.js`、`tools/.e2e-tempendpoint-migrate.js`、`tools/.e2e-tempendpoint.js` + 全套 e2e。

## 1. 配置存取

### 1.1 存储
- 键名：`NTR_ToolBox_Config`（**数据兼容红线，不可改**）；内容为 JSON：`{ version, modules }`。
- `CONFIG_VERSION = 23`；`modules` 为模块定义数组（name/settings/whitelist/…，settings 内 `{name, value, …}`）。
- `saveConfiguration()`：把 `this.configuration` 原样 JSON 序列化写回键名；不吞异常（写失败如实抛出）。

### 1.2 读取与合并（loadConfiguration）
1. 读键并 `JSON.parse`：键不存在、解析失败、结果非对象 → 视为**无有效配置**。
2. 无有效配置，或 `version !== 23` → 返回**出厂默认**：`{ version: 23, modules: 默认模块深拷贝 }`，**不写回**存储。
3. 否则以**默认模块深拷贝为底**合并存储值，按模块 `name` 对号入座：
   - 存储里名字对不上的模块直接忽略（老模块名/多余模块不进入结果）。
   - 模块级字段（`settings`/`whitelist`/`needsTarget`/`settingGroups` 之外）：仅当默认模块**拥有同名字段**、且两者 `typeof` 一致、且存储值非 `undefined` 时才采纳——白名单/路由门槛这类「代码结构」永远以代码为准。
   - `settings` 按设置项 `name` 对号：只取存储里的 `value`；`type`/`options` 等以代码为准；默认新增的设置项自动补默认值；存储里的幽灵设置项不保留。
   - **临时端点一次性迁移**：若该模块存储的 settings 里没有「使用临时端点」项，而代码里有「使用临时端点」+「临时端点」两项，且（合并后）「临时端点」的值非空白字符串 → 把「使用临时端点」置为 `true`（老配置填过端点即视为原本在用）。每模块只判一次。
4. 返回 `{ version: 23, modules: 合并结果 }`；每个模块的 `run` 必须是当前代码里的函数（函数不来自存储，天然满足；实现作防御性重绑）。
5. 模块合并完成后 `saveConfiguration()` 不被自动调用（是否持久化由调用方决定）。

### 1.3 与旧实现的刻意差异（均不可被现有行为观测到）
- 旧实现存在「模块数/名字集与默认不一致 → 重置并写回」分支：由于合并总是从默认深拷贝出发，该分支不可达，重写后移除。
- 旧实现在 `version===23` 但 `modules` 不是数组时会抛异常导致脚本初始化失败；重写后按「无有效配置」处理（加固）。
- 旧实现的「从默认逐字段重挂」循环对深拷贝产物是空转；重写后只保留 `run` 的防御性重绑。

## 2. 通知（NotificationUtils，静态类）
- 懒初始化：首次弹通知时创建 `div.ntr-notification-container` 挂到 `document.body`，此后复用（类名是 e2e 抓取契约，不可改）。
- 三种入口：`showSuccess`/`showWarning`/`showError` → 图标分别为 `✅` / `⚠️` / `❌`。
- 单条通知 DOM：`div.ntr-notification-message` 内含 `span.ntr-icon`（图标文本）+ 文本节点（消息原文，不转义不截断）。
- 生命周期：弹出 **1000ms** 后加 `fade-out` 类（CSS 淡出），再 **300ms** 后从 DOM 移除。CSS 类名属于注入样式契约，保持不变。
- 不去重、不排队、不限制并发条数（每条独立计时）。

## 3. 会话 token（initToken）
1. 读 `localStorage['auth-v2']`：JSON 且含真值 `token` → 返回它（站点当前会话格式，短效 access token）。
2. 读不到再读 `localStorage['auth']`：JSON 且 `profile.token` 真值 → 返回（历史格式，token 已停更，仅作回落）。
3. 都没有 → 返回 `null`。任何解析异常按「读不到」处理。
4. 构造时调用一次存入 `this.token`；SiteCheck 的「会话存储」检查复用同一入口。
