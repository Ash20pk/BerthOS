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

# Started here (before agent-init's Landlock ruleset is applied to the app
# process below) so the daemon itself is never subject to the app's
# filesystem:write:* grants — same reasoning as context-bus-daemon above.
# Resident apps that want to write through /context still need their own
# filesystem:write:/context capability declared in berth.yml; only the
# control socket (register/tag/query) is unconditionally reachable.
echo "[berth:entrypoint] starting semantic-fs daemon at ${BERTH_CONTEXT_MOUNT} (backed by ${BERTH_CONTEXT_DATA})" >&2
/usr/local/bin/semantic-fs-daemon &

# Wait for the FUSE mount to actually appear in the mount table, not just for
# the process to start — fuse.Mount() hands off to fusermount3 and the mount
# only becomes visible once that completes.
for _ in $(seq 1 50); do
  grep -q " ${BERTH_CONTEXT_MOUNT} fuse" /proc/mounts && break
  sleep 0.1
done

# Translates berth.yml's capabilities into the JSON policy agent-init reads
# (see @berth/sdk's generate-capability-policy.ts for why this lives in
# Node/TypeScript rather than being parsed from YAML in Rust).
node "$PWD/node_modules/@berth/sdk/dist/generate-capability-policy.js"

echo "[berth:entrypoint] handing off to agent-init for kernel-level capability enforcement" >&2
exec /usr/local/bin/agent-init "$@"
