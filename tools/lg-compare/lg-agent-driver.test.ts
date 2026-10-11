import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { it } from "vitest";

import { BackendResources } from "../bootstrap/backend-resources";
import { BackendServices } from "../bootstrap/backend-services";
import { AgentService } from "../agent/agent-service";
import { AgentSkillsService } from "../agent/agent-skills-service";
import { AgentWorkspaceService } from "../agent/workspace/service";
import { AgentWorkspaceRunner } from "../agent/workspace/runtime/runner";

/**
 * LG Agent 全链路离线驱动（跨仓库对比工具，由 ntr-toolbox-glossary 的
 * tools/lg-compare/run-lg-flow.mjs agent 子命令复制进来运行）。
 *
 * 剧本化 stub 扮演 agent 模型（OpenAI 兼容 SSE tool_calls；请求带 tools 数组 → agent 分支，
 * 不带 → 批量翻译的 jsonline 回显分支），其余全部真实：
 * 真 read_skill（builtin/skills/glossary）→ 真 workspace_run（CodeAct 沙箱跑提取脚本，
 * 写 changes/glossary/creates.jsonl）→ 真 workspace_apply（manual 审批挂起 → 驱动放行）→
 * 事务落 rules 表 → 真 run_batch_item_translation（批量引擎带术语表翻译）。
 *
 * 环境变量：LG_COMPARE_ARTIFACTS / LG_COMPARE_INPUT / LG_COMPARE_PORT（stub 端口）。
 * 沙箱运行时目录：LG_COMPARE_WORKSPACE_RUNTIME（= <LG>/build/resources/workspace）。
 */

const ARTIFACT_DIR = process.env.LG_COMPARE_ARTIFACTS ?? "";
const INPUT_TXT = process.env.LG_COMPARE_INPUT ?? "";
const STUB_PORT = Number(process.env.LG_COMPARE_PORT ?? 8998);
const WORKSPACE_RUNTIME = process.env.LG_COMPARE_WORKSPACE_RUNTIME ?? "";

function assert_env(): void {
  const missing = Object.entries({
    LG_COMPARE_ARTIFACTS: ARTIFACT_DIR,
    LG_COMPARE_INPUT: INPUT_TXT,
    LG_COMPARE_WORKSPACE_RUNTIME: WORKSPACE_RUNTIME,
  })
    .filter(([, value]) => value === "")
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`lg-agent-driver 需要环境变量：${missing.join(", ")}（由 run-lg-flow.mjs 注入）`);
  }
}

// ---------------------------------------------------------------------------
// 剧本化 stub：agent 轮次（带 tools）按 tool 结果条数推进；批量翻译轮次走 jsonline 回显
// ---------------------------------------------------------------------------

interface ToolCallStep {
  name: string;
  args: Record<string, unknown>;
}
type AgentStep = ToolCallStep | { final: string };

/** 术语提取剧本：read_skill 三连 → workspace_run 写 changes → workspace_apply（审批）→ 批量翻译 → 终答 */
const WORKSPACE_SCRIPT = [
  "import fs from 'node:fs';",
  "const rows = fs.readFileSync('items/entries.jsonl', 'utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));",
  "const text = rows.map((r) => String(r.src ?? r.text ?? '')).join('\\n');",
  "const terms = [",
  "  { src: '天宮繭', dst: '天宫茧', info: '女性人名', case_sensitive: false, sort: -1 },",
  "  { src: '胡桃みくる', dst: '胡桃美久', info: '女性人名', case_sensitive: false, sort: -1 },",
  "  { src: 'GF文庫', dst: 'GF文库', info: '组织', case_sensitive: false, sort: -1 },",,
  "];",
  "const hits = terms.filter((t) => text.includes(t.src));",
  "fs.mkdirSync('changes/glossary', { recursive: true });",
  "fs.writeFileSync('changes/glossary/creates.jsonl', hits.map((t) => JSON.stringify(t)).join('\\n') + '\\n');",
  "if (typeof ws !== 'undefined' && ws && typeof ws.doing === 'function') { await ws.doing(`术语提取：命中 ${hits.length} 条，已写 changes/glossary/creates.jsonl`); }",
  "console.log(JSON.stringify({ items: rows.length, hits: hits.map((h) => h.src) }));",
].join("\n");

