# loremaster PoC

A proof of concept of the voice loop: **hold a button, speak to an NPC, hear it
answer in character.** The whole cascade runs on ONE set of AWS credentials —
the same chain the dvs-mcp OpenClaw agent uses, no Anthropic key.

## What it is

- **STT via Amazon Transcribe streaming (ears)** — the browser captures mic
  audio with the vendored `mic-capture` AudioWorklet (16 kHz PCM16) and streams
  it over a WebSocket (`/stt`); the server pipes it to Transcribe and relays
  live partial/final transcripts back. Works in **any** browser with
  `getUserMedia` + AudioWorklet (Chrome, Edge, **Firefox**) — no
  `SpeechRecognition`, no Google dependency, no local model, no GPU.
- **Claude on Amazon Bedrock (brain)** — the server runs one turn via the AWS
  CLI's `bedrock-runtime converse`.
- **Amazon Polly neural TTS (voice)** — the server synthesizes each clause to
  MP3 (`/tts`) and the browser plays it, clause-by-clause, with barge-in
  (talking over Bram cuts his audio). Voice `Arthur` by default; `TTS_VOICE=""`
  falls back to the browser's `speechSynthesis`.

This is the STT → Claude → TTS **cascade** (Claude has no native voice API). One
npm dependency (`@aws-sdk/client-transcribe-streaming`) for the streaming STT;
everything else is Node built-ins + the AWS CLI. The AudioWorklet mic capture is
the piece vendored from the original Space (see `../client/AUDIO-WIRING.md`).

## Run

```bash
# From the repo root. Uses your existing AWS credentials — same as dvs-mcp.
npm install          # once, for the Transcribe streaming SDK
node server/server.mjs
```

Then open <http://localhost:8787> in any modern browser (Chrome, Edge, Firefox).
Hold the button, speak, release. **Must be `http://localhost`** (or https) — the
mic needs a secure context.

Requires the AWS CLI + credentials that can call **Bedrock, Polly, and
Transcribe** (verify with `aws sts get-caller-identity`).

Env vars (shared with dvs-mcp):

- `LLM_MODEL` — default `amazon-bedrock/global.anthropic.claude-sonnet-4-6`.
  The part after the first `/` is the Bedrock model id.
- `AWS_REGION` — the region for Bedrock, Polly, and Transcribe (e.g. `us-east-1`).
- `AWS_PROFILE` — which AWS profile to use, if not the default.
- `TTS_VOICE` — Polly neural voice id (default `Arthur`, en-GB male). Set to
  `""` to disable Polly and use the browser's built-in speech instead. List
  voices: `aws polly describe-voices --engine neural --output table`.
- `PORT` — default `8787`.

## The NPC

`server/persona.md` is the system prompt — currently **Bram Cask**, keeper of
the Salted Lantern tavern. Edit that file to change who the NPC is; it's cached
per request so repeated turns only pay for the new player utterance.

The prices/bonuses Bram quotes are improvised flavor — there are no game-state
tools wired in yet (that's a roadmap item).

## Known PoC limits (deliberately not solved yet)

- **STT latency** is Transcribe streaming's (~roughly a second after you stop
  talking to finalize) — fine for a turn-based NPC, not instant.
- **Getting Bram into the call** is handled by the PipeWire scripts in
  [`../routing/`](../routing/) — run those on your call machine.
- **Single NPC, single session** — no memory across page reloads, no world state.
- **No game-state tools** — prices/quests Bram mentions are improvised flavor.
