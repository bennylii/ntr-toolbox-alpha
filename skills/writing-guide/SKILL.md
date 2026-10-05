---
name: writing-guide
description: 创作、续写、改写、润色文本，进行翻译或译名选择，判断文本表达质量时使用的写作准则前置技能。
disable-model-invocation: true
---

写作准则的前置路由。三个工作流技能（translation-workflow / glossary-workflow / quality-workflow）在执行前都应先加载本指南；约定：名字以 `writing-guide-` 开头的用户技能同样属于这套前置。

- 用户指令与已有上下文足以确定应加载资源时，直接读取对应资源，然后按其中要求执行。
- 如有需要可以读取多份资源，组合使用。

|请求类别|加载内容|
|---|---|
|所有任务|当前可用且尚未加载的 `writing-guide` 及全部 `writing-guide-` 前缀技能|
|翻译、译名选择或译文审校|`references/translation-guide.md`|
|创作、续写、改写、润色或质量诊断|`references/creative-guide.md`|

读完对应资源后，回到发起任务的工作流技能继续执行。
