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

# Creates the uid, gid, and directories one app runs as, and exports
# BERTH_APP_UID/BERTH_APP_GID for agent-init to drop to just before exec.
# Step 1 of docs/per-app-uid-design.md.
#
# uid = 10000 + the app's index in BERTH_APPS (single-app mode is always
# index 0, so uid 10000). Index-derived rather than name-hashed because a
# hash collides, and the failure mode of a collision is two apps silently
# sharing an identity — the exact thing this exists to stop.
#
# Every failure below warns and continues rather than aborting the boot. A
# container where identity provisioning failed is exactly as (un)isolated as
# every Berth container was before this existed: agent-init sees no
# BERTH_APP_UID and stays root, which is a known posture rather than a new
# one. Failing the boot instead would turn a `chown` that a read-only mount
# refused into a container that won't start.
provision_app_identity() {
  local app_name="$1"
  local app_index="$2"
  local app_dir="$3"
  local id=$((10000 + app_index))
  local user="berth-${app_name}"

  if ! addgroup -g "$id" "$user" 2>/dev/null; then
    echo "[berth:entrypoint] WARNING: could not create group ${user} (gid ${id}) — ${app_name} will keep running as root" >&2
    return 0
  fi
  if ! adduser -S -D -H -u "$id" -G "$user" -s /sbin/nologin "$user" 2>/dev/null; then
    echo "[berth:entrypoint] WARNING: could not create user ${user} (uid ${id}) — ${app_name} will keep running as root" >&2
    return 0
  fi
  # The one identity shared between apps: what it grants is /context and the
  # three daemon control sockets, all of which are shared by design (see the
  # socket table in docs/per-app-uid-design.md).
  addgroup "$user" berth 2>/dev/null || true
  # /dev/ptmx and the devpts mount are root:tty, so allocating a pty is a DAC
  # question as well as a Landlock one (REMEDIATION.md 1.15 covers the latter).
  # Granted only to an app that declared terminal:*, matching exactly what
  # generate-capability-policy.ts compiles the pty write paths for.
  if grep -q "terminal:" "$app_dir/berth.yml" 2>/dev/null; then
    addgroup "$user" tty 2>/dev/null || true
  fi

  # Where this app's RPC socket lives, since Step 3 of the design doc took it
  # out of world-writable /tmp/berth-rpc (REMEDIATION.md 1.4).
  #
  # 0711 — traverse, but not list. Nothing in here is reachable by a sibling by
  # default: rpc.sock itself is 0600 (the app and root, i.e. the host relay).
  # An authorized sibling instead gets its own socket under peers/<caller>/,
  # created by grant_invoke_access below, and the `x` bit here is only what
  # lets it walk to that. Without `x` a caller could not reach its own
  # directory; with `r` it could enumerate every other caller's, which it has
  # no reason to see.
  #
  # The private scratch directory is the other half: /tmp itself is no longer
  # in any app's write policy, so TMPDIR (exported by run_app / the single-app
  # path) points here instead. 0700 — nothing is ever granted into it.
  install -d -m 0711 -o "$id" -g "$id" "/run/berth/${app_name}" 2>/dev/null \
    || echo "[berth:entrypoint] WARNING: could not create /run/berth/${app_name} — this app's RPC socket has nowhere to live" >&2
  install -d -m 0711 -o "$id" -g "$id" "/run/berth/${app_name}/peers" 2>/dev/null \
    || echo "[berth:entrypoint] WARNING: could not create /run/berth/${app_name}/peers — no sibling will be able to call this app" >&2
  install -d -m 0700 -o "$id" -g "$id" "/tmp/${app_name}" 2>/dev/null \
    || echo "[berth:entrypoint] WARNING: could not create /tmp/${app_name} — this app has no writable scratch directory" >&2

  # .berth only — deliberately NOT the app directory itself. That directory is
  # the developer's own repository under `berth dev`'s bind mount, and
  # chown -R'ing someone's working tree is option 1 in Blocker 1 of
  # docs/per-app-uid-design.md, rejected there for that reason. .berth is
  # different in kind: Berth creates it, it is gitignored, and in a real
  # `berth dev` it is a Docker-owned named volume (container.ts's
  # appStateVolume) rather than a host directory at all.
  #
  # The cost is Blocker 1's, unchanged: an app that declares a write path
  # inside a host-owned bind mount cannot write it as a non-root uid. 1.6
  # made that mount read-only, so for `berth dev` the question is now mostly
  # moot; where it is not, the app gets a truthful EACCES rather than Berth
  # rewriting ownership on the host to paper over it.
  mkdir -p "$app_dir/.berth"
  chown -R "$id:$id" "$app_dir/.berth" 2>/dev/null \
    || echo "[berth:entrypoint] WARNING: could not chown ${app_dir}/.berth to ${user} — the app may fail to write its own state" >&2

}

