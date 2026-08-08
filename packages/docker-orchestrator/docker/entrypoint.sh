#!/usr/bin/env bash
set -euo pipefail

# One id per container boot, exported before anything else starts so every
# daemon and app process in this container (context-bus, semantic-fs, mesh,
# every per-app agent-init) inherits the same value — the only thing that
# lets a real incident be traced across process boundaries by grepping for
# one string, rather than correlating log timestamps by hand across three
# runtimes. /proc/sys/kernel/random/uuid is a kernel interface (no userland
# package needed, unlike uuidgen) present on any real Linux kernel.
export BERTH_BOOT_ID="$(cat /proc/sys/kernel/random/uuid)"
echo "[berth:entrypoint] boot id: ${BERTH_BOOT_ID}" >&2

# Starts the display stack a browser:* app needs: Xvfb for Chromium to draw
# into, x11vnc to serve that display, and websockify/noVNC to put it in a
# browser tab. Identical in single- and multi-app mode, so it lives here
# rather than being duplicated into both branches.
#
# The VNC password is the one thing standing between this display — a live
# view of, and mouse/keyboard control over, whatever the agent is doing — and
# anything that can reach port 5900. x11vnc's `-nopw` (what this used to
# pass) disables authentication entirely. container.ts generates
# BERTH_VNC_PASSWORD per boot and hands it to `berth dev` to print; if it
# somehow isn't set, one is generated here instead and logged, because
# starting without a password at all is not an acceptable fallback. The
# `-storepasswd` file lands in root-owned /root rather than the world-
# writable /tmp every resident app can write to.
start_display_stack() {
  echo "[berth:entrypoint] browser:* capability declared — starting Xvfb + x11vnc + noVNC" >&2
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
  # give Xvfb a moment to create the display socket before Chromium/x11vnc attach
  sleep 1
  if [ -z "${BERTH_VNC_PASSWORD:-}" ]; then
    BERTH_VNC_PASSWORD="$(head -c 6 /dev/urandom | base64 | tr '+/' '-_' | cut -c1-8)"
    echo "[berth:entrypoint] WARNING: no BERTH_VNC_PASSWORD was passed in; generated one for this boot: ${BERTH_VNC_PASSWORD}" >&2
  fi
  mkdir -p /root/.berth
  chmod 700 /root/.berth
  # If the password file can't be written, start neither x11vnc nor
  # websockify. Falling back to -nopw would serve the agent's live display,
  # with input, to anything that can reach 5900; and letting `set -e` abort
  # would take the whole container down over a feature nobody's watching yet.
  # Fail closed on the display, not on the sandbox.
  if ! x11vnc -storepasswd "$BERTH_VNC_PASSWORD" /root/.berth/vncpasswd >/dev/null 2>&1; then
    echo "[berth:entrypoint] WARNING: could not write the VNC password file — starting no VNC server at all rather than an unauthenticated one. The browser itself is unaffected; only the human-facing view is." >&2
    return 0
  fi
  x11vnc -display :99 -forever -shared -rfbauth /root/.berth/vncpasswd -quiet &
  websockify --web=/usr/share/novnc 6080 localhost:5900 &
}

