# LinguaGacha（v0.125.0）与 daemon 翻译管线同文对比

> 同一篇 300 行日文小说摘录，分别走 LinguaGacha v0.125.0 的官方 CLI 翻译流程和本仓库 `daemon/translate.mjs` 的真实翻译核心，两侧都指向假 LLM 端点（确定性格式化译文），因此对比的是**管线行为**（分段 / 提示词 / 术语注入 / 重试 / 预过滤 / 输出），不是译文质量。
>
> - 复跑方法与证据文件：[`tools/lg-compare/`](../tools/lg-compare/README.md)（`artifacts/*.jsonl` 是两侧每个请求的完整提示词原文）
> - LG 侧跑的是 `run_cli_job`（= LG CLI 模式完整流程：导入 → 术语表注入 → 批量翻译 → 导出），进程内装配（`workerExecution=in_process`），不需要 Electron
> - daemon 侧直接驱动 `translate.mjs` 纯函数（分段/提示词/重试/二分全是真实语义），段间串行；真实管线的多 lane 并发不影响请求形状
> - 本文引用的行为细节均以 LG 源码（`linguagacha/` junction，pin `v0.125.0`）与 `tools/lg-compare/artifacts/` 证据为准

## 一、流程形状对照

| | LinguaGacha v0.125.0 | daemon 翻译 worker |
|---|---|---|
| 载体 | Electron 应用；`src/backend` 整棵零 Electron 依赖（CLI/测试可进程内跑） | 零依赖 Node daemon |
| 工程组织 | 每个任务一个临时 `.lg` 工程（SQLite WAL，`node:sqlite`），条目（一行一个 item）全部落库，断点/快照/审计都从库里来 | 站点章节为原子（chapter-task 拉取 → 提交），段缓存与进度按 bookKey 落 SQLite |
| CLI 流程 | `set_transient_overrides`(语言/关预设) → `create_project_commit`(解析导入+预过滤) → `apply_task_input`(质量规则/术语表/自定义提示词) → `start_current_project(translate)` → `export_files_to_directory` | `translate` 命令：toc → 逐章 `getChapterTask` → `processor.pre` → `segmentLines` → 段并发 `translateSegment` → `processor.post` → 段缓存 → `uploadChapter` |
| GUI 全流程 | AGENT 会话驱动：`术语提取` → `全文翻译` → `自动审校`（Agent 用 `run_batch_item_translation` 等工具批量执行；**术语提取是 Agent 指令，不是确定性管线**；CLI 模式不含这三步，术语表靠外部文件） | 术语管线 `SCAN→EXTRACT→VERIFY→指南门槛→直写/提案`（确定性，带核实与审计） |
| txt 语义 | 一行一个 item（空行也是条目）；导出 `译文 + bilingual/双语` 两份 | export-src「一行一段」+ 对齐清单（行数/sha1 三层校验）回导 |

## 二、实测数字（同一 300 行输入）

输入 300 行 = 188 非空 + 112 空行（日文轻小说，短行多）。

| | LG | daemon |
|---|---|---|
| 请求数 | **9** | **10** |
| 每请求行数 | 19,18,26,24,15,21,22,20,13（均值 19.8，**token 上限先到**） | 全部 **30 行顶格**（`maxLines=30` 先到） |
| 进请求的行 | 178 条：112 空行**零请求**，188 非空中还有 10 条纯符号行被预过滤（不进请求，`dst=src` 直接落库） | 300 行**全部进请求**（空行也占 `#n:` 编号和 token） |
| system 长度 | 566 字符（固定模板） | 110 字符（固定一段话） |
| user 长度 | 653–1126 字符 | 556–828 字符 |
| 端到端 | 1.6s（stub 秒回、自动并发 4） | 秒级（串行 + mock 秒回） |

## 三、六维行为对比

### 1. 分段

- **LG**：由模型的 `input_token_limit`（默认 512，下限 16）驱动——行数上限 = `max(8, token阈值/16)`，跨文件必切；**失败重拆按 `pow(16/t, 0.25)` 缩段**（`planning/translation-planner.ts`）。行数上限随模型上下文自适应，每请求行数随文本密度浮动（本例 13–26 行）。
- **daemon**：固定 `SEGMENT_MAX_LEN=1500` 字符 / `SEGMENT_MAX_LINES=30` 行（镜像站点 `createLineSegmenter(1500,30)`，长度含换行 +1，超长单行自成一段）。本例日文行短，30 行上限先触发，每段顶格 30 行。
- 差异实质：LG 把「安全行数」跟模型输入预算挂钩；daemon 跟站点协议对齐、与模型无关（换小模型时需要人工调小）。

