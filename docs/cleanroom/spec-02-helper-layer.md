# spec-02：helper 层（设置工厂 / 白名单 / SettingUtils / TaskUtils / StorageUtils）

重构对象：上游四个工具类 + 顶层设置工厂与白名单函数（约 400 行）。
等价验证：`.e2e-auto-retry.js`、`.e2e-storage-utils.js`、`.e2e-panel-basics.js`、`.e2e-translator-mgmt.js`、`.e2e-collect-tasks.js` + 全套 e2e。
公共 API 名全部保留（模块定义与面板直接调用）：`new*Setting`、`getModuleSetting`、`isModuleEnabledByWhitelist`、`SettingUtils`、`TaskUtils`、`StorageUtils`。

## 1. 设置工厂与读取
- `newBooleanSetting(name, def)` → `{name, type:'boolean', value:Boolean(def)}`
- `newNumberSetting(name, def)` → `{name, type:'number', value:Number(def || 0)}`（缺省/0 归 0）
- `newStringSetting(name, def)` → `{name, type:'string', value:String(def ?? '')}`
- `newSelectSetting(name, options, value)` → `{name, type:'select', value, options}`（options 按引用保留）
- `newTextareaSetting(name, def)` → `{name, type:'textarea', value:String(def ?? '')}`
- `getModuleSetting(mod, key)` → `mod.settings` 里按 name 找到的第一项 `value`；无 settings/无匹配 → `undefined`

## 2. 模块启用判定 isModuleEnabledByWhitelist(mod)
1. `mod.needsTarget` 且当前页不是「术语表目标页」（/novel/{p}/{id}、/wenku/{id}、/favorite/local）→ false。
2. 无 whitelist → 直接返回 `domainAllowed`。
3. 有 whitelist（字符串或数组）：`domainAllowed && 存在一条路由匹配`。路由匹配规则：
   - 以 `/*` 结尾：pathname === 前缀 或 pathname 以该前缀开头（`/workspace/*` 命中 /workspace 与 /workspace/任意）；
   - 其他：pathname **includes** 该串（`/workspace/sakura` 命中 /workspace/sakuraBETA 之类）。

## 3. SettingUtils.getTranslateMode(mode)
映射：`常规→normal`、`过期→expire`、`重翻→all`；其他 → undefined。

## 4. TaskUtils（全部静态）
- `getTypeString(url)`：按序匹配并返回第一个命中的页型：`/wenku`(无子路径)→`wenkus`、`/wenku/*`→`wenku`、`/novel`→`novels`、`/novel/*`→`novel`、`/favorite/web*`→`favorite-web`、`/favorite/wenku*`→`favorite-wenku`、`/favorite/local*`→`favorite-local`；都不中 → null。
- `wenkuLinkBuilder(series, name, mode)` → `` `wenku/${series}/${name}?level=${mode}&forceMetadata=false&startIndex=0&endIndex=65536` ``
- `webLinkBuilder(url, from=0, to=65536, mode)` → `` `web${url}?level=${mode}&forceMetadata=false&startIndex=${from}&endIndex=${to}` ``
- `wenkuIds()`：页面上所有 `a[href^="/wenku/"]` 的 href 取 `/wenku/` 之后的部分（可含子路径）。
- `webSearchApi(limit=20)`：由当前 URL 参数拼 `/api/novel?page=&pageSize=&query=&provider=&type=&level=&translate=&sort=`。page 取 `page-1` 下限 0；selected[0..4] 分别是 provider 位掩码/类型/分级/翻译/排序（缺省 0xff/0/0/0/0）；provider 位掩码 kakuyomu=1、syosetu=2、novelup=4、hameln=8、pixiv=16、alphapolis=32，掩码为 0xff 或解出空 → 全部六个。
- `assignTasksSmart(novels, jobLimit, chapterLimit, mode)`：
  - undone：normal 模式 `max(total - (sakura ?? gpt), 0)`，否则 `total`；
  - 总未完成 0 → `[]`；任务数 = min(⌊总未完成/chapterLimit⌋, jobLimit)，若 ≤0 且有未完成 → jobLimit；块大小 = ⌈总未完成/任务数⌉；
  - 按 undone 降序逐本切（normal 起点 = total-undone，否则 0），全局计数到 jobLimit 即止。
- `assignTasksStatic(novels, parts, mode)`：逐本 undone（normal：`total-(sakura??gpt)`，可为负 → ≤0 跳过）；块大小 ⌈undone/parts⌉，起点 normal=total-undone 否则 0；i=0..parts-1，块起点 ≥ 本末尾则跳过，末块的终点一律 = 本的终点。
- `clickTaskMoveToTop(count, reserve=true)`：取页面 `.n-thing-header__extra`，reserve 时**从最后一个往前**取第 i 个，点它内部第一个 button（无按钮跳过）。
- `clickButtons(name='')`：页面全部 button，`name===''` 或 textContent includes(name) 时派发可冒泡 click。

## 5. StorageUtils（全部静态；数据键与站点工作区约定对齐）
- 键名域名分支：`sakura` = hostname 是 n.novelia.cc → `workspace-sakura`，否则 `sakura-workspace`；`gpt` → 恒 `workspace-gpt`。
- `_getData(key)`：JSON.parse 失败 → console.error + **移除损坏键**；返回结构永远补齐 `{workers:[], jobs:[], uncompletedJobs:[]}` 三个数组字段。
- `_setData(key, data)`：序列化写回 + 派发合成 `StorageEvent`（带 key/newValue/url/storageArea）——站点页与同页监听者靠它感知变更。
- `update()`：pathname 含 workspace/sakura → sakura 键、含 workspace/gpt → gpt 键，其他路径 no-op；内容读出再写回（等价于一次归一化 round-trip）。由主循环在 href 变化时调用。
- `addSakuraWorker(id, endpoint, amount=null, prevSegLength=500, segLength=500)`：amount null/-1 → 单个 `id`；否则 `id+1..id+amount` 逐个。worker 形状 `{id, endpoint, prevSegLength, segLength}`；**同 id 覆盖不新增**。
- `addGPTWorker(id, model, endpoint, key, amount=null)`：同上，worker 形状 `{id, type:'api', model, endpoint, key}`。
- `removeWorker(key, id)`：删单个 id。`removeAllWorkers(key, exclude=[])`：**只保留 id 在 exclude 里的**。
- `addJob(key, task, description, createAt=now)`：无条件追加 `{task, description, createAt}`。
- `addJobs(key, jobs=[], createAt=now)`：按 task 与已有任务**去重**后追加（createAt 统一为调用时刻）。
- `getUncompletedJobs(key)`：返回归一化后的 `uncompletedJobs` 数组。

## 6. 与旧实现的刻意差异
- 仅结构与命名另起；可观测行为（含 `removeAllWorkers` 只保留排除名单这一反直觉语义、`newNumberSetting` 的 `||0`）逐条保持——都有定格测试钉住。
- 死代码移除：`StorageUtils.updateUrl`（零引用）、`webSearchApi` 里四个从未使用的文案映射表（typeMap/levelMap/translateMap/sortMap）。
- 加固：`clickTaskMoveToTop` 对越界的 extra 静默跳过（旧实现会 TypeError 中断置顶流程）；`getModuleSetting` 容忍 mod 为空。
- `getTypeString` 由「对象 + 正则」改为「有序数组」，匹配顺序与语义逐条不变（列表页先于详情页）。
