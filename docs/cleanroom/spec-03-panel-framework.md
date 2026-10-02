# spec-03：面板框架（class NTRToolBox 主体 + DragHandler）

重构对象：上游面板骨架约 700 行（构造/DragHandler/buildGUI/buildModules/键盘/点击/keep 四件套/轮询/显隐/最小化/请求通道）。
等价验证：`.e2e-panel-basics.js`（30 断言）+ `.e2e-config.js`、`.e2e-tempendpoint*.js`、`.e2e-translator-select.js`、`.e2e-queue-glance.js`、`.e2e-fill-paginate.js`、`.e2e-tm-readonly.js` + 全套 e2e。
分叉集成点（**必须原样保留行为**，共 6 处）：构造器 glance 三件套与 `SiteCheck.bind/schedule`；buildGUI 的 `siteCheckEl` 与 `GlossaryQueue.setGlanceHook`；buildModules 的速览角标；scheduleNextPoll 的 `SiteCheck.onRouteChange()` 与 `refreshQueueGlance()`。分叉自有的动态下拉（options 可为函数）与 settingGroups 折叠框机制按现状保留（有专属测试）。

## 1. 构造与克隆
- 构造顺序：loadConfiguration → keepActiveSet/headerMap/glanceMap 三张表 + 速览节流字段 + _pollTimer → initToken → buildGUI → attachGlobalKeyBindings → loadKeepStateAndStart → scheduleNextPoll → SiteCheck.bind(this) + schedule()。
- `cloneDefaultModules()`：每个模块浅拷贝 + settings 逐项浅拷贝（无 settings → `[]`）+ `_lastRun: 0`。**不深拷贝** settings 之外的引用字段（run 函数、progress 对象等共享引用是有意行为）。

## 2. DragHandler（panel + 标题栏拖拽，鼠标 + 触摸）
- mousedown（标题栏，仅左键）：关掉 transition、dragging=true、offset = client − offsetLeft/Top、preventDefault。
- mousemove（document，dragging 中）：位置 = client − offset，随后 clampPosition。
- mouseup（document）：dragging=false；恢复 transition；按 rect 夹紧到视口内；写 `ntr-panel-position`（JSON {left,top}，取自 style）。
- 触摸三件套（touchstart/move/end）同样语义，`passive:false` + preventDefault。
- clampPosition：style 的 left/top 解析后夹进 [0, innerWidth−宽] / [0, innerHeight−高]。

## 3. buildGUI
- 建 `#ntr-panel`：先按 `ntr-panel-position` 恢复位置（parsed.left && parsed.top 才生效）。
- 标题栏 `.ntr-titlebar`：文本 `NTR Toolbox Alpha <VERSION>`；toggleSpan `[-]`（右浮）。
- body `.ntr-panel-body`；信息栏 `.ntr-info`：左提示（移动端 `单击执行 | ⚙️设置` / 桌面 `左键执行/切换 | 右键设置`）、`#ntr-sitecheck` 角标（默认隐藏，点击 → SiteCheck.showDetails）、右侧 `bennylii · MIT` + 致谢 title。
- panel 挂 body → `GlossaryQueue.setGlanceHook(() => this.refreshQueueGlance(true))` → DragHandler → buildModules。
- 150ms 后测量：expandedWidth/Height；再临时挂 `.minimized` 量 minimizedWidth/Height（已最小化则直接量）。
- 标题栏：桌面 contextmenu → 切最小化；移动端 click（未在拖拽中）→ 切最小化。

