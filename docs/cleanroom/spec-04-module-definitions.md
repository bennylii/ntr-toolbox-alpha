# spec-04：上游模块定义段（10 个模块的 settings + run）

重构对象：`defaultModules` 里上游的 10 个模块定义（约 930 行）。分叉自有的 6 个模块（AI提取术语表、导入术语表(KWG)、回滚术语表、术语队列、复制翻译器到BETA工作区、工作区翻译器自动同步）不动。
等价验证：`.e2e-translator-mgmt.js`（18）、`.e2e-collect-tasks.js`（15）、`.e2e-auto-retry.js`（14）、`.e2e-fill-paginate.js`（20）、`.e2e-web/wenku-dryrun.js`、`.e2e-sync-storage.js`、`.e2e-panel-basics.js`（控件/图标）+ 全套 e2e。
模块名/设置名/白名单保持不变（配置存储与面板按这些字符串对号）。

## 1. 添加翻译器（两个模块）
- 添加Sakura翻译器（whitelist `/workspace/sakura`）：设置 数量(number,5)/名称(string,'NTR translator ')/链接(string,'https://sakura-share.one')/bind。run → `StorageUtils.addSakuraWorker(名称, 链接, 数量)`。
- 添加GPT翻译器（whitelist `/workspace/gpt`）：设置 数量/名称/模型('deepseek-chat')/链接('https://api.deepseek.com')/Key('sk-wait-for-input')/bind。run → `StorageUtils.addGPTWorker(名称, 模型, 链接, Key, 数量)`。

## 2. 删除翻译器（whitelist `/workspace`）
设置 确认删除(boolean,true)/排除(string,'共享,本机,AutoDL')/bind。run：
- 排除按逗号拆分去空；按 `location.href` 以 `gpt`/`sakura` 结尾选工作区键，都不是 → 当前 workers 空。
- 确认删除开且可删数>0 → `confirm('确定要删除 N 个翻译器吗？')`；拒绝 → warning『已取消删除』并 return。
- 然后 gpt 分支 removeAllWorkers(gpt键, 排除) + success『已删除 GPT 翻译器』；sakura 分支同理『已删除 Sakura 翻译器』；两键都不是 → 静默。

## 3. 启动翻译器（whitelist `/workspace`）
设置 延迟间隔(number,50)/最多启动(number,999)/避免无效启动(boolean,true)/排除(string,'本机,AutoDL')/bind。run（auto 参数 = runModule 传入的 true）：
- 候选按钮 = 页面全部 button；`!auto && 避免无效启动` → 全收；否则在 `.n-list-item` 内的按钮：所在条目含文案 `TypeError: Failed to fetch` 的 div → 剔除；不在列表条目内的 → 收。
- 逐个点 textContent 含『启动』的按钮（点后等 延迟间隔 ms），计满 最多启动 停。
- 避免无效启动开：每轮数『停止』按钮数（**基线从不更新**），数不动 → emptyCheck++，>3 → 提前停（即最多走 4 轮）。
- 注意：『排除』设置**从未被使用**（历史遗留）；『启动翻译器』的点击目标是站点的启动按钮，本脚本不负责后续。

