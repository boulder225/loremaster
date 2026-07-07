// loremaster PoC server — zero npm dependencies, Node 20+.
//
// Serves the barebone browser client and runs one NPC chat turn through Claude
// on Amazon Bedrock — the SAME auth path the dvs-mcp OpenClaw agent uses
// (AWS credentials via the standard chain; no separate Anthropic key). The
// browser does STT (SpeechRecognition) and TTS (speechSynthesis); this server
// is only the "brain": persona + Claude.
//
// The cascade is STT (browser) -> Claude (here) -> TTS (browser). Claude has no
// native voice API. This box's AWS CLI has no converse-stream, so we take the
// full reply and emit it as clause-sized SSE deltas — the client still speaks
// clause-by-clause; the NPC just pauses ~1s to think first.
//
// Auth / config (shared with dvs-mcp):
//   LLM_MODEL   e.g. amazon-bedrock/global.anthropic.claude-sonnet-4-6
//               (the part after the first "/" is the Bedrock model id)
//   AWS_REGION  e.g. us-east-1        AWS_PROFILE  e.g. default
//
// Run:  node server/server.mjs        Then: open http://localhost:8787

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { execFile } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLIENT_DIR = join(ROOT, "client");
const PORT = Number(process.env.PORT ?? 8787);
const MAX_TOKENS = 400;

// Resolve the Bedrock model id from LLM_MODEL (same var dvs-mcp uses). LLM_MODEL
// looks like "amazon-bedrock/<model-id>"; strip the provider prefix. Falls back
// to the model dvs-mcp defaults to.
const LLM_MODEL = process.env.LLM_MODEL ?? "amazon-bedrock/global.anthropic.claude-sonnet-4-6";
const MODEL_ID = LLM_MODEL.includes("/") ? LLM_MODEL.slice(LLM_MODEL.indexOf("/") + 1) : LLM_MODEL;
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

const PERSONA = await readFile(join(HERE, "persona.md"), "utf8");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

async function serveStatic(req, res) {
  // Map "/" -> client/index.html; otherwise resolve under client/, guarding
  // against path traversal.
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = normalize(join(CLIENT_DIR, urlPath));
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// Call Bedrock Converse via the AWS CLI. Returns the assistant's text.
// Uses the ambient AWS credential chain (profile / env / role) — nothing here
// touches a secret directly.
function bedrockConverse(history) {
  const messages = history.map((m) => ({ role: m.role, content: [{ text: m.content }] }));
  const args = [
    "bedrock-runtime", "converse",
    "--region", REGION,
    "--model-id", MODEL_ID,
    "--system", JSON.stringify([{ text: PERSONA }]),
    "--messages", JSON.stringify(messages),
    "--inference-config", JSON.stringify({ maxTokens: MAX_TOKENS }),
    "--output", "json",
  ];
  return new Promise((resolve, reject) => {
    execFile("aws", args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message || "aws call failed").trim()));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const text = (data.output?.message?.content ?? [])
          .map((b) => b.text ?? "")
          .join("")
          .trim();
        resolve(text);
      } catch (e) {
        reject(new Error(`could not parse Bedrock response: ${e.message}`));
      }
    });
  });
}

// Split a reply into clause-sized chunks so the client speaks incrementally.
function toClauses(text) {
  return text
    .split(/(?<=[.!?,:;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// POST /chat  { history: [{role, content}, ...] }
// Streams SSE: {type:"delta", text} per clause, then {type:"done"}.
async function handleChat(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;

  let history;
  try {
    ({ history } = JSON.parse(raw));
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error("history must be a non-empty array");
    }
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
    return;
  }

  let text;
  try {
    text = await bedrockConverse(history);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Bedrock error: ${err.message ?? err}` }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  for (const clause of toClauses(text)) send({ type: "delta", text: clause + " " });
  send({ type: "done" });
  res.end();
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/chat") {
    handleChat(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message ?? err) }));
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`loremaster PoC on http://localhost:${PORT}`);
  console.log(`  model:  ${MODEL_ID}  (region ${REGION}, via AWS credential chain)`);
});
