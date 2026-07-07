# loremaster PoC

A barebone, dependency-free proof of concept of the voice loop: **hold a button,
speak to an NPC, hear it answer in character.**

## What it is

- **STT + TTS in the browser** via the Web Speech API (`SpeechRecognition` +
  `speechSynthesis`) — no GPU, no extra services.
- **Claude on Amazon Bedrock as the NPC brain** — the server (`server.mjs`, zero
  npm dependencies, Node 20+) runs one turn via the AWS CLI's
  `bedrock-runtime converse`. This is the **same auth path the dvs-mcp OpenClaw
  agent uses**: your ambient AWS credentials (profile / env / role), no separate
  Anthropic API key.
- **Streaming into speech** — the reply is emitted as clause-sized chunks so the
  NPC speaks clause-by-clause. (This box's AWS CLI has no `converse-stream`, so
  generation completes first — the NPC pauses ~1s to think, then speaks.)

This is the STT → Claude → TTS **cascade** (Claude has no native voice API),
proven end-to-end with the simplest possible parts. The AudioWorklet-based
server-side cascade (see `../client/AUDIO-WIRING.md`) is a later robustness
upgrade, not needed for this PoC.

## Run

```bash
# From the repo root. Uses your existing AWS credentials — same as dvs-mcp.
node server/server.mjs
```

Then open <http://localhost:8787> in **Chrome or Edge** (Firefox/Safari have
weak or no `SpeechRecognition` support). Hold the button, speak, release.

Requires the AWS CLI with credentials that can call Bedrock (verify with
`aws bedrock-runtime converse --help` and a `aws sts get-caller-identity`).

Env vars (shared with dvs-mcp):

- `LLM_MODEL` — default `amazon-bedrock/global.anthropic.claude-sonnet-4-6`.
  The part after the first `/` is the Bedrock model id.
- `AWS_REGION` — the region to call Bedrock in (e.g. `us-east-1`).
- `AWS_PROFILE` — which AWS profile to use, if not the default.
- `PORT` — default `8787`.

## The NPC

`server/persona.md` is the system prompt — currently **Bram Cask**, keeper of
the Salted Lantern tavern. Edit that file to change who the NPC is; it's cached
per request so repeated turns only pay for the new player utterance.

## Known PoC limits (deliberately not solved yet)

- **Browser STT/TTS quality** is mediocre and Chromium-only — the robustness
  upgrade is a real STT (Whisper/Parakeet) + TTS behind the worklet pipeline.
- **No push-to-talk over a call yet** — this runs in one browser tab. Routing it
  into a questportal call is the PipeWire virtual-sink step on the roadmap.
- **Single NPC, single session** — no memory across page reloads, no world state.