if [ -z "${BERTH_APPS:-}" ]; then
  # --- Single-app mode. ---
  # BERTH_APPS is only ever set by container.ts when more than one app
  # shares this container (see startContainer()).
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

  # Reports two independent flags: whether a browser:* capability is declared
  # (needs Xvfb/a display) and whether a browser:navigate:*/network:host:*
  # capability is declared (needs the egress broker) — deliberately not the
  # same flag, since a plain network:host:* app (no Chromium, no display)
  # still needs the broker.
  #
  # It no longer runs the manifest's on_install commands: those are a Docker
  # build layer now (docker/run-on-install.sh), not a root shell this script
  # execs before agent-init has applied any Landlock domain. REMEDIATION.md 1.5.
  # The lifecycle script's last stdout line is "<0|1>,<0|1>" — everything
  # before that is its own on_install command output (already streamed to
  # stderr/stdout by execSync's inherited stdio).
  if [ "${BERTH_APP_RUNTIME:-node}" = "python" ]; then
    LIFECYCLE_FLAGS="$(python3 -m berth_sdk.run_lifecycle | tail -n1)"
  else
    LIFECYCLE_FLAGS="$(node "$PWD/node_modules/@berth/sdk/dist/run-lifecycle.js" | tail -n1)"
  fi
  NEEDS_BROWSER="${LIFECYCLE_FLAGS%,*}"
  NEEDS_EGRESS_BROKER="${LIFECYCLE_FLAGS#*,}"

  if [ "$NEEDS_BROWSER" = "1" ] && [ "${BERTH_TEST_MODE:-0}" != "1" ]; then
    start_display_stack
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
  grep -q " ${BERTH_CONTEXT_MOUNT} fuse" /proc/mounts \
    || echo "[berth:entrypoint] WARNING: ${BERTH_CONTEXT_MOUNT} never appeared as a FUSE mount — semantic-fs-daemon likely died on mount(2) (check AppArmor); the SDK will silently fall back to a local stub that always returns empty query results" >&2

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

  if [ "$NEEDS_EGRESS_BROKER" = "1" ]; then
    EGRESS_BROKER_PORT="${BERTH_EGRESS_BROKER_PORT:-8090}"
    echo "[berth:entrypoint] browser:navigate:*/network:host:* capability declared — starting egress broker on 127.0.0.1:${EGRESS_BROKER_PORT}" >&2
    BERTH_CAPABILITY_POLICY="${BERTH_CAPABILITY_POLICY:-$PWD/.berth/capability-policy.json}" node /usr/local/bin/berth-egress-broker.js &
    # The standardized way any resident app's own code (not just Chromium's
    # --proxy-server flag) discovers the broker — @berth/sdk's
    # configureEgressProxy() reads exactly this. Same name whether this app
    # got here via browser:navigate:* or network:host:*.
    export BERTH_EGRESS_PROXY_URL="http://127.0.0.1:${EGRESS_BROKER_PORT}"
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

  # network:peer:* capability support (see docs/mesh-reference.md). Started
  # after generate-capability-policy.js above (unlike context-bus/semantic-fs,
  # which start before it) because mesh-daemon reads that same
  # capability-policy.json's meshPeers field on its own boot — same ordering
  # reason the egress/GitHub brokers above wait for it too. Never fails boot:
  # a missing kernel wireguard module, unreachable coordinator, etc. all just
  # leave the mesh inert for this container, exactly like a browser:*/
  # terminal:* port that never gets mapped.
  if grep -q "network:peer:" "$MANIFEST_PATH" 2>/dev/null; then
    echo "[berth:entrypoint] network:peer:* capability declared — starting mesh daemon" >&2
    /usr/local/bin/mesh-daemon &
    for _ in $(seq 1 50); do
      [ -S "${BERTH_MESH_SOCKET:-/tmp/berth-mesh.sock}" ] && break
      sleep 0.1
    done
    [ -S "${BERTH_MESH_SOCKET:-/tmp/berth-mesh.sock}" ] \
      || echo "[berth:entrypoint] WARNING: mesh-daemon's control socket never appeared — continuing without mesh" >&2
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

# A simple grep for capability substrings in each app's berth.yml, not full
# YAML/capability parsing — good enough for these internal "should X start at
# all" decisions (the CLI's assertAtMostOne*App checks already guarantee at
# most one real hit for each, before the container even starts).
#
# Xvfb/VNC and the egress broker are deliberately two separate checks, not
# one: a browser:navigate:*/network:host:* app needs the broker but never a
# display, so a plain network:host:* app (no Chromium at all) gets the
# broker started for it just the same as browser-native does — this is what
# makes the broker a capability any resident app can opt into, not a
# browser-specific side effect.
NEEDS_BROWSER=0
BROWSER_APP_DIR=""
# Same "at most one, whole-container-shared resource" constraint Xvfb/mesh
# already have (assertAtMostOneEgressBrokerApp enforces it pre-boot) — real
# per-app broker instances (own port, own isolated pattern list) would be
# the fuller fix, same as multi-app Landlock rulesets already are per-app,
# but is real additional scope this pass doesn't attempt. See
# docs/egress-broker-reference.md.
NEEDS_EGRESS_BROKER=0
EGRESS_APP_DIR=""
# network:peer:* support (see docs/mesh-reference.md) — wg0 is one interface
# per container, same reasoning as BROWSER_APP_DIR above, so the CLI's
# assertAtMostOneMeshApp guarantees at most one hit here.
NEEDS_MESH=0
MESH_APP_DIR=""
while IFS=$'\t' read -r _ APP_DIR; do
  [ -z "$APP_DIR" ] && continue
  if grep -q "browser:" "$APP_DIR/berth.yml" 2>/dev/null; then
    NEEDS_BROWSER=1
    BROWSER_APP_DIR="$APP_DIR"
  fi
  if grep -qE "browser:navigate:|network:host:" "$APP_DIR/berth.yml" 2>/dev/null; then
    NEEDS_EGRESS_BROKER=1
    EGRESS_APP_DIR="$APP_DIR"
  fi
  if grep -q "network:peer:" "$APP_DIR/berth.yml" 2>/dev/null; then
    NEEDS_MESH=1
    MESH_APP_DIR="$APP_DIR"
  fi
