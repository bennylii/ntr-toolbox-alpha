// daemon-agent-driver.mjs —— 本项目 daemon 的 Agent + 技能 离线驱动（与 LG agent 侧同维对比）
//
// 复用 daemon 的真实 Agent 内核：createAgentLoop（压缩→模型→顺序工具→审批 broker→回填）、
// 真 skills/ 技能目录（promptText 进 system + read_skill 工具读正文）、真 decision broker
// （write 审批挂起 → 驱动放行；ask_user 提问挂起 → 驱动作答），模型指向 mock 8790 的
// ?toolcall= 剧本（按轮次返回 tool_calls）。请求全文落盘到 artifacts/daemon-agent-requests.jsonl。
//
// 前置：PORT=8790 node mock-llm/server.mjs
// 用法：node tools/lg-compare/daemon-agent-driver.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL_DIR = path.join(REPO_ROOT, "tools", "lg-compare");
const ARTIFACT_DIR = path.join(TOOL_DIR, "artifacts");
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:8790/v1";
const DB_PATH = path.join(REPO_ROOT, "daemon", ".tmp-lgcmp-agent.db");

const mod = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
const { Store } = await mod("daemon/store.mjs");
const { LlmScheduler } = await mod("daemon/scheduler.mjs");
const { createAgentLlm } = await mod("daemon/agent-llm.mjs");
const { createAgentLoop } = await mod("daemon/agent-loop.mjs");
const { doingTool, askUserTool } = await mod("daemon/agent-tools.mjs");
const { createReadTools } = await mod("daemon/agent-tools-read.mjs");
const { createSkillCatalog } = await mod("daemon/agent-skills.mjs");

fs.rmSync(DB_PATH, { force: true });
const store = new Store(DB_PATH);
const skillCatalog = createSkillCatalog({ roots: [path.join(REPO_ROOT, "skills")], log: console });

// mock 剧本：read_skill(真技能) → doing → demo_write(审批) → ask_user(提问) → 终答
const scriptArgs = [
  { name: "glossary-workflow" },
  { text: "daemon agent 演示：进度汇报" },
  {},
  { question: "术语表有 3 条提案，先应用哪一批？", options: [{ id: "a", label: "全部应用" }, { id: "b", label: "先审一遍" }] },
];
const workerEndpoint = `${MOCK}?toolcall=read_skill,doing,demo_write,ask_user&toolargs=${encodeURIComponent(JSON.stringify(scriptArgs))}`;

const scheduler = new LlmScheduler({
  engine: { splitLines: (s) => String(s).split("\n") },   // agent 轮次用不到翻译 engine，给个无害桩
  store,
  log: { info: () => {}, warning: () => {}, error: (e) => console.error("[scheduler]", e) },
  options: { workers: [{ id: "mock", model: "mock-glossary-1", endpoint: workerEndpoint, key: "test-key" }], maxInFlight: 1 },
});
const agentLlm = createAgentLlm({ scheduler, log: console });

// 演示用审批写入工具（假操作）：走真 decision broker，展示 preview → 挂起 → resolve 回执
const demoWriteTool = {
  name: "demo_write",
  description: "演示用审批写入工具（假操作，不落任何真实数据）",
  parameters: { type: "object", properties: {} },
  requiresApproval: true,
  preview: async () => ({ summary: "演示写入：新增 1 条演示配置（假操作）", diff: "+ demo-entry" }),
  async execute() { return { ok: true, wrote: 1 }; },
};

const requestLog = [];
const chat = async (envelope = {}, opts = {}) => {
  requestLog.push({
    seq: requestLog.length + 1,
    time: new Date().toISOString(),
    tools: (envelope.tools || opts.tools || []).map((t) => t.function?.name ?? "?"),
    messages: envelope.messages ?? [],
  });
  return agentLlm.chat(envelope, opts);
};

const loop = createAgentLoop({
  store,
  chat,
  takeUsage: agentLlm.takeUsage,
  tools: [...createReadTools({ log: console }), doingTool, demoWriteTool, askUserTool],
  log: console,
  options: {
    approvalMode: "manual",
    maxSteps: 12,
    extraSystem: skillCatalog.promptText(),   // 技能目录进 system（与 index.mjs 装配同款）
    deps: { skills: skillCatalog },
  },
});

const events = [];
const sessionId = store.createAgentSession({ bookKey: "", title: "lg-compare-agent" });
const result = await loop.runTurn(sessionId, "@writing-guide 演示：技能点名注入 → read_skill → 审批写入 → 提问", {
  pinnedSkills: ["writing-guide"],
  onEvent: (e) => {
    events.push(e);
    if (e.type === "decision") setTimeout(() => loop.resolveDecision(e.decisionId, "allowed", { via: "driver" }), 0);
    if (e.type === "question") setTimeout(() => loop.resolveDecision(e.decisionId, "allowed", { selected: "a" }), 0);
  },
});

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.writeFileSync(path.join(ARTIFACT_DIR, "daemon-agent-requests.jsonl"), requestLog.map((r) => JSON.stringify(r)).join("\n") + "\n");
const roles = store.listAgentMessages(sessionId).map((m) => m.role);
fs.writeFileSync(path.join(ARTIFACT_DIR, "daemon-agent-timeline.json"), JSON.stringify({
  result,
  roles,
  events: events.map((e) => ({ type: e.type, ...(e.text ? { text: e.text } : {}), ...(e.decisionId ? { decisionId: e.decisionId } : {}) })),
}, null, 2));

const summary = {
  ok: result.ok === true,
  requests: requestLog.length,
  tool_sequence: roles.filter((r) => r === "tool").length,
  pinned_skill: events.some((e) => e.type === "skill_pinned"),
  decisions: events.filter((e) => e.type === "decision").length,
  questions: events.filter((e) => e.type === "question").length,
};
fs.writeFileSync(path.join(ARTIFACT_DIR, "daemon-agent-summary.json"), JSON.stringify(summary, null, 2));
store.close();

console.log(`[driver] ok=${summary.ok} requests=${summary.requests} toolResults=${summary.tool_sequence} pinned=${summary.pinned_skill} approvals=${summary.decisions} questions=${summary.questions}`);
console.log(`[driver] artifacts -> ${ARTIFACT_DIR}/daemon-agent-{requests.jsonl,timeline.json,summary.json}`);
if (!summary.ok) {
  console.error("[driver] runTurn 未成功：", JSON.stringify(result));
  process.exit(1);
}
