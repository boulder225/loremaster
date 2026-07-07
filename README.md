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

- **`client/`** — browser-side audio capture/playback (AudioWorklets). The
  reusable pieces are vendored from `smolagents/hf-realtime-voice` (see
  Credits); see [`client/AUDIO-WIRING.md`](client/AUDIO-WIRING.md) for how they
  fit together. **There is no working WebSocket client yet** — the source
  Space's client spoke the OpenAI Realtime protocol (which Claude doesn't
  support) and was removed. We write our own against the loremaster server.
- **`server/`** — WebSocket backend: STT -> Claude (with NPC/DM persona +
  game-state tools) -> TTS. Not yet implemented.
- Audio routing into/out of the call happens at the OS level (e.g. PipeWire
  virtual sinks), since questportal is a plain browser call with no
  bot/integration API.

## Status

**Working barebone PoC** — hold a button, speak to an NPC, hear it answer in
character. See [`server/README.md`](server/README.md) to run it. The first cut
uses the browser's Web Speech API for STT+TTS (zero dependencies, no GPU) and a
tiny Node server that streams a turn from Claude. The AudioWorklet-based
server-side cascade in `client/worklets/` is the later robustness upgrade.

## Roadmap

- [x] Barebone PoC: browser Web Speech STT/TTS -> Claude -> spoken NPC reply, streaming clause-by-clause
- [x] NPC persona definition (`server/persona.md`, system prompt in the spirit of a SOUL.md)
- [ ] Push-to-talk gating for a live multi-player call (partly done: PoC is already push-to-talk in one tab)
- [ ] PipeWire virtual-sink routing docs/scripts to bridge into a questportal call
- [ ] Robustness upgrade: real STT (Whisper/Parakeet) + TTS behind the worklet pipeline
- [ ] Game-state tools the agent can call (e.g. lore lookup, quest/NPC state)
- [ ] Cross-session memory and world state

## Credits

`client/worklets/` and `client/ws/codec.js` are adapted from [smolagents/hf-realtime-voice](https://huggingface.co/spaces/smolagents/hf-realtime-voice), which credits its backend to [huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech). The Space's `s2s-ws-client.js` was vendored initially but removed — it was hard-wired to the OpenAI Realtime protocol, which doesn't apply to a Claude backend. That Space's README does not declare a license; these files are reused here for a personal, non-commercial PoC pending clarification of reuse terms if this project is ever published more broadly.
