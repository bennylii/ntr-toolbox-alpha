# spec-05：注入样式（面板/通知/徽章 CSS）与 IIFE 头尾

重构对象：主样式表注入块（`const css = document.createElement('style')` 起，约 200 行）——上游最后一块未重写的表达。IIFE 头部（单例守卫 + 5 个常量）与尾部（`new NTRToolBox()` + 分叉 init 钩子）为纯声明/分叉自有，无重写实质。
等价验证：视觉截图前后对比 + `.e2e-panel-basics.js`（30）+ 全套 e2e。

## 1. 契约（保持不变）
- **选择器全部保持**：它们是 DOM 结构与 e2e 的直接契约——`#ntr-panel`（+ `.minimized`）、`.ntr-titlebar`、`.ntr-panel-body`、`.ntr-module-container/-header`（+ `:hover`、`.active`）、`.ntr-module-glance`（+ `.has`/`.busy`，分叉）、`.ntr-settings-container`、`.ntr-settings-group/-head`（+ `.disabled`/`:hover`，分叉）、`.ntr-input`、`.ntr-number-input`、`.ntr-bind-button`、`.ntr-info`、`.ntr-notification-container/-message`（+ `.ntr-icon`、`.fade-out`）、`.ntr-glossary-badge`（+ `-pending/-success/-fail`）、`@media (max-width:600px)` 的 `#ntr-panel` 缩放。
- **渲染结果不变**：所有属性值逐一保留（几何/配色/动效参数）；`.active` 与通知容器的 `z-index:9999`、面板 `position:fixed` 默认 `left:20px;top:70px` 等，重构前后像素级一致。
- 注入方式保持：`<style>` 挂 `document.head`。

## 2. 重写方式
- 规则分组重排（面板 → 模块行 → 设置 → 输入控件 → 信息栏 → 通知 → 术语徽章 → 响应式），每节一行注释说明用途；
- 规则内部声明顺序调整（**不得**在同一规则里产生同名属性先后覆盖）；
- 注释全部另写；
- 关键帧 `ntr-pulse` 更名 `nta-pulse`（自包含引用：只被 `.ntr-glossary-pending` 的 animation 引用，无外部契约）。

## 3. 与旧实现的刻意差异
- 仅格式/分组/注释/关键帧名；视觉与选择器契约零变化。