# One app's declared `app:invoke:<target>` capabilities, turned into a private
# channel: `/run/berth/<target>/peers/<caller>/`, owned by the target and
# group-owned by the *caller*, mode 2710.
#
# Each bit of that is load-bearing:
#   owner <target>  — the target binds its socket in here, and it is not root
#   group <caller>  — the caller is the only unprivileged uid that can traverse
#   0710            — no "other" access at all; siblings see nothing
#   setgid (2)      — the socket the target creates inherits the *caller's*
#                     group, so it lands reachable without the target (a
#                     non-root process) needing to chown anything
#
# Group membership was the Step 3 mechanism and is deliberately gone: adding
# the caller to the target's group let it reach that app's socket, but told the
# *server* nothing about which sibling had called. A directory per caller is
# both the authorization and the identity, because which socket a connection
# arrived on is a fact the kernel established at connect(2) and the caller
# cannot influence. That is Step 4's SO_PEERCRED property, obtained the only
# way available to a Node server — see @berth/sdk's rpc.ts.
#
# This is the authorized half of REMEDIATION.md 1.4. The unauthorized half —
# any app reaching any other app's socket because they all sat in a 1777
# directory — is what Step 3 closes; but @berth/agents' generated agent app
# genuinely calls its sibling apps' exports (network.ts's callSibling, the
# agent-as-tool path), so closing it without an opt-in would delete a shipped
# feature rather than secure it. Declaring the capability is now what buys it,
# and the declaration is visible in `berth.yml` and in the audit line.
#
# Must run after *every* app's identity and peers/ directory exist, not inline
# with provisioning: both belong to the target, which may come later in the app
# list than its caller. Hence the separate pass in the loop below.
#
grant_invoke_access() {
  local caller_name="$1"
  local caller_dir="$2"
  local target
  # Deliberately a grep rather than a YAML parse, matching how this script
  # already decides about browser:/network:peer:/github: — the CapabilityString
  # grammar has already been validated by loadManifest() on the host, and the
  # name that follows is constrained to ^[a-z0-9-]+$ by the manifest schema.
  for target in $(grep -oE '^[[:space:]]*-[[:space:]]*app:invoke:[a-z0-9-]+' "$caller_dir/berth.yml" 2>/dev/null | sed 's/.*app:invoke://'); do
    if ! getent group "berth-${target}" >/dev/null 2>&1; then
      echo "[berth:entrypoint] WARNING: ${caller_name} declares app:invoke:${target}, but no app named ${target} is in this container — ignoring" >&2
      continue
    fi
    # Numeric ids rather than names: busybox's `install` resolves both, but the
    # rest of this script already works in numeric ids and one convention is
    # easier to check than two.
    local target_uid caller_gid
    target_uid="$(id -u "berth-${target}" 2>/dev/null)"
    caller_gid="$(id -g "berth-${caller_name}" 2>/dev/null)"
    if [ -z "$target_uid" ] || [ -z "$caller_gid" ]; then
      echo "[berth:entrypoint] WARNING: could not resolve ids for ${caller_name} -> ${target} — its app:invoke:${target} calls will fail with EACCES" >&2
      continue
    fi
    if install -d -m 2710 -o "$target_uid" -g "$caller_gid" "/run/berth/${target}/peers/${caller_name}" 2>/dev/null; then
      echo "[berth:entrypoint] ${caller_name} may invoke ${target}'s exports (app:invoke:${target}) via /run/berth/${target}/peers/${caller_name}" >&2
    else
      echo "[berth:entrypoint] WARNING: could not create /run/berth/${target}/peers/${caller_name} — ${caller_name}'s app:invoke:${target} calls will fail with EACCES" >&2
    fi
  done
}

