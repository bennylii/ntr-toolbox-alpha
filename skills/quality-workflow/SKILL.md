---
name: quality-workflow
description: 质检报告的解读与审校处理流程（七码：假名残留/相似度/术语未落地/标点/缺译/保留段/重试阈值），含自启发审校循环与种子账本。看到质检结果、或用户问"译文哪里有问题"时先读本技能；逐码判据与误报排除见 references/review.md。
---

# 质检工作流（NTR Daemon）

> 前置：先读 `writing-guide`（含 `writing-guide-` 前缀技能）再按本流程执行。


## 数据含义
`quality_report` / `check` 输出的七个码，逐对（原文行 ↔ 译文行）判定。取证命令一列是"先看事实"的入口，逐码判据/误报/处置详见 `references/review.md`：

| 码 | 含义 | 常见原因 | 取证命令 | 处理 |
|---|---|---|---|---|
| `LINE_COUNT_MISMATCH` | 缺译/行数不符 | 章节没翻完、译文缺失标记 | `book_status` 段数对照 + `read_book` 尾部（确认原文在哪、译文缺在哪） | 补翻（expire 档） |
| `FOREIGN_CHAR_RESIDUE` | 译文里残留假名 | 漏译整段、模型直抄原文 | `read_translations` 取该行上下文；`workspace_run` 扫 `warnings/entries.jsonl` 聚合同类片段 | 重译该段；疑似整章则整章重跑 |
| `SIMILARITY` | 译文≈原文 | 同上 | 同 `FOREIGN_CHAR_RESIDUE` | 同上 |
| `GLOSSARY` | 术语未落地 | 术语表后加的 / 译名不一致 | `read_translations` 看该术语出现处；`list_proposals` 看是否刚写过术语 | 转 `glossary-workflow` |
| `PUNCTUATION_MISMATCH` | 句末标点/引号不一致 | 模型输出风格 | `workspace_run` 按码聚合统计；抽样 `read_translations` | 轻量问题，优先级低；同一章大量出现才处理 |
| `TEXT_PRESERVE` | 保留段（标签/控制码）缺失 | 翻译时丢了占位符 | `read_book` 取原文行里的控制符，对照译文该行 | 重译该段，确认处理链规则（`text-preserve` 技能） |
| `RETRY_THRESHOLD` | 该章翻译时重试 ≥2 次 | 上游不稳/原文难 | `book_status` 的 run stats（哪些章重试）+ `read_translations` 抽样 | 人工看一眼译文即可，不一定要动 |

## 审校循环（自启发 + 种子账本）

目标不是把七码全倒一遍，而是按证据滚动收敛（循环形态对齐 LG `item-review`）：

1. **循环入口**：有落库警告时，用警告条目作本轮数据集；没有警告时，从至少 3 个不连续的内容区域分散采样（`read_translations` 分页）。
2. **批量取证优先**：绑定项目的会话先 `workspace_run` 写脚本扫工作区数据集 `warnings/entries.jsonl`（只读、行内带 `chapterId/lineNo/code/detail/evidence`），在沙箱里完成按码聚合、按章聚类、抽样挑选；无绑书或没有数据集时才用 `list_warnings` 分页。只把需要语义判断的行带回对话。
3. **种子**：从任务目标、已有材料和调查结果中提炼可检索的特征线索（种子），方向包括——扩展同类（发现"毎日"漏译 → 检索其他时间限制行）、核验差异（同词异译 → 结合语境判断）、追查关联（确认身份/术语后复核受影响的条目）。每轮由种子发现下一批调查目标，再从结果提炼新种子。
4. **种子账本** `work/review-seeds.json`（用 `workspace_run` 读写，结构照 LG）：
   ```jsonc
   {
     "completedRounds": 1,          // 已完成的轮次
     "seeds": {
       "1": [                       // 发现该种子的轮次
         { "pattern": "检索原文同时含「毎日」和「最大」的条目，核验译文是否保留每日数量上限。", "consumed": true }
       ]
     }
   }
   ```
   账本是实时状态机而非汇总报告：**每轮必须更新、禁止跨轮补写**；轮次从 `1` 开始；完成取证与处置后把目标种子置 `consumed: true`，受阻或需补查的保持 `false`。
5. **收敛条件**（三条同时满足）：任务目标完成 + 本轮无新种子且账本全部消耗 + `completedRounds >= 3`；轮次不足且无未消耗种子时，回到第 1 步重新分散采样。

## 处置映射（只产提案，不直写译文）

- **个别行** → 生成修句**提案**（把问题行、证据、建议译文整理成条目，走提案+审批链路），不直接改译文；
- **整章** → `run_check` 复核确认后，建议用户用 `run_translate`（expire 档）重跑该章（写操作，需审批）；
- **术语类** → 转 `glossary-workflow`（先证据后写入，走审批）；
- **`RETRY_THRESHOLD`** → 只读人工判断，不改数据；确认译文没问题就保留结论。

## 汇报规范

- 只挑重点码与重点章节汇报，不要把七码全倒给用户；
- 写清调查范围与覆盖程度（程序扫描 vs 逐条语义判断）、每项修正/保留的依据、未决事项与继续条件；
- 涉及术语落地率时引用 `acceptance-scan` 的口径：**落地率 = 已落地 ÷（已落地 + 未落地）**。

## 边界
- 质检本身只读，不改任何数据；修复动作都要经过审批或提案；
- **红线**：本流程只产提案与建议，绝不直写译文（LG 的 agent 能改 items，我们走提案+审批）；
- 不要为了让报告好看而放宽判定（阈值改动属设置变更，先问用户）。
