# Call routing — get Bram's voice into a questportal call

questportal is a plain browser call with no bot/integration API, so the AI NPC
can't "join" as a participant. Instead we bridge audio at the OS level: the
loremaster browser tab plays Bram into a **virtual speaker**, and questportal
listens to a **virtual microphone** that mixes Bram + your real mic. Your
friends hear both you and the NPC; the NPC hears nothing (this is one-way out —
push-to-talk STT stays in your loremaster tab).

> **Runs on your call machine, not the dev box.** It needs a live PipeWire (or
> PulseAudio) session and `pactl` (ships with `pipewire-pulse`). The headless
> box these scripts live on has no audio server — `pactl info` there fails by
> design.

## Quick start

```bash
# 1. Bring up the virtual devices + wiring
./loremaster-audio.sh start

# (pick a specific mic if the default is wrong)
MIC_SOURCE="$(pactl list short sources | grep -i usb | head -1 | awk '{print $2}')" \
  ./loremaster-audio.sh start

# 2. In your apps:
#    • loremaster browser tab  -> OUTPUT device:  Loremaster-NPC
#    • questportal call        -> MICROPHONE:     Monitor of Loremaster-Mix
#    (Chrome: per-site settings, or the 🔒 site controls, let you pick devices.)

# 3. When the session ends
./loremaster-audio.sh stop
```

`./loremaster-audio.sh status` shows what's loaded and repeats the device names.

## The graph it builds

```
loremaster tab (OUTPUT) ─▶ Loremaster-NPC ──.monitor──┐
                                                       ├─▶ Loremaster-Mix ──.monitor──▶ questportal (MIC)
your real mic ─────────────────────────────────────────┘
```

Everything is virtual and removed by `stop` (it tracks the module ids it loaded
in `$XDG_RUNTIME_DIR/loremaster-routing.modules`).

## Doing it by hand (or on a GUI patchbay)

The script is just four `pactl` module loads. If you prefer a visual tool,
install **qpwgraph** or **helvum** and wire the same nodes by dragging:

```bash
pactl load-module module-null-sink sink_name=loremaster_npc \
  sink_properties=device.description=Loremaster-NPC
pactl load-module module-null-sink sink_name=npc_mix \
  sink_properties=device.description=Loremaster-Mix
pactl load-module module-loopback source=loremaster_npc.monitor sink=npc_mix latency_msec=40
pactl load-module module-loopback source=<your-mic> sink=npc_mix latency_msec=40
```

Unload with `pactl unload-module <id>` (ids print on load; `pactl list short modules` lists them).

## Notes & gotchas

- **Push-to-talk still matters.** In a live table with crosstalk, gate when Bram
  listens — the loremaster tab is already hold-to-talk, so only trigger a turn
  when a player actually addresses him. Don't leave STT always-on.
- **Echo / feedback:** keep the NPC out of the STT path. Bram's audio goes to
  `Loremaster-NPC` (→ the call), never into your mic source. If you hear echo,
  check questportal isn't set to the wrong monitor.
- **Latency:** `latency_msec=40` is a balance; lower it for snappier mixing at
  the risk of crackle, raise it if you get dropouts.
- **PulseAudio (non-PipeWire) machines:** identical `pactl` commands work; only
  the underlying server differs.