# Exports the identity agent-init reads and drops to, immediately before the
# app is forked. Split out of provision_app_identity so it runs *after*
# grant_invoke_access has finished wiring group membership — the supplementary
# list is read back from the user database here rather than assembled by hand,
# so a group added by any of the steps above (berth, tty, a sibling's group)
# is picked up without this function needing to know about it.
#
# Without it the app would keep *root's* supplementary groups — gid 0, which
# owns most of the container — while holding an unprivileged uid, which is the
# worst of both.
export_app_identity() {
  local app_name="$1"
  local app_index="$2"
  local user="berth-${app_name}"

  if ! id "$user" >/dev/null 2>&1; then
    # provision_app_identity warned already; agent-init sees no BERTH_APP_UID
    # and stays root, which is the pre-Step-2 posture rather than a new one.
    unset BERTH_APP_UID BERTH_APP_GID BERTH_APP_SUPPLEMENTARY_GIDS
    return 0
  fi

  export BERTH_APP_UID=$((10000 + app_index))
  export BERTH_APP_GID=$((10000 + app_index))
  export BERTH_APP_SUPPLEMENTARY_GIDS="$(id -G "$user" 2>/dev/null | tr ' ' ',')"
}

# Points every "somewhere to scratch" convention at the app's own 0700
# directory, now that /tmp itself is no longer in any app's write policy
# (REMEDIATION.md 1.4, and see generate-capability-policy.ts's baseline).
#
# Each of these was found by asking what actually writes to a hardcoded /tmp
# path in this image, rather than by guessing:
#   TMPDIR       — Node's os.tmpdir() and Python's tempfile both honour it,
#                  which covers Playwright's browser profile directories and
#                  Chromium's own base::GetTempDir (--disable-dev-shm-usage
#                  puts shared memory there).
#   TMUX_TMPDIR  — a tmux server's socket directory, otherwise /tmp/tmux-<uid>
#                  (apps/terminal; see REMEDIATION.md 1.15 for the strace).
#   XDG_*        — base.Dockerfile sets these to /tmp/.chromium image-wide,
#                  which every app in a multi-app container would otherwise
#                  share; overridden per app here.
#   HOME         — /root by default, which a non-root app cannot write. This
#                  is not new in Step 3 (it was already true once apps stopped
#                  being uid 0) but pointing it somewhere real is what stops
#                  a tool that writes a dotfile failing for no visible reason.
#
# The daemon control sockets stay at /tmp/berth-*.sock and are unaffected:
# connecting to a pathname socket needs neither a Landlock write rule nor
# write access to /tmp, only DAC on the socket itself (0660 root:berth).
export_app_environment() {
  local app_name="$1"
  export TMPDIR="/tmp/${app_name}"
  export TMUX_TMPDIR="$TMPDIR"
  export XDG_CONFIG_HOME="$TMPDIR/.config"
  export XDG_CACHE_HOME="$TMPDIR/.cache"
  export HOME="$TMPDIR"
}

# The one host-owned directory a `berth dev` app still has to write, and the
# whole of what is left of Blocker 1 in docs/per-app-uid-design.md. The
# workspace root itself is read-only since REMEDIATION.md 1.6, so this is not
# the repository — it is `.berth/dev-workspace`, which Berth creates,
# gitignores, and mounts specifically to hold app data.
#
# Option 2 from that blocker: chgrp to the shared group rather than chown to
# any one app, because this directory is deliberately shared (a companion
# writing a file the primary reads is the point of multi-app mode). setgid so
# files created in it stay reachable by the next app.
#
# It does mutate ownership on the developer's host, and that is a real cost
# stated rather than hidden — bounded to one Berth-created, gitignored
# directory, which is the trade the design accepted.
grant_dev_workspace() {
  local dir="${BERTH_WORKSPACE_ROOT:-}"
  [ -n "$dir" ] || return 0
  case "$dir" in
    */.berth/dev-workspace) ;;
    # Anything else is not the directory this was written for — a standalone
    # app, a workspace root, a path someone set by hand. Leave it alone.
    *) return 0 ;;
  esac
  # `berth dev` creates this host-side before the container starts (a nested
  # mountpoint has to exist inside a read-only bind), but a caller using
  # startContainer directly may only have set the variable. Creating it here
  # as root, once, is what lets the app — which is about to stop being root —
  # write there at all.
  mkdir -p "$dir" 2>/dev/null || true
  [ -d "$dir" ] || return 0
  chgrp -R berth "$dir" 2>/dev/null \
    || { echo "[berth:entrypoint] WARNING: could not chgrp ${dir} to berth — a non-root app cannot write it" >&2; return 0; }
  chmod -R g+rwX "$dir" 2>/dev/null || true
  chmod g+s "$dir" 2>/dev/null || true
}

