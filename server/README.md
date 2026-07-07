# loremaster PoC

A barebone, dependency-free proof of concept of the voice loop: **hold a button,
speak to an NPC, hear it answer in character.**

## What it is

- **STT in the browser** via the Web Speech API (`SpeechRecognition`) —
  push-to-talk, no GPU, no extra services. (Chromium-only; the robustness
  upgrade is a real STT.)
- **TTS via Amazon Polly** (neural voice, `Arthur` by default) — the server
  synthesizes each clause to MP3 and the browser plays it. Same AWS credential
  chain as Bedrock, and it works in **any** browser (plain MP3 playback), not
  just Chromium. Falls back to the browser's `speechSynthesis` if Polly is
  disabled (`TTS_VOICE=""`) or `/config` reports it unavailable.
- **Claude on Amazon Bedrock as the NPC brain** — the server (`server.mjs`, zero
  npm dependencies, Node 20+) runs one turn via the AWS CLI's
  `bedrock-runtime converse`. This is the **same auth path the dvs-mcp OpenClaw
  agent uses**: your ambient AWS credentials (profile / env / role), no separate
  Anthropic API key.
- **Clause-by-clause speech** — the reply is emitted as clause-sized chunks so
  the NPC speaks incrementally, with barge-in (talking over Bram cuts his audio,
  Polly or browser). This box's AWS CLI has no `converse-stream`, so generation
  completes first — the NPC pauses ~1s to think, then speaks.

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
- `AWS_REGION` — the region to call Bedrock and Polly in (e.g. `us-east-1`).
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

- **STT is still browser-only** (`SpeechRecognition`, Chromium-only). TTS is now
  Amazon Polly (good, cross-browser); the remaining upgrade is a real STT
  (Whisper/Parakeet) behind the worklet pipeline for accuracy + non-Chromium.
- **Getting Bram into the call** is handled by the PipeWire scripts in
  [`../routing/`](../routing/) — run those on your call machine.
- **Single NPC, single session** — no memory across page reloads, no world state.
