#!/usr/bin/env bash
set -euo pipefail

MANIFEST_PATH="${BERTH_MANIFEST_PATH:-$PWD/berth.yml}"

if [ ! -f "$MANIFEST_PATH" ]; then
  echo "[berth:entrypoint] no berth.yml found at $MANIFEST_PATH" >&2
  exit 1
fi

# Runs on_install hooks (once) and reports whether a browser:* capability is
# declared. The lifecycle script's last stdout line is "1" or "0" — everything
# before that is its own on_install command output (already streamed to
# stderr/stdout by execSync's inherited stdio).
NEEDS_BROWSER="$(node "$PWD/node_modules/@berth/sdk/dist/run-lifecycle.js" | tail -n1)"

if [ "$NEEDS_BROWSER" = "1" ] && [ "${BERTH_TEST_MODE:-0}" != "1" ]; then
  echo "[berth:entrypoint] browser:* capability declared — starting Xvfb + x11vnc + noVNC" >&2
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
  # give Xvfb a moment to create the display socket before Chromium/x11vnc attach
  sleep 1
  x11vnc -display :99 -forever -shared -nopw -quiet &
  websockify --web=/usr/share/novnc 6080 localhost:5900 &
fi

echo "[berth:entrypoint] starting context-bus daemon on ${BERTH_CONTEXT_BUS_SOCKET}" >&2
/usr/local/bin/context-bus-daemon &

# Wait briefly for the daemon's socket to appear before handing off, so the
# SDK runtime's first connection attempt doesn't race the bind() call.
for _ in $(seq 1 50); do
  [ -S "$BERTH_CONTEXT_BUS_SOCKET" ] && break
  sleep 0.1
done

echo "[berth:entrypoint] handing off to SDK runtime" >&2
exec "$@"
