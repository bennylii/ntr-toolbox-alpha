import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { it } from "vitest";

import { BackendResources } from "../bootstrap/backend-resources";
import { BackendServices } from "../bootstrap/backend-services";
import { run_cli_job } from "../../cli/job/cli-job-runner";
import { CLIJsonStatusReporter } from "../../cli/cli-status-reporter";

/**
 * 离线全链路驱动（跨仓库对比工具，由 ntr-toolbox-glossary 的 tools/lg-compare/run-lg-flow.mjs 复制进来运行）：
 * 内置 OpenAI 兼容 stub 端点（流式 SSE）→ BackendResources/BackendServices 进程内装配（workerExecution=in_process，
 * 不需要 Electron）→ run_cli_job（导入 txt → 术语表注入 → 批量翻译 → 导出译文/双语）→
 * 全部 LLM 请求的完整 system/user 提示词与状态事件落盘到 LG_COMPARE_ARTIFACTS。
 *
 * 环境变量（由 launcher 注入，缺一不可）：
 * - LG_COMPARE_ARTIFACTS：产物目录（lg-requests.jsonl / lg-status.jsonl / lg-out/ 写这里）
 * - LG_COMPARE_INPUT：待翻译 txt（一行一条目）
 * - LG_COMPARE_GLOSSARY：术语表 JSON（[{src,dst,info}]，仅 .json/.xlsx 会被质量规则加载器读取）
 * - LG_COMPARE_PORT：stub 端口（默认 8999）
 */

const ARTIFACT_DIR = process.env.LG_COMPARE_ARTIFACTS ?? "";
const INPUT_TXT = process.env.LG_COMPARE_INPUT ?? "";
const GLOSSARY_JSON = process.env.LG_COMPARE_GLOSSARY ?? "";
const STUB_PORT = Number(process.env.LG_COMPARE_PORT ?? 8999);

function assert_env(): void {
  const missing = Object.entries({ LG_COMPARE_ARTIFACTS: ARTIFACT_DIR, LG_COMPARE_INPUT: INPUT_TXT, LG_COMPARE_GLOSSARY: GLOSSARY_JSON })
    .filter(([, value]) => value === "")
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`lg-flow-driver 需要环境变量：${missing.join(", ")}（由 tools/lg-compare/run-lg-flow.mjs 注入）`);
  }
}

interface StubEntry {
  id: string;
  text: string;
}

/** 取提示词里最后一个 ```jsonline 块并解析 {"id","text"} 条目（兼容数字/字符串 id 与单键旧格式）。 */
function extract_last_jsonline(text: string): StubEntry[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[][] = [];
  let inside = false;
  let current: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("```")) {
      if (!inside) {
        inside = true;
        current = [];
      } else {
        blocks.push(current);
        inside = false;
      }
      continue;
    }
    if (inside) current.push(line);
  }
  const payload = blocks.length > 0 ? blocks[blocks.length - 1]! : [];
  const entries: StubEntry[] = [];
  for (const raw of payload) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const id = obj["id"];
      const id_ok = typeof id === "string" || typeof id === "number";
      if (id_ok && typeof obj["text"] === "string") {
        entries.push({ id: String(id), text: obj["text"] });
      } else if (Object.keys(obj).length === 1) {
        const key = Object.keys(obj)[0]!;
        entries.push({ id: key, text: String(obj[key] ?? "") });
      }
    } catch {
      // 坏行跳过
    }
  }
  return entries;
}

