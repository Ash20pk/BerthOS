#!/usr/bin/env bash
set -euo pipefail

if [ -z "${BERTH_APPS:-}" ]; then
  # --- Single-app mode: byte-for-byte today's script, unchanged. ---
  # Guarantees zero regression risk for every existing dev/test/deploy flow
  # and milestone test — BERTH_APPS is only ever set by container.ts when
  # more than one app shares this container (see startContainer()).
  MANIFEST_PATH="${BERTH_MANIFEST_PATH:-$PWD/berth.yml}"

  if [ ! -f "$MANIFEST_PATH" ]; then
    echo "[berth:entrypoint] no berth.yml found at $MANIFEST_PATH" >&2
    exit 1
  fi

  # Additive, defaults to "node" (today's exact behavior, byte-for-byte,
  # when unset) — a Python resident app sets BERTH_APP_RUNTIME=python.
  # PYTHONPATH points straight at the bind-mounted packages/sdk-python
  # source, the same role a pre-existing node_modules symlink plays for a
  # TS app's @berth/sdk — no pip install needed for dev mode.
  if [ "${BERTH_APP_RUNTIME:-node}" = "python" ]; then
    export PYTHONPATH="/workspace/packages/sdk-python${PYTHONPATH:+:$PYTHONPATH}"
  fi

  # Runs on_install hooks (once) and reports whether a browser:* capability is
  # declared. The lifecycle script's last stdout line is "1" or "0" — everything
  # before that is its own on_install command output (already streamed to
  # stderr/stdout by execSync's inherited stdio).
  if [ "${BERTH_APP_RUNTIME:-node}" = "python" ]; then
    NEEDS_BROWSER="$(python3 -m berth_sdk.run_lifecycle | tail -n1)"
  else
    NEEDS_BROWSER="$(node "$PWD/node_modules/@berth/sdk/dist/run-lifecycle.js" | tail -n1)"
  fi

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
  # Node/TypeScript rather than being parsed from YAML in Rust) — mirrored
  # exactly in Python for BERTH_APP_RUNTIME=python (same policy JSON shape;
  # agent-init doesn't care which one wrote it).
  if [ "${BERTH_APP_RUNTIME:-node}" = "python" ]; then
    python3 -m berth_sdk.generate_capability_policy
  else
    node "$PWD/node_modules/@berth/sdk/dist/generate-capability-policy.js"
  fi

  if [ "$NEEDS_BROWSER" = "1" ]; then
    echo "[berth:entrypoint] browser:* capability declared — starting egress broker on 127.0.0.1:${BERTH_EGRESS_BROKER_PORT:-8090}" >&2
    BERTH_CAPABILITY_POLICY="${BERTH_CAPABILITY_POLICY:-$PWD/.berth/capability-policy.json}" node /usr/local/bin/berth-egress-broker.js &
  fi

  # Single-app mode only (see docs/github-api-scoping-reference.md for why a
  # multi-app companion isn't wired up here yet). Path/verb-level scoping of
  # github:read:<scope>/github:write:<scope> needs real TLS interception —
  # unlike the browser egress broker above, this one terminates TLS itself,
  # so the app must both route through it as a proxy AND trust its
  # generated CA (BERTH_GITHUB_API_PROXY / NODE_EXTRA_CA_CERTS below).
  if grep -q "github:" "$MANIFEST_PATH" 2>/dev/null; then
    GITHUB_BROKER_PORT="${BERTH_GITHUB_API_BROKER_PORT:-8092}"
    GITHUB_BROKER_CERT_DIR="${BERTH_GITHUB_API_BROKER_CERT_DIR:-/tmp/berth-github-api-broker}"
    echo "[berth:entrypoint] github:* capability declared — starting GitHub API broker on 127.0.0.1:${GITHUB_BROKER_PORT}" >&2
    BERTH_CAPABILITY_POLICY="${BERTH_CAPABILITY_POLICY:-$PWD/.berth/capability-policy.json}" node /usr/local/bin/berth-github-api-broker.js &

    for _ in $(seq 1 50); do
      [ -f "${GITHUB_BROKER_CERT_DIR}/ca.crt" ] && break
      sleep 0.1
    done
    export BERTH_GITHUB_API_PROXY="http://127.0.0.1:${GITHUB_BROKER_PORT}"
    export NODE_EXTRA_CA_CERTS="${GITHUB_BROKER_CERT_DIR}/ca.crt"
  fi

  # One secret per container boot, inherited by the app process (agent-init
  # execs into it, preserving the environment) — backs @berth/sdk's
  # HMAC-signed capability tokens. Generated with Node rather than openssl/apk
  # so no new Alpine package is needed.
  export BERTH_TOKEN_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"

  echo "[berth:entrypoint] handing off to agent-init for kernel-level capability enforcement" >&2
  if [ "${BERTH_APP_RUNTIME:-node}" = "python" ]; then
    exec /usr/local/bin/agent-init python3 -m berth_sdk.runtime
  else
    exec /usr/local/bin/agent-init "$@"
  fi
fi

# --- Multi-app mode: every app gets its own, real, independent Landlock
# ruleset — N sibling `agent-init` processes, not one exec'd process for the
# whole container plus unenforced companions (that gap is exactly what this
# closes; see context-bus-milestone.mjs's older docker-exec workaround). ---

# name<TAB>workingDir per line, parsed once via Node (already guaranteed
# present) rather than re-implementing JSON parsing in bash.
APPS_TSV="$(node -e 'for (const a of JSON.parse(process.env.BERTH_APPS)) console.log(a.name + "\t" + a.workingDir);')"
echo "[berth:entrypoint] multi-app mode: $(cut -f1 <<<"$APPS_TSV" | tr '\n' ' ')" >&2