# Run after generate-capability-policy.js, never before: the app must be able
# to read the policy agent-init applies to it, and must never be able to
# rewrite it for the next boot. 0640 root:<app> is both.
secure_capability_policy() {
  local policy_path="$1"
  [ -f "$policy_path" ] || return 0
  [ -n "${BERTH_APP_GID:-}" ] || return 0
  chown "0:${BERTH_APP_GID}" "$policy_path" 2>/dev/null || true
  chmod 0640 "$policy_path" 2>/dev/null || true
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

  # The app's name comes from the policy that was just generated rather than
  # from a second YAML parse here — it is the same name agent-init logs and
  # the same one the RPC socket is named for, so taking it from anywhere else
  # is an opportunity for the two to disagree.
  SINGLE_APP_POLICY="${BERTH_CAPABILITY_POLICY:-$PWD/.berth/capability-policy.json}"
  APP_NAME="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).appName)" "$SINGLE_APP_POLICY" 2>/dev/null || true)"
  if [ -n "$APP_NAME" ]; then
    provision_app_identity "$APP_NAME" 0 "$PWD"
    # No grant_invoke_access here: single-app mode has no siblings to invoke,
    # and no app RPC socket at all — the app is reached over the container's
    # own stdio (see docs/mcp-bridge-reference.md).
    export_app_identity "$APP_NAME" 0
    export_app_environment "$APP_NAME"
    grant_dev_workspace
    secure_capability_policy "$SINGLE_APP_POLICY"
  else
    echo "[berth:entrypoint] WARNING: could not read the app name from ${SINGLE_APP_POLICY} — running as root" >&2
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

  # No BERTH_TOKEN_SECRET any more. It backed @berth/sdk's HMAC-signed
  # capability tokens, which REMEDIATION.md 1.10 removed: nothing ever
  # verified one, and exporting the signing key into the environment of the
  # very process the tokens were meant to constrain is what made them
  # unverifiable in principle, not just in practice.

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

# 0755 root-owned, and deliberately not writable by any app: the per-app
# directories beneath it are created (0710, owned by that app) by
# provision_app_identity, and nothing else may add an entry here. This
# replaces the 1777 /tmp/berth-rpc every app could bind or connect into,
# which was REMEDIATION.md 1.4's finding.
install -d -m 0755 -o 0 -g 0 /run/berth

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
  # /run/berth/<app>/, mode 0710 owned by this app — not the shared 1777
  # /tmp/berth-rpc it used to be (REMEDIATION.md 1.4). A sibling reaches it
  # only by declaring app:invoke:<name>, which puts it in this app's group;
  # the host relay reaches it as root (docker exec), which is unchanged.
  export BERTH_RPC_SOCKET="/run/berth/${app_name}/rpc.sock"
  export_app_environment "$app_name"

  # No run-lifecycle.js call here any more. Multi-app mode never used its
  # browser/egress flags (the grep loop above decides those for the whole
  # container), so once on_install moved to build time — REMEDIATION.md 1.5 —
  # the only thing this invocation still did was cost a Node startup per app.
  node "node_modules/@berth/sdk/dist/generate-capability-policy.js"
  secure_capability_policy "$BERTH_CAPABILITY_POLICY"

  exec /usr/local/bin/agent-init "$@"
}

