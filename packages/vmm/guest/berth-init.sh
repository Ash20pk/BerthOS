#!/bin/sh
# Guest-side init for the microVM spike: the single-app half of
# docker/entrypoint.sh, cut down to what apps/notes needs. libkrun's init.krun
# is PID 1 (it mounts /proc, /sys, /dev and execs this as root).
#
#   BERTH_VM_MODE=rpc    serve the app's stdio RPC on vsock port 5000
#   BERTH_VM_MODE=probe  run the enforcement probe under agent-init and exit
set -eu
log() { echo "[berth:vm-init] $*" >&2; }
log "init start uptime=$(cut -d' ' -f1 /proc/uptime)s kernel=$(uname -r)"

export BERTH_BOOT_ID="$(cat /proc/sys/kernel/random/uuid)"
mountpoint -q /sys/kernel/security || mount -t securityfs securityfs /sys/kernel/security 2>/dev/null || true
mountpoint -q /sys/fs/cgroup || mount -t cgroup2 -o nsdelegate cgroup2 /sys/fs/cgroup
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /run
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /workspace
mkdir -p /app
mount -t virtiofs -o ro app /app
log "lsm=$(cat /sys/kernel/security/lsm 2>/dev/null || echo none) links=$(ls /sys/class/net | tr '\n' ' ')"

APP_UID=10000
APP_GID=10000
POLICY=/run/berth/capability-policy.json
mkdir -p /run/berth
cd /app

# Compile berth.yml into agent-init's policy with the same bundle the image
# runs as root before agent-init (bundle-daemons.mjs's sdk-node tools).
env -u NODE_OPTIONS -u NODE_PATH BERTH_CAPABILITY_POLICY="$POLICY" \
    node /opt/berth/sdk-node/generate-capability-policy.mjs >&2
APP_NAME=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).appName)" "$POLICY")
chown 0:$APP_GID "$POLICY"
chmod 0640 "$POLICY"
# Per-app run/tmp dirs the compiled baseline grants (entrypoint.sh's provision_app_identity).
for d in /run/berth/$APP_NAME /tmp/$APP_NAME; do mkdir -p "$d"; chown $APP_UID:$APP_GID "$d"; chmod 0700 "$d"; done
chown $APP_UID:$APP_GID /workspace
log "policy compiled for \"$APP_NAME\" uptime=$(cut -d' ' -f1 /proc/uptime)s"

# The environment agent-init reads, and what the app sees.
export BERTH_CAPABILITY_POLICY="$POLICY" BERTH_APP_UID=$APP_UID BERTH_APP_GID=$APP_GID \
    BERTH_REQUIRE_ENFORCEMENT="${BERTH_REQUIRE_ENFORCEMENT:-1}" BERTH_APP_NAME="$APP_NAME" BERTH_WORKSPACE_ROOT=/workspace \
    BERTH_APP_ENTRY=/app/dist/index.mjs BERTH_NO_SEMANTIC_FS=1 HOME=/tmp/$APP_NAME \
    TMPDIR=/tmp/$APP_NAME

( sleep 2; log "guest-mem $(awk '/MemTotal|MemAvailable/ {sub(":", "", $1); printf "%s=%dMiB ", $1, $2/1024}' /proc/meminfo)" ) &

case "${BERTH_VM_MODE:-rpc}" in
probe)
    log "probe as root, no agent-init (the VM wall alone):"
    /usr/local/bin/berth-probe /tmp | sed 's/^/[probe:root] /' >&2
    log "probe as the app, under agent-init (both walls):"
    /usr/local/bin/agent-init /usr/local/bin/berth-probe /workspace 2>&1 | sed 's/^/[probe:app] /' >&2
    log "probe done"
    ;;
rpc)
    log "serving $APP_NAME's stdio RPC on vsock:5000 uptime=$(cut -d' ' -f1 /proc/uptime)s"
    # One app process per host connection; its stdio is the RPC stream.
    exec socat VSOCK-LISTEN:5000,reuseaddr,fork \
        EXEC:"/usr/local/bin/agent-init node /app/runtime.mjs"
    ;;
esac
