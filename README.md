# loremaster

A voice-driven AI assistant for tabletop RPGs — NPC voices and DM support tooling for remote sessions run over a plain browser audio call (no call-platform bot API required).

## Why

Running NPCs and lore lookups live during a remote session is slow. loremaster gives the DM an AI agent that can listen (via a virtual audio device routed from the call), answer in character or as a rules/lore assistant, and speak back into the call — without needing anything from the call platform beyond mic/speaker access.

## Architecture (planned)

```
Player speech --[questportal call]--> virtual audio sink --> loremaster client (browser)
                                                                  |
                                                          WebSocket (PCM16 chunks)
                                                                  |
                                                          loremaster server
                                                    STT -> Claude (text) -> TTS   (cascade)
                                                                  |
                                                          WebSocket (PCM16 chunks)
                                                                  v
loremaster client (browser) --> virtual audio sink --[questportal call]--> Players
```

Voice is a **cascade**: speech-to-text, then Claude as the text "brain"
(persona + tools), then text-to-speech. Claude has **no native realtime
speech-to-speech API**, so there's no single voice endpoint to call — the
STT and TTS stages are separate services we wire around it. The key latency
trick is to **stream Claude's text into TTS clause-by-clause** so the NPC
starts speaking the first sentence while Claude is still generating the rest.

- **`client/`** — `index.html` (push-to-talk UI) plus the `mic-capture`
  AudioWorklet vendored from `smolagents/hf-realtime-voice` (see Credits) that
  streams 16 kHz PCM to the server. See
  [`client/AUDIO-WIRING.md`](client/AUDIO-WIRING.md) for the worklet wiring.
- **`server/`** — `server.mjs`: serves the client, bridges the mic WebSocket to
  Amazon Transcribe (`/stt`), runs the NPC turn on Bedrock (`/chat`), and
  synthesizes the voice with Polly (`/tts`). `persona.md` is the NPC prompt.
- **`routing/`** — PipeWire scripts to bridge the NPC voice into a questportal
  call at the OS level (questportal is a plain browser call with no bot API).

## Status

**Working barebone PoC** — hold a button, speak to an NPC, hear it answer in
character, in **any** modern browser. See [`server/README.md`](server/README.md)
to run it, and [`routing/`](routing/) to bridge his voice into the call. The
whole cascade runs on the **same AWS credentials as the dvs-mcp agent** (no
Anthropic key): **Amazon Transcribe** streaming for STT (browser mic → the
vendored `mic-capture` worklet → WebSocket → live text), **Claude on Amazon
Bedrock** for the brain, and **Amazon Polly** neural for the voice. A small Node
server (one npm dep for the STT SDK) ties it together.

## Roadmap

- [x] Barebone PoC: speak -> Claude -> spoken NPC reply, streaming clause-by-clause
- [x] NPC persona definition (`server/persona.md`, system prompt in the spirit of a SOUL.md)
- [x] Push-to-talk gating for a live multi-player call (PoC tab is hold-to-talk)
- [x] PipeWire virtual-sink routing to bridge Bram into a questportal call (`routing/`)
- [x] TTS: Amazon Polly neural voice (cross-browser MP3), same AWS auth as the brain
- [x] STT: Amazon Transcribe streaming via the mic-capture worklet — cross-browser, no local model
- [ ] Game-state tools the agent can call (e.g. lore lookup, quest/NPC state)
- [ ] Cross-session memory and world state
- [ ] Tune STT/UX: reactive orb visualizer, endpointing, latency

## Credits

`client/worklets/` and `client/ws/codec.js` are adapted from [smolagents/hf-realtime-voice](https://huggingface.co/spaces/smolagents/hf-realtime-voice), which credits its backend to [huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech). Of these, `worklets/mic-capture.js` is the one actually wired in (it streams 16 kHz PCM to Amazon Transcribe); `audio-playback.js` and `ws/codec.js` are kept as reference (playback uses Polly MP3 in an `<audio>` element instead). The Space's `s2s-ws-client.js` was vendored initially but removed — it was hard-wired to the OpenAI Realtime protocol, which doesn't apply to a Claude/AWS backend. That Space's README does not declare a license; these files are reused here for a personal, non-commercial PoC pending clarification of reuse terms if this project is ever published more broadly.