# Compiles every app's policy and creates the directories those policies
# declare, serially, before any app's agent-init runs. This is the boot
# ordering REMEDIATION.md 1.12 named as the real fix and deferred.
#
# The race it removes: apps start concurrently (`run_app ... &`), and
# agent-init deliberately does *not* create declared read paths — creating a
# directory as a side effect of declaring a capability, as uid 0, on the
# developer's host through a bind mount, is what 1.12 refused. So an app
# declaring `filesystem:read:/workspace` binds its read grant against whatever
# exists at that instant. If the app that declares `filesystem:write:/workspace`
# hasn't created it yet, the reader's grant is skipped — permanently, because
# the ruleset is sealed moments later — and every later read there is EACCES.
#
# Which app won that race decided whether the container worked, so it failed
# intermittently and only where Landlock is enforced. That is the Agents
# Milestone flake: `computer-multi-app-milestone.mjs` has apps/filesystem
# writing /workspace and apps/code-editor reading it.
#
# Ownership is decided here rather than left to agent-init, which only chowns
# paths it created itself — and after this pass, it never creates any:
#
#   declared writable by exactly one app  -> that app's uid, 0755
#   declared writable by several          -> root:berth, 2775 (setgid, so
#                                            files stay reachable by the next
#                                            app, same as grant_dev_workspace)
#
# Anything that already exists is left completely alone — /tmp, /context, a
# bind mount, and each app's own /run/berth/<app> and /tmp/<app> from
# provision_app_identity. Taking ownership of a directory somebody else made
# is Blocker 1's mistake and is not this pass's business.
precreate_declared_paths() {
  local tsv="$1"
  local decls="/tmp/.berth-declared-write-paths"
  : >"$decls"

  local idx=0 name dir uid
  while IFS=$'\t' read -r name dir; do
    [ -z "$name" ] && continue
    uid=$((10000 + idx))
    idx=$((idx + 1))
    # Same command run_app runs; running it twice is idempotent and costs one
    # Node start per app, which buys a deterministic boot.
    ( cd "$dir" \
        && BERTH_MANIFEST_PATH="$dir/berth.yml" \
           BERTH_CAPABILITY_POLICY="$dir/.berth/capability-policy.json" \
           node "node_modules/@berth/sdk/dist/generate-capability-policy.js" >/dev/null ) \
      || { echo "[berth:entrypoint] WARNING: could not pre-compile ${name}'s capability policy — its declared paths may not exist when a sibling binds a read grant on them" >&2; continue; }

    node -e '
      const fs = require("fs");
      const policy = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const p of policy.writePaths ?? []) process.stdout.write(`${p}\t${process.argv[2]}\n`);
    ' "$dir/.berth/capability-policy.json" "$uid" >>"$decls" 2>/dev/null || true
  done <<<"$tsv"

  local path owners owner
  # cut/sort/uniq rather than an associative array: this is /bin/sh-adjacent
  # busybox ash territory, and the list is a handful of lines.
  for path in $(cut -f1 "$decls" | sort -u); do
    [ -n "$path" ] || continue
    [ -e "$path" ] && continue
    owners="$(awk -F'\t' -v p="$path" '$1 == p { print $2 }' "$decls" | sort -u | wc -l)"
    mkdir -p "$path" 2>/dev/null || { echo "[berth:entrypoint] WARNING: could not create declared path $path" >&2; continue; }
    if [ "$owners" -eq 1 ]; then
      owner="$(awk -F'\t' -v p="$path" '$1 == p { print $2; exit }' "$decls")"
      chown "$owner:$owner" "$path" 2>/dev/null || true
      chmod 0755 "$path" 2>/dev/null || true
      echo "[berth:entrypoint] created declared path $path for uid $owner" >&2
    else
      chown "0:${BERTH_SHARED_GID:-9999}" "$path" 2>/dev/null || true
      chmod 2775 "$path" 2>/dev/null || true
      echo "[berth:entrypoint] created declared path $path shared by $owners apps (root:berth, setgid)" >&2
    fi
  done

  rm -f "$decls"
}

# Three serial passes over the app list, not one, because each depends on the
# previous having finished for *every* app:
#
#   1. identities — adduser/addgroup rewrite /etc/passwd and /etc/group with no
#      locking between them, and run_app is forked into the background, so N
#      concurrent subshells creating users is a corrupted passwd file waiting
#      to happen. Serial here in the parent, so each app's identity exists
#      before any app's process does.
#   2. app:invoke: grants — a caller can only be added to its target's group
#      once that group exists, and the target may come later in the list.
#   3. the forks themselves.
#
# BERTH_APP_UID/GID and TMPDIR are exported into *this* shell by pass 3 and
# read by the fork on the very next line, then overwritten by the next
# iteration. That is the whole lifetime of those values; nothing after the
# loop should read them.
INDEX=0
while IFS=$'\t' read -r APP_NAME APP_DIR; do
  [ -z "$APP_NAME" ] && continue
  mkdir -p "$APP_DIR/.berth"
  provision_app_identity "$APP_NAME" "$INDEX" "$APP_DIR"
  INDEX=$((INDEX + 1))
done <<<"$APPS_TSV"

grant_dev_workspace

while IFS=$'\t' read -r APP_NAME APP_DIR; do
  [ -z "$APP_NAME" ] && continue
  grant_invoke_access "$APP_NAME" "$APP_DIR"
done <<<"$APPS_TSV"

# After grant_dev_workspace (so a declared path *inside* the dev workspace
# inherits that directory's group before anything is created under it) and
# before any app starts, which is the whole point.
precreate_declared_paths "$APPS_TSV"

PRIMARY_PID=""
COMPANION_PIDS=()
INDEX=0

while IFS=$'\t' read -r APP_NAME APP_DIR; do
  [ -z "$APP_NAME" ] && continue
  export_app_identity "$APP_NAME" "$INDEX"

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