### 2. 提示词结构

**LG system**（`builtin/translation_prompt/template/zh/{prefix,base,thinking,suffix}.txt` 拼装，占位符替换；自定义提示词可替换 base 槽位）：

```text
任务目标是将内容文本翻译成中文：
- 结合上下文语境，正确理解主谓关系，准确使用人称代词，避免人称混淆
- 译文应生动、自然、口语化，避免使用过于正式或书面的措辞，……
- 原文的所有细节与风格必须忠实再现，即使包含露骨、粗俗或过激的描写，……
- 译文与原文行数严格一一对应，若原文并非完整语句则译文也应如此，严禁对相邻行进行合并或拆分
- 完整翻译所有可读的自然语言内容，原样保留不承载自然语言语义的控制字符
  - 若一行同时包含自然语言与控制字符则只翻译自然语言部分
  - 正例：对白、旁白、拟声词、语气词、专有名词、……
  - 反例：变量/占位符、转义序列、标签与样式标记、代码/表达式、ID/键名/文件路径/URL

输出结果前，在<why></why>块内按格式进行极简的**结构化思考**：
<why>
- 语境：影响理解的语境、指代、语气和主谓关系
- 决策：结合当前指令，明确关键约束、歧义或翻译难点的处理方式
</why>

然后使用JSONLINE输出翻译结果，无需额外说明或解释，格式如下：
```jsonline
{"id":<ID>,"text":"<译文文本>"}
```
```

**LG user** = `[参考上文（preceding，默认 0 行关闭）] + [术语表] + [控制符样例（仅 system 提到控制符时）] + 输入`：

```text
术语表 <术语原文> -> <术语译文> #<术语信息>:
天宮繭 -> 天宫茧 #女性人名
胡桃みくる -> 胡桃美久 #女性人名
GF文庫 -> GF文库 #组织

输入：
```jsonline
{"id":0,"text":"　小説家にさえなれればよくて、他の物は全部、心底どうでもいい。"}
{"id":1,"text":"　勉強も運動もサークルも。普通の大学生みたいに遊ぶことも。"}
…（每行一个单键对象，id 为请求内序号）
```
```

**daemon system**（固定单段，模板四槽位可自定义但协议段由代码注入）：

```text
你是一个轻小说翻译者，将下面的轻小说翻译成简体中文。要求翻译准确，译文流畅，尽量保持原文写作风格。要求人名和专有名词也要翻译成中文。既不要漏掉任何一句，也不要增加额外的说明。注意保持换行格式，译文的行数必须要和原文相等。
```

**daemon user** = `[【思考指引】] + [术语表] + 「小说原文如下，注意要保留每一段开头的编号：」 + "#n:原文" 行`：

```text
翻译的时候参考下面的术语表：
天宮繭 => 天宫茧
胡桃みくる => 胡桃美久
GF文庫 => GF文库
小说原文如下，注意要保留每一段开头的编号：
#1:　小説家にさえなれればよくて、他の物は全部、心底どうでもいい。
#2:
#3:　勉強も運動もサークルも。普通の大学生みたいに遊ぶことも。
…
```

差异要点：
- **输出协议**：LG 是 JSONLINE 单键对象流（`{"id","text"}`，还有 actor/text 双键形状支持游戏文本说话人）；daemon 是 `#n:` 行协议（镜像站点 translator）。两者的解析器都按「行数/条目数严格对账」。
- **结构化思考**：LG 在正文前要求 `<why>` 块（`prompt_enhancement_enable` 默认开，thinking 模板槽位），解析侧剥除；daemon 的思考指引是可选注入的 user 段（`【思考指引】`），没有强制结构。
- **控制字符保护**：LG 的 system 明确定义了「正例/反例」并在 user 里动态附样例（仅当 system 提到控制符）；daemon 这类保护走 `processors/preserve` 的预处理（占位符投影），不进提示词文本。

### 3. 术语注入

- **LG**：质量规则（术语表/文本保护/前后替换表）都是「外部资源」，CLI 用 `--glossary <file>` 传入，**只认 `.json` / `.xlsx`**（`.txt` 静默返回空）。条目 `{"src","dst","info"}`；翻译 runner 按 **work unit 原文命中激活**（`resolve_activated_glossary_entries`），user 里格式 `src -> dst #info`。实测 9 个请求里 2 个带术语表（命中所在段）。
- **daemon**：术语来自站点每章 `glossary` 对象（或引擎提取的术语表），`{jp: zh}` 平面格式（无 info 列）；按**段内 `includes(jp)` 命中**注入 `jp => zh` 行。与 LG 同策略（段级激活、不全文注入），触发粒度一致。

