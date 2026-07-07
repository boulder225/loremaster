// loremaster PoC server. The full voice cascade runs on ONE set of AWS
// credentials (the same chain the dvs-mcp OpenClaw agent uses — no Anthropic key):
//
//   STT  = Amazon Transcribe streaming  (browser mic -> WebSocket -> live text)
//   brain = Claude on Amazon Bedrock    (converse)
//   TTS  = Amazon Polly neural          (text -> mp3 -> browser plays)
//
// The browser captures mic audio with an AudioWorklet (works in every browser,
// unlike SpeechRecognition) and streams 16 kHz PCM16 frames over a WebSocket to
// /stt. We forward those to Transcribe, send partial/final transcripts back, and
// on a final transcript the client runs a normal /chat + /tts turn.
//
// Config (shared with dvs-mcp):
//   LLM_MODEL   e.g. amazon-bedrock/global.anthropic.claude-sonnet-4-6
//   AWS_REGION  e.g. us-east-1        AWS_PROFILE  e.g. default
//   TTS_VOICE   Polly voice id (default Arthur); "" disables Polly
//
// One npm dependency (@aws-sdk/client-transcribe-streaming) for STT; everything
// else is Node built-ins + the AWS CLI.
//
// Run:  node server/server.mjs        Then: open http://localhost:8787

import { createServer } from "node:http";
import { readFile, mkdtemp, readFile as readFileBin, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from "@aws-sdk/client-transcribe-streaming";
import { handleUpgrade } from "./ws.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLIENT_DIR = join(ROOT, "client");
const PORT = Number(process.env.PORT ?? 8787);
const MAX_TOKENS = 400;

// Amazon Polly neural voice for the NPC. Same AWS credential chain as Bedrock.
// Arthur = en-GB male neural, a good fit for a gruff harbor-tavern keeper.
// Set TTS_VOICE="" to disable server TTS and let the client fall back to the
// browser's speechSynthesis.
const TTS_VOICE = process.env.TTS_VOICE ?? "Arthur";

// Resolve the Bedrock model id from LLM_MODEL (same var dvs-mcp uses). LLM_MODEL
// looks like "amazon-bedrock/<model-id>"; strip the provider prefix. Falls back
// to the model dvs-mcp defaults to.
const LLM_MODEL = process.env.LLM_MODEL ?? "amazon-bedrock/global.anthropic.claude-sonnet-4-6";
const MODEL_ID = LLM_MODEL.includes("/") ? LLM_MODEL.slice(LLM_MODEL.indexOf("/") + 1) : LLM_MODEL;
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

// Transcribe streaming expects a fixed sample rate; the mic-capture worklet
// downsamples to 16 kHz PCM16 mono, which matches this.
const STT_SAMPLE_RATE = 16000;
const stt = new TranscribeStreamingClient({ region: REGION });

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

// Synthesize speech with Amazon Polly (neural). Returns an mp3 Buffer.
// Polly's CLI writes to a file path argument, so we round-trip through a temp dir.
async function pollySynthesize(text) {
  const dir = await mkdtemp(join(tmpdir(), "loremaster-tts-"));
  const out = join(dir, "speech.mp3");
  const args = [
    "polly", "synthesize-speech",
    "--region", REGION,
    "--engine", "neural",
    "--voice-id", TTS_VOICE,
    "--output-format", "mp3",
    "--text", text,
    out,
  ];
  try {
    await new Promise((resolve, reject) => {
      execFile("aws", args, (err, _stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || "polly failed").trim()));
        else resolve();
      });
    });
    return await readFileBin(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// POST /tts  { text }  ->  audio/mpeg
async function handleTts(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let text;
  try {
    ({ text } = JSON.parse(raw));
    if (typeof text !== "string" || !text.trim()) throw new Error("text required");
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
    return;
  }
  try {
    const mp3 = await pollySynthesize(text.trim());
    res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
    res.end(mp3);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Polly error: ${err.message ?? err}` }));
  }
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

// Bridge one browser WebSocket to a Transcribe streaming session. The browser
// sends binary PCM16 frames (from the mic-capture worklet) and a text "stop"
// control frame on release; we push audio into Transcribe and relay
// {type:"partial"|"final", text} back.
function bridgeSttSocket(conn) {
  // A queue of incoming audio chunks exposed as the async iterable Transcribe wants.
  const chunks = [];
  let waiting = null;   // resolver for a pending next() when the queue is empty
  let ended = false;

  const pushChunk = (buf) => {
    if (waiting) { waiting({ value: buf, done: false }); waiting = null; }
    else chunks.push(buf);
  };
  const endStream = () => {
    ended = true;
    if (waiting) { waiting({ value: undefined, done: true }); waiting = null; }
  };

  const audioStream = (async function* () {
    for (;;) {
      if (chunks.length) {
        yield { AudioEvent: { AudioChunk: chunks.shift() } };
      } else if (ended) {
        return;
      } else {
        const next = await new Promise((r) => (waiting = r));
        if (next.done) return;
        yield { AudioEvent: { AudioChunk: next.value } };
      }
    }
  })();

  conn.on("message", (msg) => {
    if (msg.type === "binary") pushChunk(msg.data);
    else if (msg.type === "text" && msg.data === "stop") endStream();
  });
  conn.on("close", endStream);

  (async () => {
    try {
      const resp = await stt.send(
        new StartStreamTranscriptionCommand({
          LanguageCode: "en-US",
          MediaEncoding: "pcm",
          MediaSampleRateHertz: STT_SAMPLE_RATE,
          AudioStream: audioStream,
        }),
      );
      for await (const event of resp.TranscriptResultStream) {
        const results = event.TranscriptEvent?.Transcript?.Results ?? [];
        for (const r of results) {
          const text = r.Alternatives?.[0]?.Transcript ?? "";
          if (!text) continue;
          conn.sendJSON({ type: r.IsPartial ? "partial" : "final", text });
        }
      }
      conn.sendJSON({ type: "done" });
    } catch (err) {
      conn.sendJSON({ type: "error", error: String(err.message ?? err) });
    } finally {
      conn.close();
    }
  })();
}

const server = createServer((req, res) => {
  const fail = (err) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
  };
  if (req.method === "POST" && req.url === "/chat") {
    handleChat(req, res).catch(fail);
    return;
  }
  if (req.method === "POST" && req.url === "/tts") {
    handleTts(req, res).catch(fail);
    return;
  }
  if (req.method === "GET" && req.url === "/config") {
    // Tell the client whether server-side Polly TTS is available.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ serverTts: Boolean(TTS_VOICE), voice: TTS_VOICE || null }));
    return;
  }
  serveStatic(req, res);
});

// Browser opens ws://<host>/stt and streams mic PCM for live transcription.
server.on("upgrade", (req, socket) => {
  if (new URL(req.url, "http://x").pathname === "/stt") {
    handleUpgrade(req, socket, bridgeSttSocket);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`loremaster PoC on http://localhost:${PORT}`);
  console.log(`  brain:  ${MODEL_ID}  (Bedrock, region ${REGION})`);
  console.log(`  voice:  ${TTS_VOICE ? `${TTS_VOICE} (Amazon Polly neural)` : "browser speechSynthesis (Polly disabled)"}`);
  console.log(`  ears:   Amazon Transcribe streaming (region ${REGION})`);
  console.log(`  all via the AWS credential chain — no Anthropic key.`);
});