function start_stub_server(request_log_path: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body_text = Buffer.concat(chunks).toString("utf8");
      let body: { model?: string; stream?: boolean; messages?: Array<{ role: string; content: string }>; stream_options?: { include_usage?: boolean } } = {};
      try {
        body = JSON.parse(body_text);
      } catch {
        // ignore
      }
      const messages = body.messages ?? [];
      const full_text = messages.map((m) => m.content ?? "").join("\n");
      const entries = extract_last_jsonline(full_text);
      const seq = request_log.length + 1;
      request_log.push({
        seq,
        time: new Date().toISOString(),
        model: body.model ?? "",
        stream: body.stream === true,
        n_messages: messages.length,
        roles: messages.map((m) => m.role),
        n_entries: entries.length,
        system: messages.find((m) => m.role === "system")?.content ?? "",
        user: messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n"),
      });
      // 确定性假译文：回显原文加前缀，只保证「行数对得上、可复现」，用于对比管线行为而非译文质量
      const content = "```jsonline\n" + entries.map((e) => JSON.stringify({ id: e.id, text: "【LG译】" + e.text })).join("\n") + "\n```";

      const finish = () => {
        if (body.stream === true) {
          res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
          const chunk = (delta: Record<string, unknown>, finish_reason: string | null, usage?: unknown) => {
            const payload: Record<string, unknown> = {
              id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model: body.model ?? "mock-llm",
              choices: [{ index: 0, delta, finish_reason }],
            };
            if (usage !== undefined) payload["usage"] = usage;
            res.write("data: " + JSON.stringify(payload) + "\n\n");
          };
          chunk({ role: "assistant" }, null);
          chunk({ content }, null);
          chunk({}, "stop");
          if (body.stream_options?.include_usage) {
            chunk({}, null, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({
            id: "chatcmpl-stub", object: "chat.completion", created: 0, model: body.model ?? "mock-llm",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
        }
      };
      setTimeout(finish, 5);
    });
  });
  return new Promise((resolve) => {
    server.listen(STUB_PORT, "127.0.0.1", () => resolve(server));
  });
}

interface RequestLogEntry {
  seq: number;
  time: string;
  model: string;
  stream: boolean;
  n_messages: number;
  roles: string[];
  n_entries: number;
  system: string;
  user: string;
}

const request_log: RequestLogEntry[] = [];

it(
  "LG 全链路离线驱动",
  { timeout: 300_000 },
  async () => {
    assert_env();
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const request_log_path = path.join(ARTIFACT_DIR, "lg-requests.jsonl");
    fs.rmSync(request_log_path, { force: true });
    request_log.length = 0;

    const server = await start_stub_server(request_log_path);
    const app_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-app-"));
    fs.writeFileSync(path.join(app_root, "version.txt"), "0.0.0");
    const output_dir = path.join(ARTIFACT_DIR, "lg-out");
    fs.rmSync(output_dir, { recursive: true, force: true });
    fs.mkdirSync(output_dir, { recursive: true });

    // appRoot 是临时目录（config/log 落那里，不污染 LG 仓库）；builtin 提示词模板仍取 LG 仓库
    const lg_root = path.resolve(import.meta.dirname, "../../..");
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

      // 模型配置必须持久化（run_cli_job 会整体替换 transient overrides；CLI 约定模型"沿用应用已保存配置"）
      services.app.settings.save_setting({
        ...services.app.settings.read_setting(),
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
        model_selection: { translation: "mock-openai-1", agent: "", agent_batch_translation: null },
      });

      const status_log_path = path.join(ARTIFACT_DIR, "lg-status.jsonl");
      fs.rmSync(status_log_path, { force: true });
      const reporter = new CLIJsonStatusReporter({
        command: "translate",
        writeLine: (line: string) => fs.appendFileSync(status_log_path, line + "\n"),
      });

      await run_cli_job(
        services,
        {
          command: "translate",
          inputPaths: [INPUT_TXT],
          outputDir: output_dir,
          sourceLanguage: "JA",
          targetLanguage: "ZH",
          resources: {
            promptPath: null,
            glossaryPath: GLOSSARY_JSON,
            preReplacementPath: null,
            postReplacementPath: null,
            textPreservePath: null,
          },
        } as never,
        reporter,
      );

      fs.writeFileSync(request_log_path, request_log.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch (error) {
      failure = error;
    } finally {
      try {
        await services?.dispose();
      } catch { /* ignore */ }
      try {
        await resources?.dispose();
      } catch { /* ignore */ }
      server.close();
    }

    if (failure !== null) {
      throw failure;
    }
  },
);