## 4. 排队Sakura v2 / 排队GPT v2
- Sakura whitelist `['/wenku','/novel','/favorite']`；GPT whitelist `['/wenku','/novel','/favorite/web']`。设置一致：单次撷取web数量(可破限)(20)/撷取单页wenku数量(deving)(20)/模式(select 常规)/分段(select 智能)/智能均分任务上限(1000)/智能均分章节下限(5)/固定均分任务(6)/R18(需登入)(true)/bind。
- 共同骨架：`getTypeString(pathname)` 分页型：
  - `wenkus`（/wenku 列表页）：对每个 `TaskUtils.wenkuIds()` 的 id → `script.fetch(origin + /api/wenku/{id}, r18)`（失败重试 3 次、间隔 1s，错误文案 **Sakura 带句号、GPT 带冒号**）→ `wenkuLinkBuilder(id, volumeId, translateMode)` 任务（desc=卷id）→ `StorageUtils.addJobs(各自的键, results)`。
  - `wenku`（详情页）：`clickButtons(cnMode)` + `clickButtons('排队Sakura'/'排队GPT')` —— 借用站点页面自己的排队按钮。
  - `novels`（/novel 列表页）：`webSearchApi(webCatchLimit)` → fetch → `items` 映射 `{url: /{providerId}/{novelId}, description: titleZh??titleJp, total, sakura/gpt 进度}` → 智能/固定切分 → addJobs；失败 → errorFlag + error『Failed to fetch web search results.』。
  - `novel`（详情页）：找 `span.n-text` 里匹配 `总计 N / 百度 N / 有道 N / GPT N / Sakura N` 的统计条 → 取 total 与 GPT/Sakura 进度；`document.title` 含『轻小说机翻机器人』 → 报『小说页尚未载入』；单本切分 → addJobs；失败 errorFlag + `Failed to fetch data for ${title}.`。
  - `favorite-web`（收藏夹网页）：folderId = pathname 以 `/web` 结尾 → `'default'` 否则末段；分页拉 `/api/user/favored-web/{id}?page=N&pageSize=90&sort=update` 直到不足 90 条；每页切分 → addJobs → toast（**Sakura：`成功排队 ${3p+1}-${3p+3}页, 共N个任务`；GPT：`...共N本小说`**，N 一个是任务数一个是本数——上游古怪差异，钉住）；请求异常 console.log + error toast，**重试 4 次后**放弃该页（tries++ 后比较）。
  - `favorite-wenku`：folderId 同理（`/wenku` 结尾 → default）；分页拉 `/api/user/favored-wenku/{id}?pageSize=72&sort=update` → 每本书再拉卷目录 → 任务 → addJobs → toast `成功排队 ...页, 共N本小说`（两模块相同）；异常重试比较 `tries > 3` 但 **tries 从不自增 → 理论上无限重试**（上游 quirk，钉住）。
  - default（其他页）：什么都不做。
- 收尾：errorFlag → 直接 return；否则按 description 去重计数 → success `排队成功 : 共 X 本小说, 均分 Y 分段.`（Y=results 总任务数，包括跨页累计）。
- cnMode：`{常规:常规,过期:过期,重翻:重翻}` 查表缺省回落『常规』（identity 映射）。

## 5. 自动重试（keep 型，whitelist `/workspace/*`）
设置 最大重试次数(number,99)/置顶重试任务(boolean,false)/重启翻译器(boolean,true)。实例态 `_attempts/_lastRun/_interval=1000`。run（契约细节见 .e2e-auto-retry.js 钉住的现状）：
1. 1s 节流（`_lastRun/_interval`）。
2. maxAttempts = 设置||99；relaunch = 重启翻译器（**布尔直读**）；moveToTop = 置顶重试任务。
3. 惰性绑一次 document click 监听：目标是 `<button>`（大小写不敏感）→ `_attempts` 清零（用户在亲自操作 = 重新给满预算；模块自己每轮点 retry 按钮也会触发清零，但轮次进度由轮次入参承载，不受影响）。
4. 扫 `.n-list-item` 中 `.n-thing-main__description` 文案含『未完成』的条目。
5. 有未完成且 `_attempts < maxAttempts`：
   - 页面有 textContent **全等**『停止』的按钮 → 什么都不做；
   - 否则点第一个 textContent 含『重试未完成任务』的按钮 `min(unfinished, listItems)` 次；置顶开 → `TaskUtils.clickTaskMoveToTop(unfinished.length)`；点了 retry 才 `_attempts++`；
   - `script.delay(10)`（不 await）；relaunch 真值 → `script.runModule('启动翻译器')`（即使 retry 按钮不存在也每轮触发）。

## 6. 清空任务（whitelist `/workspace/*`）
设置 确认清空(true)/仅清空已完成(false)。run：按 pathname 含 workspace/sakura → sakura 键、workspace/gpt → gpt 键、否则 error『无法确定工作区类型』；仅清空已完成 → warning『仅清空已完成功能需配合网站API』直接 return（**未实现的死设置**）；确认清空开且任务>0 → `confirm('确定要清空 N 个任务吗？此操作不可恢复！')` 拒绝 → warning『已取消清空』；清空 jobs + success『已清空 N 个任务』。

