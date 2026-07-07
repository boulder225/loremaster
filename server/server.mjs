// loremaster PoC server — zero dependencies, Node 20+.
//
// Serves the barebone browser client and proxies a streaming chat turn to the
// Anthropic Messages API. The browser does STT (SpeechRecognition) and TTS
// (speechSynthesis); this server is only the "brain": persona + Claude.
//
// The cascade is STT (browser) -> Claude (here) -> TTS (browser). Claude has no
// native voice API. We stream Claude's text back as SSE so the client can start
// speaking the first sentence while the rest is still generating.
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... node server/server.mjs
// Then: open http://localhost:8787

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLIENT_DIR = join(ROOT, "client");
const PORT = Number(process.env.PORT ?? 8787);

// Keep-it-simple config. Haiku is the right default for a live NPC — latency
// matters more than deep reasoning for a tavern-keeper's quip.
const MODEL = process.env.LOREMASTER_MODEL ?? "claude-haiku-4-5";
const MAX_TOKENS = 400;

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set.\n" +
      "Get a key from console.anthropic.com and run:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-... node server/server.mjs",
  );
  process.exit(1);
}

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

// POST /chat  { history: [{role, content}, ...] }
// Streams Server-Sent Events: {type:"delta", text} ... then {type:"done"}.
async function handleChat(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;

  let history;
  try {
    ({ history } = JSON.parse(raw));
    if (!Array.isArray(history)) throw new Error("history must be an array");
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
    return;
  }

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: PERSONA, cache_control: { type: "ephemeral" } }],
        messages: history,
        stream: true,
      }),
    });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `upstream fetch failed: ${err.message ?? err}` }));
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Anthropic API ${upstream.status}: ${detail}` }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Parse the Anthropic SSE stream and forward only the text deltas the client
  // needs. We split on blank lines (SSE event boundaries) and read the `data:`
  // payloads.
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            send({ type: "delta", text: evt.delta.text });
          } else if (evt.type === "message_stop") {
            send({ type: "done" });
          } else if (evt.type === "error") {
            send({ type: "error", error: evt.error?.message ?? "stream error" });
          }
        }
      }
    }
  } catch (err) {
    send({ type: "error", error: `stream interrupted: ${err.message ?? err}` });
  }
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
  console.log(`loremaster PoC on http://localhost:${PORT}  (model: ${MODEL})`);
});
