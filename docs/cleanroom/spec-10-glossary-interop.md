# spec-10：LG 术语表互通 / 规则导入导出（clean-room 行为规格）

借鉴对象：LinguaGacha 0.125 `backend/quality/quality-rule-file-io.ts`、`shared/quality/quality-rule-import.ts`、`domain/quality.ts`（思路参考，独立实现）。
实现位置：`daemon/glossary-io.mjs`（新增）+ `rules` 表（spec-08 引入）+ CLI `glossary-io`。
定位：与 LG 术语表/规则文件互通；站点侧写入仍走现有「快照 + 指南门槛 + 全量替换」安全路径。

## 1. 导入格式

- **LG JSON 数组**：`[{src, dst, info?, regex?, case_sensitive?}]`（字段名与之兼容；缺失字段按 false/空处理）。
- **LG 映射对象**：`{"src": "dst", ...}`（等价于 info 为空、regex=false）。
- 编码 UTF-8；解析失败 → 报错退出（不改任何站点数据）。
- 不支持：xlsx、RPG Maker 演员表、`.lg` 工程文件（列为将来可选）。

## 2. 分流规则

1. `regex === true` 的条目 → `rules` 表（`kind='pre_replacement'`，`regex=1`，`replacement=dst`，`pattern=src`，`enabled=0` 默认关闭，需人工确认后启用）；不进入站点术语表。
2. `case_sensitive === true` 的非 regex 条目 → 正常作为术语表候选，但记录提示「站点术语表为纯文本匹配，大小写标记已忽略」（导出时统一 false）。
3. 其余条目 → 站点术语表候选。
4. 候选值 = `dst` +（`info` 非空时）` #` + 清洗后的 info；info 清洗沿用 `formatGlossaryValue` 规则（≤8 字符、去标点、超限截断）。
5. 指南门槛：`suspectReasons(src)` 非空或 `looksLikeSourceTampering(src)` → **默认跳过**并计入报告（不写入、不进提案）；`--propose` 时进 `proposals(kind='import')`。

## 3. 导入流程

1. 解析文件 → 分流 → 构建候选集合（src 去重，后出现者覆盖并记录）。
2. 拉取当前站点术语表，计算 diff：`新增 / 更新（dst 或备注不同）/ 已存在相同 / 拦截`。
3. `--dry-run`（默认）：只打印/返回 diff 报告，不写站点。
4. `--apply`：走统一写入路径——`addSnapshot(当前)` → 合并（保留已有条目、应用更新与新增）→ `putGlossaryRaw` 全量替换 → 回读校验（比对 key 数量与值）；失败不回滚（快照可回滚），报错退出。
5. `--propose`：把拦截/更新类条目写入 `proposals(kind='import')`，等待审核。
6. 全过程遵循调度器（无 LLM 调用；本项不触网以外的模型请求）。

## 4. 导出流程

- 输入：站点当前术语表（web/wenku）。
- 输出：LG JSON 数组，逐条 `{src, dst, info, regex: false, case_sensitive: false}`；`dst/info` 来自 `splitGlossaryValue`（无备注时 info 为 `""`）。
- `--out <file>` 写文件；缺省 stdout；同时打印条数。
- 导出不含站点内部元数据；可被 LG 直接导入（列名兼容）。

## 5. CLI

```
node daemon/index.mjs glossary-io import <file.json> --book <key> [--apply] [--propose]
node daemon/index.mjs glossary-io export --book <key> [--out <file.json>]
```

## 6. 刻意差异（与 LG）

- LG 的 4 类规则（glossary/text_preserve/pre_replacement/post_replacement）我们只映射 regex 项到 pre_replacement；post_replacement 与 text_preserve 暂不参与导入（可按需手工建成 rules 行）。
- 不做重复预览对话框（CLI 报告 + dry-run 代替）。
- 不写 LG 的 `entry_id`（站点术语表是扁平字符串映射）。

## 7. 等价验证

- `daemon-test` 新增：往返 fixture（导出 → 导入 → diff 为空）、regex 分流落 `rules`、门槛拦截计数、`--dry-run` 不产生 PUT、`--apply` 触发快照 + PUT 且回读一致。
- 写类测试全部对 mock 的 `PUT .../glossary` 断言，绝不触网。