## 7. 资料同步（whitelist `/workspace/*`，hidden）
设置 bind。run 为空——上游未实现的占位模块，保持 no-op。

## 8. 填充术语表（whitelist `/novel`）
设置 术语表(textarea)/追加模式(true)/页面可视化反馈(true)/**自动翻页至末页(false)/翻页上限(20)**（后两项为分叉新增）/bind。run：
1. 术语表空 → warning『术语表为空』；逐行解析：`原文 => 译文` 或整行 JSON（失败忽略）；0 条 → error『未能解析任何术语 (格式: 日文 => 中文)』。
2. collectNovels：站内 `/novel/{provider}/{id}` 链接去重；容器 closest 链：`n-list-item`（**无点号，自定义元素**，上游 quirk）→ `.n-list-item` → `.novel-card` → `div`。
3. 首页 0 条 → warning『未在当前页面找到小说条目』；confirm 文案：`确定要为当前页面的 N 本小说追加/填充术语表吗？\n(包含 M 个术语)` + 翻页时附『将自动翻到第 1/{maxPages} 页…』；拒绝 → 结束（无 toast）。
4. 可视化反馈开 → 先清页面旧 `.ntr-glossary-badge`；每个条目按 pending（⏳）/success（✅）/fail（❌）挂徽章（插到容器 `n-flex`/`.n-flex`/自身的第一个子元素前），title 写明细。
5. 每条目：追加模式先 GET `/api/novel/{p}/{id}` 取旧表合并（新值优先：`Object.assign({}, 旧, 新)`）→ PUT `/api/novel/{p}/{id}/glossary`（Content-Type json）→ ok 成功徽章/否则 HTTP 状态徽章；异常 → fail 徽章『术语表填充失败: 网络错误』。
6. 自动翻页（分叉）：`while pagesProcessed < maxPages`：找下一页（可见 `.n-pagination` 的最后一个 `.n-pagination-item--button`；回落文本含『下』『›』或 aria next）；禁用判定（disabled 属性/`n-pagination-item--disabled` class）→ 停；点前记页面签名（条目数|首|末 id），点了 10s 内签名没变 → 停（stuck，防重复填同一页）；翻了 → 400ms 后继续。stoppedReason 文案映射：no-next=已到末页/disabled=下一页按钮不可用/max-pages=达到翻页上限/empty=翻到空白页/stuck=列表没有翻动。
7. 收尾：全成功 → success『成功填充 N 本小说的术语表(，翻页 X 页（停止：…）)』；有失败 → warning『填充完成: X 成功, Y 失败…』。

## 9. 与旧实现的刻意差异
- 只另起表达，全部文案/设置名/接口形状逐条保留——定格测试已钉。
- 排队 v2 两模块各自的 `maxRetries=3`、间隔 1s 重试结构保留；不合并两模块（文案微差太多，合并弊大于利）。
- 两模块的卷目录拉取提为局部 helper `wenkuVolumes`（Sakura 版带文案尾缀参数：wenkus 句号 / favorite 冒号，GPT 版恒冒号——沿用上游原文的差异）。
- 加固：排队 v2 的 `novel` 详情页分支，旧实现把 `title` 声明在 try 内、catch 引用它会 ReferenceError（统计条缺失时错误 toast 从不弹出）；重写后 catch 用 `document.title`，能正常弹错误。此路径无定格测试覆盖，属可观测微调。
- 加固：删除翻译器在非工作区页提前 return（旧实现继续走完两个 if）；清空任务把「已清空 N」的 N 在清空前捕获（与旧实现等价，只是表达更直白）。

## 10. 行为变更记录（重构后，经用户决策）
- **2026-10-02**：修复自动重试的两个上游 quirk（原以「保持等价」钉住）：
  1. 手动点击清零计数：`tagName === 'button'`（小写永假）→ 大小写不敏感比较，清零真正生效；
  2. 「重启翻译器」开关：`设置值 || 3`（false 短路成 3，关不掉）→ 布尔直读（`=== true`），关闭即不再触发重启。
  对应 `.e2e-auto-retry.js` 的 F/G/H 段断言已同步改写为修复后行为。
