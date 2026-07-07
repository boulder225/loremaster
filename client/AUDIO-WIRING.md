# Browser audio wiring reference

These notes capture how the vendored worklets (`worklets/mic-capture.js`,
`worklets/audio-playback.js`) and `ws/codec.js` fit together, so a loremaster
WebSocket client can be written against our own STT → Claude → TTS backend
without reverse-engineering the AudioWorklet setup from scratch.

The original `s2s-ws-client.js` from the source Space was **removed** — it was
hard-wired to the OpenAI Realtime GA protocol (`session.created`,
`input_audio_buffer.append`, `response.output_audio.delta`, …), which Claude
does not speak. Only the audio-node wiring below is worth reusing.

## Setup (once, inside a user gesture)

1. Create and `resume()` an `AudioContext` synchronously inside the click/tap
   that starts a session (required by iOS autoplay policy).
2. `await ctx.audioWorklet.addModule("worklets/mic-capture.js")` and
   `addModule("worklets/audio-playback.js")`.

## Mic capture (browser → server)

- `new AudioWorkletNode(ctx, "mic-capture", { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { chunkMs: 40 } })`.
- Connect the mic: `ctx.createMediaStreamSource(micStream).connect(captureNode)`.
- `captureNode.port.onmessage` delivers either an `ArrayBuffer` (a ~40ms PCM16
  16 kHz mono chunk, ready to send to STT) or `{kind: "level", rms}` for a mic meter.
- Encode chunks for the wire with `base64FromArrayBuffer()` from `ws/codec.js`.
- Optional noise gate: `captureNode.port.postMessage({ kind: "gate", enabled, thresholdDb })`.
- Mute by dropping chunks on the main thread (don't send them).

## Playback (server → browser)

- `new AudioWorkletNode(ctx, "audio-playback", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })`, then `playbackNode.connect(ctx.destination)`.
- Tell it the TTS sample rate once: `playbackNode.port.postMessage({ kind: "config", inputRate: <hz> })` (the source pipeline used 24 kHz; match whatever our TTS emits).
- Decode incoming base64 PCM16 with `base64ToBytes()`, convert Int16 → Float32, and post `{ kind: "audio", samples }` (transfer the buffer).
- **Barge-in:** when the player starts talking again, `playbackNode.port.postMessage({ kind: "clear" })` to flush queued NPC audio immediately.

## loremaster-specific notes

- Backend is a **cascade**, not a realtime speech-to-speech API: STT → Claude
  (text) → TTS. Claude has no native voice API.
- **Stream Claude's text into TTS clause-by-clause** so the NPC starts speaking
  the first sentence while Claude is still generating — the biggest latency win.
- Gate mic capture behind push-to-talk for multi-player calls (see README roadmap).
