# spec-09：提示词模板（clean-room 行为规格）

借鉴对象：LinguaGacha 0.125 `work-unit-prompt-builder.ts`、`builtin/translation_prompt/template/*`（思路参考，独立实现）。
实现位置：`daemon/prompt.mjs`（新增）+ `prompts` 表（按书/全局模板文本）+ 翻译管线接线。
定位：让翻译提示词可配置（每书 base、可选 thinking 段），同时**协议段由代码生成**，模板不可能破坏站点契约与解析协议。

## 1. 模板结构

四段文本，默认值代码内置（zh）：

- `prefix`：角色与目标（默认沿用现有固定系统提示的等价表述）。
- `base`：任务说明主体；**必须包含占位符 `{format_rules}`**。
- `thinking`：模拟 CoT 的额外思考指引（默认关闭；开启时追加到用户消息开头，形如「先在心里分析……不要输出分析过程」）。
- `suffix`：输出前提醒（默认空）。

占位符（渲染时替换）：
- `{source_language}`、`{target_language}`（默认「日文」→「简体中文」）；
- `{format_rules}`：**代码注入的固定协议文本**，内容不可被模板覆盖，包含：
  1. 译文行数必须与原文相等；
  2. 不得输出任何解释/说明/额外内容；
  3. 编号（`#编号:`）由用户消息（「注意要保留每一段开头的编号」）与解析器共同保证；
  4. 单行段「原文到此为止」由代码在用户消息末尾追加，不靠模板。
- 默认模板渲染结果与站点镜像系统提示 `TRANSLATE_SYSTEM_PROMPT` **逐字相同**（全槽位默认时直接返回该常量，零行为变化）。

## 2. 渲染规则

1. `renderSystemPrompt(template)`：全槽位默认 → 直接返回 `TRANSLATE_SYSTEM_PROMPT`（逐字一致）；否则 `prefix + '\n' + base + (suffix ? '\n' + suffix : '')`，`{format_rules}` 被协议文本替换。
2. 模板无效判定：缺少 `{format_rules}`、渲染后不含协议关键词（行数/编号）或长度 <10 字符 → **整体回退默认模板**并记警告。
3. 用户消息由 `daemon/translate.mjs` 现有逻辑生成（术语表注入 + `#i:line` + 单行「原文到此为止」），模板系统不改动这部分结构；`thinking` 段追加在用户消息最前。
4. 模板来源优先级：该书 `prompts(bookKey)` → 全局 `prompts('')` → 代码默认。空文本 = 未设置。
5. 模板变更不影响段缓存键（提示词属于模型输入侧；如需强制重译，用 `translate --level all`）。

## 3. 存储与接口

- 新表 `prompts(bookKey TEXT, slot TEXT, text TEXT, updateAt INTEGER, PRIMARY KEY(bookKey, slot))`；`slot ∈ {prefix, base, thinking, suffix}`；`bookKey=''` 为全局。
- CLI：`prompt show|set|clear`（`--book`、`--slot`、`--file`/`--text`）；server：`GET /prompts?book=`、`POST /prompts`。
- 面板/UI 不在本阶段范围。

## 4. 刻意差异（与 LG）

- 不做多语言模板目录（zh/en 双语模板）、不做 `.txt` 样式预设库；只保留四槽 + 默认文本。
- 不做「prompt enhancement 实验室」自动实验；thinking 段仅手动开关。

## 5. 等价验证

- 纯函数用例（`daemon/prompt-test.mjs`）：渲染注入、缺失占位符回退、空白模板回退、`{source_language}` 替换、thinking 追加位置、按书覆盖全局。
- 协议不变量：渲染后的系统提示 + 用户消息仍满足 `buildTranslateMessages` 的解析假设（`translate-test` 现有 12 项保持全绿 + 1 项新增：模板渲染后协议关键词存在）。