# A simple grep for "browser:" in each app's berth.yml, not full YAML/capability
# parsing — good enough for this internal "should Xvfb start at all" decision
# (the CLI's assertAtMostOneBrowserApp already guarantees at most one real
# hit here; this only needs to detect whether that one exists, and which
# app's own .berth/capability-policy.json the egress broker should read).
NEEDS_BROWSER=0
BROWSER_APP_DIR=""
while IFS=$'\t' read -r _ APP_DIR; do
  [ -z "$APP_DIR" ] && continue
  if grep -q "browser:" "$APP_DIR/berth.yml" 2>/dev/null; then
    NEEDS_BROWSER=1
    BROWSER_APP_DIR="$APP_DIR"
  fi
done <<<"$APPS_TSV"

if [ "$NEEDS_BROWSER" = "1" ] && [ "${BERTH_TEST_MODE:-0}" != "1" ]; then
  echo "[berth:entrypoint] browser:* capability declared — starting Xvfb + x11vnc + noVNC" >&2
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
  sleep 1
  x11vnc -display :99 -forever -shared -nopw -quiet &
  websockify --web=/usr/share/novnc 6080 localhost:5900 &
fi

mkdir -p /tmp/berth-rpc

echo "[berth:entrypoint] starting context-bus daemon on ${BERTH_CONTEXT_BUS_SOCKET}" >&2
/usr/local/bin/context-bus-daemon &
for _ in $(seq 1 50); do
  [ -S "$BERTH_CONTEXT_BUS_SOCKET" ] && break
  sleep 0.1
done

echo "[berth:entrypoint] starting semantic-fs daemon at ${BERTH_CONTEXT_MOUNT} (backed by ${BERTH_CONTEXT_DATA})" >&2
/usr/local/bin/semantic-fs-daemon &
for _ in $(seq 1 50); do
  grep -q " ${BERTH_CONTEXT_MOUNT} fuse" /proc/mounts && break
  sleep 0.1
done

# Runs one app's lifecycle (on_install + capability policy) then hands off to
# agent-init, given its name/dir as $1/$2 and its command as the rest of the
# args — a function, not an eval'd string, so none of this has to fight
# nested-quoting rules.
run_app() {
  local app_name="$1"
  local app_dir="$2"
  shift 2

  cd "$app_dir"
  export BERTH_MANIFEST_PATH="$app_dir/berth.yml"
  export BERTH_INSTALL_MARKER="$app_dir/.berth/installed"
  export BERTH_CAPABILITY_POLICY="$app_dir/.berth/capability-policy.json"
  export BERTH_RPC_SOCKET="/tmp/berth-rpc/${app_name}.sock"

  node "node_modules/@berth/sdk/dist/run-lifecycle.js" >/dev/null
  node "node_modules/@berth/sdk/dist/generate-capability-policy.js"
  export BERTH_TOKEN_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"

  exec /usr/local/bin/agent-init "$@"
}

PRIMARY_PID=""
COMPANION_PIDS=()
INDEX=0

while IFS=$'\t' read -r APP_NAME APP_DIR; do
  [ -z "$APP_NAME" ] && continue
  mkdir -p "$APP_DIR/.berth"

  # No app in multi-app mode reads the container's raw stdin — every app,
  # primary included, is reached exclusively via its own RPC Unix socket
  # (docker exec + the relay). Two Node processes sharing one inherited
  # stdin pipe race for bytes and can each receive a truncated,
  # unparseable fragment of the other's RPC line — confirmed by hand (the
  # runtime processes ended up on visibly different underlying pipes after
  # forking, and stdio RPC calls silently stopped getting responses once a
  # second app was added). `</dev/null` for every app sidesteps that
  # fragility entirely rather than depending on exactly how fds survive
  # this script's fork/exec chain.
  run_app "$APP_NAME" "$APP_DIR" node "node_modules/@berth/sdk/dist/runtime.js" </dev/null &
  PID=$!

  if [ "$INDEX" -eq 0 ]; then
    PRIMARY_PID=$PID
  else
    COMPANION_PIDS+=("$PID")
  fi
  INDEX=$((INDEX + 1))
done <<<"$APPS_TSV"

if [ "$NEEDS_BROWSER" = "1" ]; then
  BROWSER_POLICY_PATH="$BROWSER_APP_DIR/.berth/capability-policy.json"
  for _ in $(seq 1 50); do
    [ -f "$BROWSER_POLICY_PATH" ] && break
    sleep 0.1
  done
  echo "[berth:entrypoint] browser:* capability declared — starting egress broker on 127.0.0.1:${BERTH_EGRESS_BROKER_PORT:-8090}" >&2
  BERTH_CAPABILITY_POLICY="$BROWSER_POLICY_PATH" node /usr/local/bin/berth-egress-broker.js &
fi

# Registered only now (not via `exec`, since this script must survive to
# supervise) — docker stop's SIGTERM reaches tini, which forwards to this
# script's own PID; without this trap it would never reach the backgrounded
# app processes at all.
trap 'kill "$PRIMARY_PID" "${COMPANION_PIDS[@]}" 2>/dev/null || true' TERM INT

# The primary's exit ends the container, matching single-app semantics;
# companion crashes are logged (visible in container logs, same stdout/stderr)
# but don't take the sandbox down. `wait` on a background job trips `set -e`
# on a non-zero exit, so it's bracketed explicitly.
set +e
wait "$PRIMARY_PID"
EXIT_CODE=$?
set -e
kill "${COMPANION_PIDS[@]}" 2>/dev/null || true
exit "$EXIT_CODE"
