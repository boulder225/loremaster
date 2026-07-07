# loremaster PoC

A barebone, dependency-free proof of concept of the voice loop: **hold a button,
speak to an NPC, hear it answer in character.**

## What it is

- **STT + TTS in the browser** via the Web Speech API (`SpeechRecognition` +
  `speechSynthesis`) — no GPU, no extra services, no API keys beyond Claude.
- **Claude as the NPC brain** — the server (`server.mjs`, zero npm dependencies,
  Node 20+ built-in `fetch`) streams a turn from the Anthropic Messages API.
- **Streaming into speech** — Claude's text is spoken clause-by-clause as it
  arrives, so the NPC starts talking before the full reply is generated.

This is the STT → Claude → TTS **cascade** (Claude has no native voice API),
proven end-to-end with the simplest possible parts. The AudioWorklet-based
server-side cascade (see `../client/AUDIO-WIRING.md`) is a later robustness
upgrade, not needed for this PoC.

## Run

```bash
# From the repo root. Needs a first-party Anthropic API key.
ANTHROPIC_API_KEY=sk-ant-... node server/server.mjs
```

Then open <http://localhost:8787> in **Chrome or Edge** (Firefox/Safari have
weak or no `SpeechRecognition` support). Hold the button, speak, release.

Optional env vars:

- `PORT` — default `8787`.
- `LOREMASTER_MODEL` — default `claude-haiku-4-5` (fastest tier; latency matters
  more than depth for a live NPC quip). Try `claude-sonnet-5` for richer replies.

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
