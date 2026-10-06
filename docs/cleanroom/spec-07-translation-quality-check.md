# spec-07：译文质检 / 校对（clean-room 行为规格）

借鉴对象：LinguaGacha 0.125 `shared/proofreading/proofreading-types.ts`、`translation-quality-rules.ts`、`proofreading-evaluator.ts`（思路参考，独立实现）。
实现位置：`daemon/quality.mjs`（新增纯函数）+ `check` job（`daemon/check-pipeline.mjs` 或并入既有管线模块）；CLI `check`、server `job=check`。
定位：与现有「验收回扫」（术语落地率）互补的多信号质检；只读站点数据，产出报告与可选提案，**不自动改站点**。

## 1. 输入

- 目标书（web/wenku）与可选参数：`--codes`（码集合）、`--limit`（样例上限）、`--translator`（译文源，默认 gpt）。
- 数据来源：`SiteClient.getAlignedPairs(book)`（jp/zh 段落对；web 走 `/file?mode=jp-zh`，wenku 走 chapter-task 段落数组）+ 当前术语表 + 可选 `rules`（text_preserve / 替换表，P3 提供）。
- 可选重试元数据：翻译管线写下的段级重试次数（`segmeta`：bookKey+segKey+retries）；无记录则 RETRY_THRESHOLD 码不触发。

## 2. 七种警告码（逐对检查，零依赖实现）

对每个 jp/zh 对齐对（按行进一步拆分：以行号/段落为单位，段落内多行逐行检查）：

1. `LINE_COUNT_MISMATCH`：jp 与 zh 的可译文行数不一致，或某行在译侧缺失。判定：段落行数不等，或空/非空模式不一致。
2. `FOREIGN_CHAR_RESIDUE`：译侧出现源语言字符残留——JA 源检测假名（`[\u3041-\u3096\u30A1-\u30FA\u31F0-\u31FF]`）。整行仅由假名/符号组成（疑似原文行）时同样告警；行内出现 ≥1 个且该行中文占比 < 50% 时告警；中文占比 ≥50% 的夹杂（引用、专有名词）不告警（容忍白名单行为）。
3. `SIMILARITY`：译侧与源侧高度相似（疑似漏译/直抄）——归一化（去空白与标点）后，一方包含另一方（长度 ≥8 字符）或字符集合 Jaccard 相似度 > 0.8 时告警。
4. `GLOSSARY`：术语未落地——术语 src 出现在 jp 行，但对应 dst 未出现在 zh 行。匹配沿用 `scanAcceptance` 的 matcher 语义（归一化、允许全角/半角与空白差异）；该术语同时出现在 zh 的其他行不算，只看对应行。
5. `TEXT_PRESERVE`：保留段/占位符在译侧缺失或改动——对 jp 行按 text_preserve 规则提取的片段集合，在 zh 行按同一规则应能找到等价片段；无规则或该行无命中时跳过。
6. `PUNCTUATION_MISMATCH`：句末标点结构不一致——jp 行以句末标点（`。！？…ー` 及全角变体）结尾而 zh 行未以对应中文标点（`。！？…`）结尾（或反之）；成对引号（`「」『』“”（）`）在 zh 行不平衡。
7. `RETRY_THRESHOLD`：该段翻译时重试次数 ≥2（读取 segmeta；站点既有译文无记录，不触发）。

## 3. 输出与落库

- 报告：`runs`（job=`check`）的 `statsJson`：`{pairs, lines, codes: {CODE: count}, samples: [{chapterId, lineIndex, code, jp, zh}]（≤limit），ms}`。
- 样例截断：jp/zh 各截 120 字符。
- 可选 `--propose`：把共性问题聚合为一条 `proposals(kind='quality')`（按码分组计数 + 每种码最多 5 条样例），等待人工处理；默认只出报告。
- 退出码：发现任何命中即为 0（报告型任务），站点错误才非 0。

## 4. 刻意差异（与 LG）

- ~~不做 grapheme 级 `Intl.Segmenter` 分类~~ → **v2 已对齐**（见下节 §6）。
- 不做交互式校对页/过滤 UI；报告落库与 CLI 输出 TSV（`--tsv` 输出到 stdout）；警告落库与控制台明细见 §6。
- 不警告「术语用错」（dst 出现在 zh 但 src 未出现）——站点指南不做反向控制。