done <<<"$APPS_TSV"

if [ "$NEEDS_BROWSER" = "1" ] && [ "${BERTH_TEST_MODE:-0}" != "1" ]; then
  start_display_stack
fi

# Exported before any app process forks below (the port itself is a fixed
# default known upfront — only the broker process's actual startup happens
# later, once EGRESS_APP_DIR's capability policy exists) so every app in this
# container, whichever one declared the capability, inherits the same
# standardized variable @berth/sdk's configureEgressProxy() reads.
if [ "$NEEDS_EGRESS_BROKER" = "1" ]; then
  export BERTH_EGRESS_PROXY_URL="http://127.0.0.1:${BERTH_EGRESS_BROKER_PORT:-8090}"
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
grep -q " ${BERTH_CONTEXT_MOUNT} fuse" /proc/mounts \
  || echo "[berth:entrypoint] WARNING: ${BERTH_CONTEXT_MOUNT} never appeared as a FUSE mount — semantic-fs-daemon likely died on mount(2) (check AppArmor); the SDK will silently fall back to a local stub that always returns empty query results" >&2

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
  export BERTH_CAPABILITY_POLICY="$app_dir/.berth/capability-policy.json"
  export BERTH_RPC_SOCKET="/tmp/berth-rpc/${app_name}.sock"

  # No run-lifecycle.js call here any more. Multi-app mode never used its
  # browser/egress flags (the grep loop above decides those for the whole
  # container), so once on_install moved to build time — REMEDIATION.md 1.5 —
  # the only thing this invocation still did was cost a Node startup per app.
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

if [ "$NEEDS_EGRESS_BROKER" = "1" ]; then
  EGRESS_POLICY_PATH="$EGRESS_APP_DIR/.berth/capability-policy.json"
  for _ in $(seq 1 50); do
    [ -f "$EGRESS_POLICY_PATH" ] && break
    sleep 0.1
  done
  echo "[berth:entrypoint] browser:navigate:*/network:host:* capability declared — starting egress broker on 127.0.0.1:${BERTH_EGRESS_BROKER_PORT:-8090}" >&2
  BERTH_CAPABILITY_POLICY="$EGRESS_POLICY_PATH" node /usr/local/bin/berth-egress-broker.js &
fi

if [ "$NEEDS_MESH" = "1" ]; then
  MESH_POLICY_PATH="$MESH_APP_DIR/.berth/capability-policy.json"
  for _ in $(seq 1 50); do
    [ -f "$MESH_POLICY_PATH" ] && break
    sleep 0.1
  done
  echo "[berth:entrypoint] network:peer:* capability declared — starting mesh daemon" >&2
  BERTH_CAPABILITY_POLICY="$MESH_POLICY_PATH" /usr/local/bin/mesh-daemon &
  for _ in $(seq 1 50); do
    [ -S "${BERTH_MESH_SOCKET:-/tmp/berth-mesh.sock}" ] && break
    sleep 0.1
  done
  [ -S "${BERTH_MESH_SOCKET:-/tmp/berth-mesh.sock}" ] \
    || echo "[berth:entrypoint] WARNING: mesh-daemon's control socket never appeared — continuing without mesh" >&2
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
