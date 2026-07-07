# loremaster

A voice-driven AI assistant for tabletop RPGs — NPC voices and DM support tooling for remote sessions run over a plain browser audio call (no call-platform bot API required).

## Why

Running NPCs and lore lookups live during a remote session is slow. loremaster gives the DM an AI agent that can listen (via a virtual audio device routed from the call), answer in character or as a rules/lore assistant, and speak back into the call — without needing anything from the call platform beyond mic/speaker access.

## Architecture (planned)

```
Player speech --[questportal call]--> virtual audio sink --> loremaster client (browser)
                                                                  |
                                                          WebSocket (PCM16)
                                                                  |
                                                          loremaster server
                                                    STT -> Claude (persona + tools) -> TTS
                                                                  |
                                                          WebSocket (PCM16)
                                                                  v
loremaster client (browser) --> virtual audio sink --[questportal call]--> Players
```

- **`client/`** — browser-side audio capture/playback and WebSocket client. Adapted from `smolagents/hf-realtime-voice` (see Credits).
- **`server/`** — WebSocket backend: STT -> Claude (with NPC/DM persona + game-state tools) -> TTS. Not yet implemented.
- Audio routing into/out of the call happens at the OS level (e.g. PipeWire virtual sinks), since questportal is a plain browser call with no bot/integration API.

## Status

Early scaffolding. `client/` contains vendored audio-handling code from an existing open-source Space; the server and persona/tooling layer are not yet built.

## Roadmap

- [ ] Minimal WebSocket server: STT -> Claude -> TTS round trip
- [ ] NPC/DM persona definition (system prompt, in the spirit of a SOUL.md)
- [ ] Game-state tools the agent can call (e.g. lore lookup, quest/NPC state)
- [ ] Push-to-talk gating to avoid always-listening in a live multi-player call
- [ ] PipeWire virtual-sink routing docs/scripts for questportal

## Credits

`client/worklets/` and `client/ws/` are adapted from [smolagents/hf-realtime-voice](https://huggingface.co/spaces/smolagents/hf-realtime-voice), which credits its backend to [huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech). That Space's README does not declare a license; these files are reused here for a personal, non-commercial PoC pending clarification of reuse terms if this project is ever published more broadly.