## 4. buildModules
- 清空 panelBody、headerMap/glanceMap。每个模块：
  - `.ntr-module-container` > `.ntr-module-header`（名字 span；桌面端尾缀图标 keep=`⇋`、onclick=`▶`，marginLeft 8px）。
  - 「术语队列」行追加 `.ntr-module-glance`（`|队列:0|运行中:0|`）并进 glanceMap。
  - `.ntr-settings-container` 默认 display:none。
  - 动态下拉（分叉）：options 可以是函数（每次展开重新求值）；fillSelect 时当前值不在选项里则补一条（空值显示 `(未设置)`）；select 带 `data-setting-name`；pointerdown/focus 触发重填；打开设置面板时 refreshSelectOptions。
  - 桌面：右键切换设置显隐（用 computedStyle 判断）+ 打开时刷新下拉；左键（button 0、无修饰键、目标非 .ntr-bind-button）→ handleModuleClick(mod, header)。
  - 移动端：⚙️ 按钮切换设置；header 单击 → toast `运行模块: X` + handleModuleClick（configuration 里的 stored 模块优先）。
  - 设置渲染（有 settings 时）：非组成员直接一行；组成员聚进 `.ntr-settings-group`（dataset.groupId/expanded='0'，head 点击切换并 syncGroups；body 内边距）。每组只渲染一次。
  - 行控件：label `名字: ` + 类型控件——boolean→checkbox（onchange 写值 + saveConfiguration + 若它 enabledBy 某组则同步组展开态）；number→input[type=number].ntr-number-input（onchange `Number(v)||0`）；select→下拉（onchange 写值）；string 且名字是 bind→`.ntr-bind-button` 按键捕获（按下后 `(Press any key)`，Escape→none，其他键→小写存值，存盘后自毁监听、stopPropagation），其余 string→input[type=text].ntr-input；textarea→`.ntr-input`（80×180、可纵向拉伸）；未知类型→灰色只读 span。
  - 全部 onchange 即时 saveConfiguration。渲染完 syncGroups 一次。
  - header 挂 container，container 挂 panelBody，`headerMap.set(mod, header)`。

## 5. 键盘 / 点击 / keep
- 全局 keydown：带 ctrl/alt/meta 忽略；按模块 bind 值（≠'none'，小写比对 key）触发——先过 `isModuleEnabledByWhitelist`，命中才 preventDefault + handleModuleClick(mod, null)。
- handleModuleClick：`!domainAllowed || !isModuleEnabledByWhitelist(mod)` → 直接返回（**域门槛是行为的一部分**）；onclick 型 `mod.run(mod)` 以 Promise 包裹吞异步错误（console.error）；keep 型有 header 才 start/stop 切换；同步异常 console.error。
- start（幂等）：header.classList.add('active') + keepActiveSet.add + 落盘；stop 反向；落盘格式 `{模块名: true}`。
- loadKeepStateAndStart：读 `NTR_KeepState`（坏 JSON → {}），对 keep 型且在盘上有名的模块经 headerMap 恢复激活。

## 6. 轮询 / 显隐 / 最小化 / 请求
- scheduleNextPoll：≥100ms 跑一次 pollKeepModules；≥250ms 跑 updateModuleVisibility，且 href 变化时 StorageUtils.update() + SiteCheck.onRouteChange()；每次都刷新队列速览；10ms 后自排程（句柄存 _pollTimer）。
- refreshQueueGlance（分叉）：无角标直接返回；1s 节流（force 直推）；busy 防重入；GlossaryQueue.counts() → 文本 `|队列:X|运行中:Y|` + busy/has class。
- pollKeepModules：keep + 激活 + 有 run → mod.run(mod)。
- runModule(name)：名字宽松相等（`==`）的全部模块逐个 mod.run(mod, true)——绕过域门槛与白名单（自动化入口）。
- updateModuleVisibility：allowed = domainAllowed × 白名单 × !hidden；不允许 → 行 display:none 且激活的 keep 顺带停；允许 → block。
- getAnchorCornerInfo：面板中心落在屏幕四象限 → corner + 对应边缘的 x/y。
- setMinimizedState(newVal)：同值直接返回；**先**取 rect 和锚角再改样式；minimized class / toggleSpan `[+]`/`[-]` / body none·block / infoBar none·flex；**310ms 后**按锚角把面板贴回原角（top-left→(x,y)，top-right→(x−宽,y)，bottom-left→(x,y−高)，bottom-right→(x−宽,y−高)，默认→当前 style/rect），夹紧视口并写 `ntr-panel-position`。
- fetch(url, bypass=true, options={})：**token 每次现读**（initToken() || 构造时缓存——短效 token 靠 refresh cookie 续期，缓存只是兜底）；bypass 且有 token → method 默认 GET、headers 先放 `Authorization: Bearer` 再被 options.headers 覆盖（options 显式给的 Authorization 优先）、其余 options 字段原样透传；否则原样透传 options。内部调用全局 fetch（不得递归）。
- delay(ms)：setTimeout Promise。

## 7. 与旧实现的刻意差异
- 仅结构与命名另起；可观测行为（点击/拖拽/最小化时序、轮询节流值、fetch 头合并优先级）逐条保持——panel-basics 30 断言等钉住。
- `fetch` 去掉一处永假的 Authorization 兜底分支（options.headers 覆盖后仍缺 Auth 的情况不存在）。
- DragHandler 的 mouseup/touchend 夹紧与写盘合并为同一私有流程，消除两份重复体。
