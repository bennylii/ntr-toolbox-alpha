# spec-08：预处理 / 后处理链（clean-room 行为规格）

借鉴对象：LinguaGacha 0.125 `shared/text/*`、`translation-output-restoration.ts`、`translation-post-pipeline.ts`（思路参考，独立实现）。
实现位置：`daemon/processors.mjs`（新增纯函数）+ 内置预设 `daemon/presets/*.json` + `rules` 表（P3 新增）+ 翻译管线接线（发送前 / 落库前）。
定位：提升译文质量的可配置文本处理链；**不改变站点契约**（行数、段落数、上传格式一律不变）。

## 1. 处理链与顺序

对每个待翻译段落（行）执行：

**发送前（pre）**
1. 资源投影：URL、HTML/XML 标签、`\N[...]`/`\n[...]` 控制码、`@[ruby=...]` 等 → 临时占位符 `\uE000{n}\uE001`（n 从 0 递增，逐行独立）；投影记录在行上下文。
2. ruby 清洗（可选开关）：`(漢字/かんじ)`、`[ruby text=...]`、`｜漢字《かんじ》` 等模式按规则剥离注音，保留基字。
3. text_preserve：按规则匹配的片段替换为保留占位符（`\uE100{n}\uE101`），供翻译后回填校验。
4. 前替换表：literal 或 regex（按 priority 升序），可 case_sensitive。

**发送后（post）**
5. 后替换表：同上，作用于译文。
6. preserve 回填：把 zh 行中的保留占位符还原为对应原文片段；缺失时常规化为原文片段并记警告。
7. 资源还原：占位符还原为原文资源文本。
8. 标点稳定化：源行句末标点映射为中文等价（`！`→`！`、`?`→`？` 等半角归一、`～`→`～`）；成对引号按映射表归一为中文引号（`“”`→`「」` 可选，默认只做半角→全角）。
9. 转义/特殊序列还原：反斜杠串长度还原、圈号（①-㊿）保留原样。

## 2. 硬不变量

1. 行数不变：处理前后行数相等；还原失败的行**回退为原文**并记录警告（不丢内容、不抛异常）。
2. 段落数不变：管线只在段落内处理，段落划分与上传段落数与站点 DTO 完全一致。
3. 占位符不得泄漏：任何未被还原的 `\uE000-\uE1FF` 占位符视为失败 → 该行回退原文 + 警告。
4. 处理链幂等性检查：对同一输入重复应用 pre 不得叠加占位符错乱（相同规则第二次应用应为 no-op 或被显式阻止）。

## 3. 规则来源与存储

- 新表 `rules(id, bookKey, kind, pattern, replacement, regex, case_sensitive, enabled, priority, note, updateAt)`：
  - `kind ∈ {text_preserve, pre_replacement, post_replacement}`（P5 导入的 LG regex 条目也落这里）；
  - `bookKey` 为空字符串 = 全局规则；否则仅作用于该书；
  - `priority` 升序执行，同优先级按 id 升序；
  - `regex=true` 时用 `RegExp(pattern, case_sensitive ? 'g' : 'gi')`，无效正则 → 跳过并记警告。
- 内置预设：`daemon/presets/base.json`（占位符投影 + 标点稳定化开关 + 空规则表）；启动时按 `enabled` 合并（用户规则优先于预设，同 kind 内按 priority）。
- 开关：`processors.enabled`（默认 true，仅对 daemon 翻译生效）、`processors.rubyClean`（默认 false）、`processors.punctuation`（默认 true）。

## 4. 接线

- 翻译管线：`segmentLines` 之后、`buildTranslateMessages` 之前做 pre；`parseTranslateAnswer` 之后、写段缓存/合并之前做 post。
- 段缓存键：包含处理链版本与规则哈希（`segKey = sha1(JSON.stringify(seg) + chainVersion)`），规则变更后旧缓存自动失效。
- 质检（P2）的 TEXT_PRESERVE 码读取同一套 preserve 规则。

## 5. 刻意差异（与 LG）

- 不移植多格式（KAG/RenPy/RPGMaker/WOLF）智能预设与 PDF/字幕专用处理器；只保留通用 base。
- 不做控制码样本注入提示词（LG 会在系统提示提到控制码时附样本）；保持现有站点镜像提示词语义。

## 6. 等价验证

- 纯函数用例（`daemon/processors-test.mjs`）：占位符投影/还原往返、ruby 清洗、前后替换顺序、标点归一、失败回退原文、行数不变量、规则禁用/全局与按书优先级、无效正则跳过。
- 集成：mock 文本含 URL/标签/控制码，翻译往返后断言还原一致；`translate-test` 现有 12 项保持全绿。
