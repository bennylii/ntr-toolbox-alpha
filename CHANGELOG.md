# Changelog

All notable changes 按版本记录；版本号跟随油猴脚本 `@version`。

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
