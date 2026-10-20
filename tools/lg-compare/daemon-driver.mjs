// daemon-driver.mjs —— 用本项目 daemon 的真实翻译核心跑同一篇文章（与 LG 侧同文对比）
//
// 复用 daemon/translate.mjs 的完整语义：segmentLines（1500 字符/30 行）、buildTranslateMessages
// （术语按段内命中注入、#n: 编号协议、单行段加「原文到此为止」）、translateSegment（3 次重试、
// 中文检测、行数不匹配二分）。请求全文落盘到 artifacts/daemon-requests.jsonl。
//
// 前置：PORT=8789 node mock-llm/server.mjs   # 单独车道，别和 8788 抢
// 用法：node tools/lg-compare/daemon-driver.mjs
//   MOCK_URL 环境变量可覆盖端点（默认 http://127.0.0.1:8789/v1/chat/completions）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL_DIR = path.join(REPO_ROOT, "tools", "lg-compare");
const ARTIFACT_DIR = path.join(TOOL_DIR, "artifacts");
const MOCK_URL = process.env.MOCK_URL ?? "http://127.0.0.1:8789/v1/chat/completions";

const { segmentLines, translateSegment, SEGMENT_MAX_LEN, SEGMENT_MAX_LINES } = await import(
  pathToFileURL(path.join(REPO_ROOT, "daemon", "translate.mjs")).href
);

const content = fs.readFileSync(path.join(TOOL_DIR, "lg-input.txt"), "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
const lines = content.split("\n");

// 与 LG 侧 lg-glossary.json 同一份术语表（我们的格式是 {jp: zh} 平面对象，无 info 列）
const glossary = { 天宮繭: "天宫茧", 胡桃みくる: "胡桃美久", GF文庫: "GF文库" };

const requestLog = [];
let seq = 0;
const call = async (messages) => {
  seq += 1;
  const body = { model: "mock-glossary-1", messages, temperature: 0.3 };
  requestLog.push({ seq, time: new Date().toISOString(), body });
  const res = await fetch(MOCK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 180)}` };
  }
  const data = await res.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== "string") return { ok: false, error: "bad response shape" };
  return { ok: true, content: answer };
};

const segments = segmentLines(lines);
console.log(`[driver] lines=${lines.length} segments=${segments.length} (maxLen=${SEGMENT_MAX_LEN} maxLines=${SEGMENT_MAX_LINES})`);
console.log(`[driver] segment sizes: ${segments.map((s) => s.length).join(",")}`);

const zhParts = [];
let retries = 0;
for (let i = 0; i < segments.length; i += 1) {
  const seg = segments[i];
  const zh = await translateSegment(seg, {
    call,
    glossary,
    systemPrompt: "",   // 空 → 回退内置 TRANSLATE_SYSTEM_PROMPT（与默认模板同款）
    onRetry: () => { retries += 1; },
    log: (msg) => console.log(`[translate] seg#${i + 1} ${msg}`),
  });
  zhParts.push(zh);
  console.log(`[driver] seg#${i + 1}/${segments.length} done (${seg.length} -> ${zh.length} lines)`);
}

const zhLines = zhParts.flat();
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.writeFileSync(path.join(ARTIFACT_DIR, "daemon-out.txt"), zhLines.join("\n") + "\n");
fs.writeFileSync(path.join(ARTIFACT_DIR, "daemon-out-bilingual.txt"), lines.map((l, i) => `${l}\n${zhLines[i] ?? ""}`).join("\n\n") + "\n");
fs.writeFileSync(path.join(ARTIFACT_DIR, "daemon-requests.jsonl"), requestLog.map((r) => JSON.stringify({
  seq: r.seq, time: r.time, model: r.body.model, stream: false, temperature: r.body.temperature,
  n_messages: r.body.messages.length, roles: r.body.messages.map((m) => m.role),
  system: r.body.messages[0]?.content ?? "",
  user: r.body.messages[1]?.content ?? "",
})).join("\n") + "\n");

console.log(`[driver] done: requests=${seq} retries=${retries} output=${path.join(ARTIFACT_DIR, "daemon-out.txt")}`);