### 4. 解析与重试

- **LG**：响应按行解析 JSONLINE，`id` 经 `Number()` 归一对账（`response-decoder.ts`）；缺失/解析失败条目**条目级重试**（`TRANSLATION_RETRY_LIMIT=3`），多次失败把 work unit **按 token 比例缩段重拆**（`(16/t)^0.25`），单条 3 次后 ERROR。网络层：key 冷却阶梯 15/30/60s、429 降并发并按 Retry-After、自动并发 4（下限 1 上限 16、429 减半）、单请求总时限 `request_timeout`（默认 180s）。
- **daemon**：`#(\d+)[:：]` 编号行解析；空行保留原文；缺失编号抛「行数不匹配」→ 段级重试（≤3 次）；「输出不是中文」（`detectChinese` 阈值）也重试；**显式行数检查连续 3 次失败且行数>1 → 二分拆分**（单行失败回退原文）。网络层：调度器双池（翻译 vs 助手/术语）、并发门/冷却/RPM、`SiteClient` 传输层重试、`retryAfterMs` 等待。
- 差异实质：LG 粒度到**条目**（只重试坏行，缩段找回），daemon 粒度到**段**（一坏全段重来，二分兜底）。daemon 的二分与站点语义一致是有意为之（行为镜像优先）。

### 5. 预过滤与空行

- **LG**：导入即预过滤（`create_project_commit` 内）：空行成 item 但**不发请求**（pre-pipeline 无可译内容 → `dst=src, PROCESSED`），纯符号行同样跳过——本例 300 行只有 178 进请求。
- **daemon**：`segmentLines` 不滤空行，300 行全进协议（空行 `#n:` 占编号，解析侧原样保留）。站点章节的 `paragraphJp` 通常没有大段空行，所以实际影响主要在 **import-lg / txt 回导路径**；代价是空行占比高时（本例 37%）浪费编号和 token。

### 6. 并发与输出

- 并发：LG 自动并发 4（1..16 自适应，429 减半，模型可显式 `concurrency_limit`/`rpm_limit`）；daemon 双池调度器（翻译池独立于助手/术语池），并发/RPM/逾时运行时可调（`jobRuntime`）。
- 输出：LG CLI 写 `<outputDir>/<rel_path>` + `<outputDir>/bilingual/<rel_path>`（GUI 导出才带 `_译文`/`_译文_双语对照` 后缀目录）；daemon 译文直接提交站点，本地导出走 `export-src`（一行一段 + 对齐清单）与 `import-lg`（三层校验回切）。

## 四、可借鉴点（仅记录，未改代码）

1. **条目级对账 + 缩段重试**：LG 只重试解析失败的子集，daemon 段级全有全无——长段里单行解析失败会拖整段重试。daemon 已有二分兜底，但「按 id/编号对账后只补缺行」是更省的重试形态（代价是与站点二分语义分叉）。
2. **空行不进请求**：LG 让空行在导入时直接落 `dst=src`，编号/token 都不花；daemon 的 txt 回导路径（import-lg）可以考虑同样的预过滤，站点在线路径不受影响。
3. **分段随模型预算**：LG 的 `max(8, token_limit/16)` 让每请求行数自适应模型上下文；daemon 的 1500/30 是站点镜像（有行为对齐价值），但给「非站点镜像模式」留一个 token 上限选项是低风险的增强。
4. **`<why>` 结构化思考**：强制模型先输出极简「语境/决策」块再给正文，解析侧剥除——对质量有可感知收益，且与 daemon 现有的可选思考指引兼容（可做成协议段）。
5. **术语表 info 列**：LG 的 `#类型`（人名/地名/组织…）进提示词给模型类型线索；daemon 的站点术语格式固定 `{jp: zh}`，若未来扩展可考虑附带类型说明。

## 五、复跑与产物索引

见 [`tools/lg-compare/README.md`](../tools/lg-compare/README.md)。当前 `artifacts/` 即本文引用的那次运行：

- `lg-requests.jsonl`：LG 9 个请求的完整 system/user（566 字符模板全文、术语表段、JSONLINE 输入块都在里面）
- `lg-status.jsonl`：CLI JSONL 状态事件（`started → progress(total=178,completed=178) → finished(done)`）
- `lg-out/lg-input.txt` + `lg-out/bilingual/lg-input.txt`：LG 导出的译文与双语
- `daemon-requests.jsonl`：daemon 10 个请求的完整 system/user
- `daemon-out.txt` / `daemon-out-bilingual.txt`：daemon 核心函数产出的译文与双语