const AGENT_SCRIPT: AgentStep[] = [
  { name: "read_skill", args: { name: "glossary" } },
  { name: "read_skill", args: { name: "glossary", path: "references/extract.md" } },
  { name: "read_skill", args: { name: "glossary", path: "references/rule.md" } },
  { name: "workspace_run", args: { script: WORKSPACE_SCRIPT } },
  { name: "workspace_apply", args: {} },
  { name: "run_batch_item_translation", args: { scope: { kind: "all" }, include_errors: false } },
  { final: "提取与翻译都完成了：术语表 3 条已通过 workspace_apply 落库；批量翻译已由引擎直写。" },
];

interface RequestLogEntry {
  seq: number;
  time: string;
  model: string;
  agent_branch: boolean;
  tool_names: string[];
  n_tool_results: number;
  messages: Array<{ role: string; content: unknown }>;
  reply_tool_call?: { name: string; args: unknown };
  reply_final?: string;
}

const request_log: RequestLogEntry[] = [];

function extract_last_jsonline(text: string): Array<{ id: string; text: string }> {
  const lines = text.split(/\r?\n/);
  const blocks: string[][] = [];
  let inside = false;
  let current: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("```")) {
      if (!inside) { inside = true; current = []; } else { blocks.push(current); inside = false; }
      continue;
    }
    if (inside) current.push(line);
  }
  const payload = blocks.length > 0 ? blocks[blocks.length - 1]! : [];
  const entries: Array<{ id: string; text: string }> = [];
  for (const raw of payload) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const id = obj["id"];
      if ((typeof id === "string" || typeof id === "number") && typeof obj["text"] === "string") {
        entries.push({ id: String(id), text: obj["text"] });
      }
    } catch { /* 坏行跳过 */ }
  }
  return entries;
}

function message_text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text ?? "") : "")).join("");
  }
  return "";
}

function start_stub_server(): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: { model?: string; stream?: boolean; messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }>; stream_options?: { include_usage?: boolean } } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
      const messages = body.messages ?? [];
      const tool_names = (body.tools ?? []).map((t) => t.function?.name ?? "?");
      const model = body.model ?? "mock-llm";

      const send_sse = (deltas: Array<Record<string, unknown>>, finish_reason: string) => {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
        const chunk = (delta: Record<string, unknown>, fr: string | null, usage?: unknown) => {
          const payload: Record<string, unknown> = {
            id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model,
            choices: [{ index: 0, delta, finish_reason: fr }],
          };
          if (usage !== undefined) payload["usage"] = usage;
          res.write("data: " + JSON.stringify(payload) + "\n\n");
        };
        chunk({ role: "assistant" }, null);
        for (const d of deltas) chunk(d, null);
        chunk({}, finish_reason);
        if (body.stream_options?.include_usage) chunk({}, null, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        res.write("data: [DONE]\n\n");
        res.end();
      };

      let entry: RequestLogEntry;
      if ((body.tools?.length ?? 0) > 0) {
        // agent 分支：按 tool 结果条数推进剧本
        const tool_rounds = messages.filter((m) => m.role === "tool").length;
        const step = AGENT_SCRIPT[Math.min(tool_rounds, AGENT_SCRIPT.length - 1)]!;
        entry = {
          seq: 0, time: new Date().toISOString(), model, agent_branch: true,
          tool_names, n_tool_results: tool_rounds, messages: messages as Array<{ role: string; content: unknown }>,
        };
        if ("final" in step) {
          entry.reply_final = step.final;
          send_sse([{ content: step.final }], "stop");
        } else {
          entry.reply_tool_call = { name: step.name, args: step.args };
          send_sse([{
            tool_calls: [{
              index: 0, id: `call_stub_${tool_rounds + 1}`, type: "function",
              function: { name: step.name, arguments: JSON.stringify(step.args) },
            }],
          }], "tool_calls");
        }
      } else {
        // 批量翻译分支：jsonline 回显
        const full_text = messages.map((m) => message_text(m.content)).join("\n");
        const entries = extract_last_jsonline(full_text);
        const content = "```jsonline\n" + entries.map((e) => JSON.stringify({ id: e.id, text: "【LG译】" + e.text })).join("\n") + "\n```";
        entry = {
          seq: 0, time: new Date().toISOString(), model, agent_branch: false,
          tool_names, n_tool_results: messages.filter((m) => m.role === "tool").length,
          messages: messages as Array<{ role: string; content: unknown }>,
        };
        send_sse([{ content }], "stop");
      }
      entry.seq = request_log.push(entry);
    });
  });
}