## 5. 等价验证

- 纯函数用例（`daemon/quality-test.mjs` 或并入 translate-test）：每码至少 2 例（命中/不命中），含假名残留、CJK 引号、Jaccard 边界（0.79/0.81）、全角空白归一。
- 端到端：mock（`mock-trans*` 家族，web 族可造缺失行/漏译样例）+ daemon-test 断言报告码计数与样例数。

## 6. v2 算法升级（对齐 LinguaGacha，2026-10）

上述 §2 的 2/3/5/6 号码判定更新为 LG 同款算法（确定性启发式，无 LLM）：

- `FOREIGN_CHAR_RESIDUE`：**字素分割（`Intl.Segmenter`）+ 书写系统分类**（`\p{Script_Extensions=Han}` 允许，其余字母脚本=残留）；拉丁短串豁免（单字素 或 `^[A-Z]{2,4}$`，混其它脚本残留时不豁免）；相邻残留合并为片段（`fragments` 证据）。取代「假名 + 汉字占比 <50%」启发式——**任何量的假名夹杂现在都会告警**（LG 语义）。
- `SIMILARITY`：trim 后**原始文本**双向包含 或字符集 Jaccard > 0.8；新增 **JA→ZH 护栏**——命中后还需 `FOREIGN_CHAR_RESIDUE` 有片段证据才最终触发（防汉字-heavy 的合法直译误报；`requireResidueEvidence:false` 可关）。
- `PUNCTUATION_MISMATCH`：**标点组序列**逐位比对（引号变体合并为一组；圆/方/花括号与书名号开闭分明、顺序敏感）；不再有「句末标点」单项检查（LG 无此项）。
- `TEXT_PRESERVE`（**实装**）：两侧按处理链同款规则（`collectPreserveSegments`，priority 顺序、占位替换防重叠）提取受保护片段，逐位比对；不等返回 `{sourceFragments, translationFragments}` 证据。此前为空实现（恒不触发）。

警告持久化与消费（v2 新增）：

- `warnings` 表（bookKey/chapterId/lineNo/code/detail/evidenceJson/runId/at）：每次 check **全量替换**该书落库（onHit 全量采集，不受 `--codes` 报告过滤影响）；lineNo = 该章内配对序号（1 基），整书级命中为 0。
- 端点 `GET /warnings?book=&code=&limit=`（摘要 + 明细）；agent 只读工具 `list_warnings`；工作区数据集 `warnings/entries.jsonl`（agent 的 item-review 式流程可用）；控制台项目详情显示按码计数与前 20 条。
- 消费方式与 LG 的差异：LG 校对结果只驻内存 + 导出前摘要 + 校对页；我们**落库**（SQLite）供端点/工具/工作区复用，重跑 check 即刷新。

## 7. 内置保护规则预设（对齐 LG `builtin/text_preserve/preset`）

- 库文件 `daemon/presets/text_preserve.json`：`base`（`<br>` / 空白符 / LG 资源 URI）恒用；`kag` / `renpy`（引擎命令 `{...}`/`[...]`，含 `\p{Script=…}`，编译带 `u` 旗标对齐 LG 的 `giu`）/ `rpgmaker` / `wolf`（各 18 条控制码）按 `config.textPreserve.preset` **叠加**选择；`none` = 完全关闭（含 base）；
- 解析层 `daemon/preserve.mjs`：`effectivePreserveRules(store, bookKey, {forPrep})` = 预设（base + 所选层）与用户 `text_preserve` 规则按 **pattern 去重**（用户规则优先）；`forPrep=true` 剔除 checkOnly 项；
- **checkOnly** 语义：空白符与 LG 资源 URI 只参与质检比对（且比对时按 LG 语义过滤空白片段），**不进翻译预处理链**（逐字符占位会污染提示词）；
- 消费：`check-pipeline` 与 agent `quality_report` 走检查版；`processorFromStore` 走 prep 版（翻译准备即保护所选预设片段，缺失时按既有"保留段缺失"逻辑补回/告警）；
- 对照 LG：LG 的 `build_text_preserve_rule({mode,text_type,entries})` = base +（off/custom/按 text_type 智能层）；我们等价物 = base +（none/按名叠加层）+ 用户规则常驻（用户规则不因切换预设而失效，属刻意差异）。
