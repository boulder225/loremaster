#!/usr/bin/env bash
# loremaster call routing — bridge Bram's browser voice into a questportal call.
#
# WHERE THIS RUNS: on the machine you take the call from (your desktop), NOT the
# headless dev box. It needs a live PipeWire (or PulseAudio) session and pactl,
# which ship with pipewire-pulse. Verify first:  pactl info
#
# WHAT IT BUILDS (all virtual, torn down cleanly by `stop`):
#
#   [loremaster tab speaker] --> loremaster_npc (null sink)
#                                     |
#                                     | .monitor
#                                     v
#   [your real mic] ---+--> npc_mix (null sink) --.monitor--> questportal mic input
#                      |
#                      '(both feed the mix, so friends hear YOU and Bram)
#
# So: set the loremaster browser tab's OUTPUT to "loremaster_npc", and set
# questportal's MICROPHONE to "Monitor of npc_mix". Your real mic keeps working.
#
# Usage:
#   ./loremaster-audio.sh start     # create the virtual devices + wiring
#   ./loremaster-audio.sh status    # show what's loaded and next steps
#   ./loremaster-audio.sh stop      # remove everything this script created
#
# Pick your real mic with:  MIC_SOURCE=<name> ./loremaster-audio.sh start
# (list sources with:       pactl list short sources)

set -euo pipefail

NPC_SINK="loremaster_npc"     # the browser tab plays Bram here
MIX_SINK="npc_mix"            # your mic + Bram, combined; questportal listens here
STATE_FILE="${XDG_RUNTIME_DIR:-/tmp}/loremaster-routing.modules"

have() { command -v "$1" >/dev/null 2>&1; }

require_pactl() {
  if ! have pactl; then
    echo "error: pactl not found. Install pipewire-pulse (or pulseaudio-utils)." >&2
    echo "This script runs on your CALL machine, not a headless server." >&2
    exit 1
  fi
  if ! pactl info >/dev/null 2>&1; then
    echo "error: no audio server reachable (pactl info failed)." >&2
    echo "Run this in your desktop session, not over a bare SSH shell." >&2
    exit 1
  fi
}

# Pick a default real mic if MIC_SOURCE isn't set: the configured default source,
# minus any monitor sources (which would feed audio back on itself).
detect_mic() {
  if [ -n "${MIC_SOURCE:-}" ]; then echo "$MIC_SOURCE"; return; fi
  local def
  def="$(pactl get-default-source 2>/dev/null || true)"
  if [ -n "$def" ] && [[ "$def" != *.monitor ]]; then echo "$def"; return; fi
  pactl list short sources | awk '$2 !~ /\.monitor$/ {print $2; exit}'
}

start() {
  require_pactl
  if [ -f "$STATE_FILE" ]; then
    echo "Routing already started (state file exists). Run 'stop' first." >&2
    exit 1
  fi
  local mic; mic="$(detect_mic)"
  if [ -z "$mic" ]; then
    echo "error: could not find a real microphone. Set MIC_SOURCE=<name>." >&2
    echo "List sources: pactl list short sources" >&2
    exit 1
  fi
  echo "Using microphone source: $mic"

  : > "$STATE_FILE"

  # 1. Null sink the browser tab plays Bram into.
  local m
  m=$(pactl load-module module-null-sink \
        sink_name="$NPC_SINK" \
        sink_properties="device.description=Loremaster-NPC")
  echo "$m" >> "$STATE_FILE"

  # 2. Null sink that questportal will listen to (its .monitor is the "mic").
  m=$(pactl load-module module-null-sink \
        sink_name="$MIX_SINK" \
        sink_properties="device.description=Loremaster-Mix")
  echo "$m" >> "$STATE_FILE"

  # 3. Feed Bram (NPC sink monitor) into the mix.
  m=$(pactl load-module module-loopback \
        source="${NPC_SINK}.monitor" sink="$MIX_SINK" latency_msec=40)
  echo "$m" >> "$STATE_FILE"

  # 4. Feed your real mic into the mix too, so friends hear you + Bram.
  m=$(pactl load-module module-loopback \
        source="$mic" sink="$MIX_SINK" latency_msec=40)
  echo "$m" >> "$STATE_FILE"

  echo
  echo "Routing is up. Now, in your apps:"
  echo "  • loremaster browser tab  -> OUTPUT device:  Loremaster-NPC"
  echo "  • questportal call        -> MICROPHONE:     Monitor of Loremaster-Mix"
  echo
  echo "Your real mic ($mic) is mixed in automatically."
  echo "Tear down with: $0 stop"
}

status() {
  require_pactl
  if [ ! -f "$STATE_FILE" ]; then
    echo "Not started (no state file). Run '$0 start'."
    return
  fi
  echo "Loaded loremaster modules (ids): $(tr '\n' ' ' < "$STATE_FILE")"
  echo
  echo "Sinks:";   pactl list short sinks   | grep -E "$NPC_SINK|$MIX_SINK" || true
  echo "Loopbacks present in the graph:"
  pactl list short modules | grep -E "module-loopback|module-null-sink" || true
  echo
  echo "Set loremaster tab OUTPUT -> Loremaster-NPC; questportal MIC -> Monitor of Loremaster-Mix."
}

stop() {
  require_pactl
  if [ ! -f "$STATE_FILE" ]; then
    echo "Nothing to stop (no state file)."
    return
  fi
  # Unload in reverse order (loopbacks before the sinks they reference).
  tac "$STATE_FILE" | while read -r id; do
    [ -n "$id" ] && pactl unload-module "$id" 2>/dev/null || true
  done
  rm -f "$STATE_FILE"
  echo "Removed loremaster routing."
}

case "${1:-}" in
  start)  start ;;
  status) status ;;
  stop)   stop ;;
  *) echo "usage: $0 {start|status|stop}   (optional: MIC_SOURCE=<name>)" >&2; exit 2 ;;
esac