// ---------------------------------------------------------------------------
// 驱动主体
// ---------------------------------------------------------------------------

const request_log_path = path.join(ARTIFACT_DIR, "lg-agent-requests.jsonl");

it(
  "LG Agent 全链路离线驱动（技能→沙箱提取→审批落库→批量翻译）",
  { timeout: 600_000 },
  async () => {
    assert_env();
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.rmSync(request_log_path, { force: true });
    request_log.length = 0;

    const server = start_stub_server();
    await new Promise<void>((resolve) => server.listen(STUB_PORT, "127.0.0.1", () => resolve()));
    const app_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-agent-app-"));
    fs.writeFileSync(path.join(app_root, "version.txt"), "0.0.0");
    const lg_root = path.resolve(import.meta.dirname, "../../..");
    const project_path = path.join(app_root, "agent-compare.lg");

    let resources: BackendResources | null = null;
    let services: BackendServices | null = null;
    let failure: unknown = null;
    try {
      resources = await BackendResources.start({
        appRoot: app_root,
        builtinRoot: path.join(lg_root, "builtin"),
        logTargets: { console: false, window: false },
        systemProxyResolver: { resolveProxy: async () => "DIRECT" },
      });
      services = new BackendServices({
        paths: resources.paths,
        metadata: resources.metadata,
        appSettingService: resources.settings,
        database: resources.database,
        logManager: resources.logManager,
        publishEvent: () => undefined,
        openOutputFolder: async () => undefined,
        workerExecution: { kind: "in_process" },
      });

      // agent 模型 + 批量翻译模型都指向同一 stub（按请求是否带 tools 区分角色）；
      // 审批显式 manual，让 workspace_apply 走真实挂起 → 驱动放行的往返
      services.app.settings.save_setting({
        ...services.app.settings.read_setting(),
        agent_approval_mode: "manual",
        models: [{
          id: "mock-openai-1",
          type: "CUSTOM_OPENAI",
          name: "Mock LLM",
          api_format: "OpenAI",
          api_url: `http://127.0.0.1:${STUB_PORT}/v1`,
          api_key: "sk-anything",
          auth_type: "api_key",
          model_id: "mock-llm",
          request: { speed_level: "DEFAULT", extra_headers: {}, extra_body: {}, extra_headers_custom_enable: false, extra_body_custom_enable: false },
          threshold: { input_token_limit: 512, output_token_limit: 4096, rpm_limit: 0, concurrency_limit: 0 },
          thinking: { level: "OFF" },
          generation: { temperature: 0.95, temperature_custom_enable: false, top_p: 0.95, top_p_custom_enable: false },
        }],
        model_selection: { translation: "mock-openai-1", agent: "mock-openai-1", agent_batch_translation: "mock-openai-1" },
      });

      // 建工程并保持 loaded（AgentService.send_message 要求已加载工程）
      await services.project.lifecycle.create_project_commit({
        path: project_path,
        source_paths: [INPUT_TXT],
        project_settings: { source_language: "JA", target_language: "ZH" },
      });

      // Agent 协作者装配（照抄 gui-backend-bootstrap，宿主端口全部假实现）
      const images_stub = { prepare: async () => { throw new Error("image host unavailable in driver"); }, clear: async () => undefined };
      const runner = new AgentWorkspaceRunner({
        runtimeDirectory: WORKSPACE_RUNTIME,
        systemProxyResolver: async () => "DIRECT",
        paths: resources.paths,
      });
      const workspace = new AgentWorkspaceService({
        images: images_stub,
        paths: resources.paths,
        settings: resources.settings,
        sessionState: services.state.session,
        cache: services.state.cache,
        proofreading: services.proofreading.query,
        database: resources.database,
        runtimeGate: services.state.runtimeGate,
        writeStore: services.state.writes,
        logManager: resources.logManager,
        run: runner.run.bind(runner),
        pdfHost: undefined,
        runtimeDirectory: WORKSPACE_RUNTIME,
        openDirectory: async () => undefined,
        pickSavePath: async () => null,
      });
      const skills = new AgentSkillsService(resources.paths, resources.settings, resources.logManager, services.state.runtimeGate);
      const agent = new AgentService({
        auth: services.modelAuth,
        skills,
        catalog: services.modelCatalog,
        batchTranslation: services.batchTranslation,
        paths: resources.paths,
        settings: resources.settings,
        userAgent: "LinguaGacha/lg-compare",
        sessionState: services.state.session,
        runtimeGate: services.state.runtimeGate,
        webSearch: undefined,
        workspace,
        images: images_stub,
        logManager: resources.logManager,
        publish: () => undefined,
      });
      await agent.load_resources();

      // 发消息 → 轮询快照；write_approval 挂起时自动放行
      await agent.send_message({ text: "帮我提取术语", attachments: [] });
      const deadline = Date.now() + 480_000;
      let resolved_approvals = 0;
      for (;;) {
        const snapshot = agent.get_snapshot();
        if (snapshot.state === "idle") break;
        if (snapshot.pendingDecision !== null && snapshot.pendingDecision !== undefined) {
          const decision = snapshot.pendingDecision as { kind?: string; id?: string | number };
          if (decision.kind === "write_approval" && decision.id !== undefined) {
            resolved_approvals += 1;
            agent.resolve_write_approval({ id: decision.id, decision: "allow_once" });
          } else if (decision.kind === "question" && decision.id !== undefined) {
            throw new Error(`剧本未预期出现 question 决策：${JSON.stringify(decision)}`);
          }
        }
        if (Date.now() > deadline) throw new Error(`agent 一轮超时未结束：state=${snapshot.state} approvals=${resolved_approvals}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      // 断言：术语已落 rules 表
      const glossary_rules = resources.database.get_rules(project_path, "glossary") as unknown;
      fs.writeFileSync(path.join(ARTIFACT_DIR, "lg-agent-glossary.json"), JSON.stringify(glossary_rules, null, 2));

      // 断言：agent 内的批量翻译请求带上了术语表
      const translation_reqs = request_log.filter((r) => !r.agent_branch);
      const with_glossary = translation_reqs.filter((r) => r.messages.some((m) => message_text(m.content).includes(" -> ")));
      const summary = {
        agent_requests: request_log.filter((r) => r.agent_branch).length,
        translation_requests: translation_reqs.length,
        translation_requests_with_glossary: with_glossary.length,
        glossary_rules_count: Array.isArray(glossary_rules) ? glossary_rules.length : 0,
        write_approvals_resolved: resolved_approvals,
        tool_call_sequence: request_log.filter((r) => r.agent_branch && r.reply_tool_call).map((r) => r.reply_tool_call!.name),
      };
      fs.writeFileSync(path.join(ARTIFACT_DIR, "lg-agent-summary.json"), JSON.stringify(summary, null, 2));
      const snapshot_final = agent.get_snapshot() as { entries?: Array<Record<string, unknown>>; sessionId?: string; state?: string };
      fs.writeFileSync(
        path.join(ARTIFACT_DIR, "lg-agent-timeline.json"),
        JSON.stringify({
          sessionId: snapshot_final.sessionId,
          state: snapshot_final.state,
          entries: (snapshot_final.entries ?? []).slice(-40).map((e) => {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(e)) {
              const text = typeof v === "string" ? v : JSON.stringify(v);
              out[k] = typeof text === "string" && text.length > 400 ? text.slice(0, 400) + "…" : v;
            }
            return out;
          }),
        }, null, 2),
      );
    } catch (error) {
      failure = error;
    } finally {
      try { await services?.dispose(); } catch { /* ignore */ }
      try { await resources?.dispose(); } catch { /* ignore */ }
      server.close();
      fs.writeFileSync(request_log_path, request_log.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }

    if (failure !== null) throw failure;
  },
);
