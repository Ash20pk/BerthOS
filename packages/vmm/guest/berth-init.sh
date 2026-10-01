#!/bin/sh
# Guest init (shell stand-in): the single-app half of docker/entrypoint.sh, cut
# down to what apps/notes needs. libkrun's init.krun is PID 1: it mounts /proc,
# /sys and /dev, switches to the read-only rootfs image and execs this file,
# /sbin/berth-init, as root. A Rust init replaces this file at the same path;
# the contract it has to keep is in docs/design/microvm-image.md ("Guest init
# contract").
#
#   BERTH_VM_MODE=rpc      serve the app's stdio RPC on vsock 5000 (app 0)
#   vsock 1024 (control, all modes): a hello line, then line-JSON ops;
#                          {"op":"shutdown"} stops the VM cleanly (state synced),
#                          {"op":"status"} answers with a minimal status.
#                          The port plan is feat/vm-guest-init's: 1024 control,
#                          1025 logs (not served by this stand-in), 5000+i RPC.
#   BERTH_VM_MODE=probe    run the enforcement probe under agent-init and exit
#   BERTH_VM_MODE=inspect  print mounts and file ownership, then exit
#   BERTH_STATE_DEV=/dev/vdX  (set by berth-vmm --state) the per-sandbox state
#                          disk; formatted ext4 on first boot, mounted at /state,
#                          /state/workspace bound onto /workspace
set -eu

# Control-port handler: socat runs one of these per host connection on 1024,
# with the connection as stdin/stdout.
if [ "${1:-}" = ctl ]; then
    echo '{"source":"berth-init","event":"hello","protocol":1,"init":"berth-init.sh"}'
    while IFS= read -r line; do
        case "$line" in
        *'"op"'*'"shutdown"'*)
            echo '{"source":"berth-init","event":"shutting_down"}'
            echo shutdown > /run/berth/ctl.fifo
            exit 0 ;;
        *'"op"'*'"status"'*)
            echo "{\"source\":\"berth-init\",\"event\":\"status\",\"init\":\"berth-init.sh\",\"uptimeS\":$(cut -d' ' -f1 /proc/uptime)}" ;;
        *) echo '{"source":"berth-init","event":"error","error":"unknown op"}' ;;
        esac
    done
    exit 0
fi

log() { echo "[berth:vm-init] $*" >&2; }
up() { cut -d' ' -f1 /proc/uptime; }
log "init start uptime=$(up)s kernel=$(uname -r) root=$(awk '$2 == "/" {print $1 " " $3 " " $4}' /proc/mounts | tail -1)"

export BERTH_BOOT_ID="$(cat /proc/sys/kernel/random/uuid)"
mountpoint -q /sys/kernel/security || mount -t securityfs securityfs /sys/kernel/security 2>/dev/null || true
# favordynmods: each cgroup migration otherwise waits for an RCU grace period
# (feat/vm-guest-init measured 20-30 ms each); retried without on older kernels.
# init.krun mounts cgroup2 itself, with neither option, so remount in that case.
if mountpoint -q /sys/fs/cgroup; then
    mount -o remount,nsdelegate,favordynmods /sys/fs/cgroup 2>/dev/null \
        || mount -o remount,nsdelegate /sys/fs/cgroup 2>/dev/null || true
else
    mount -t cgroup2 -o nsdelegate,favordynmods cgroup2 /sys/fs/cgroup 2>/dev/null \
        || mount -t cgroup2 -o nsdelegate cgroup2 /sys/fs/cgroup
fi
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /run
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /context
mount -t virtiofs -o ro app /app
mkdir -p /run/berth
mkfifo -m 0600 /run/berth/ctl.fifo
socat VSOCK-LISTEN:1024,reuseaddr,fork EXEC:"/bin/sh /sbin/berth-init ctl" &
log "lsm=$(cat /sys/kernel/security/lsm 2>/dev/null || echo none) links=$(ls /sys/class/net | tr '\n' ' ') cgroup2=$(awk '$3 == "cgroup2" {print $4}' /proc/mounts)"

# Single-app mode: app index 0, so uid/gid 10000 (berth-<app>, written below).
APP_UID=10000
APP_GID=10000

# Writable state. With a state disk it survives a reboot of the same sandbox;
# without one it is tmpfs, as in the spike.
if [ -n "${BERTH_STATE_DEV:-}" ]; then
    # ext2/3/4 superblock magic 0xEF53 at byte 1080 (busybox dd/od; Alpine
    # keeps dumpe2fs in e2fsprogs-extra, which the image does not carry).
    magic=$(dd if="$BERTH_STATE_DEV" bs=1 skip=1080 count=2 2>/dev/null | od -An -tx1 | tr -d ' \n')
    if [ "$magic" != "53ef" ]; then
        log "state disk $BERTH_STATE_DEV is blank: formatting ext4"
        # nodiscard: a whole-device discard makes libkrun truncate the image
        # (berth-vmm restores the size on the next boot either way).
        mkfs.ext4 -q -L berth-state -m 0 -E root_owner=0:0,nodiscard "$BERTH_STATE_DEV"
    fi
    mount -t ext4 -o nosuid,nodev "$BERTH_STATE_DEV" /state
    mkdir -p /state/workspace
    chown $APP_UID:$APP_GID /state/workspace
    chmod 0750 /state/workspace
    mount --bind /state/workspace /workspace
    log "state disk $BERTH_STATE_DEV on /state ($(df -k /state | awk 'NR==2 {printf "%d/%d MiB used", $3/1024, $2/1024}')), /workspace persistent"
else
    mount -t tmpfs -o mode=0750,nosuid,nodev tmpfs /workspace
    chown $APP_UID:$APP_GID /workspace
    log "no state disk: /workspace is tmpfs"
fi

POLICY=/run/berth/capability-policy.json
cd /app

# Compile berth.yml into agent-init's policy with the sdk-node bundle baked
# into the image (the same tool entrypoint.sh runs as root).
env -u NODE_OPTIONS -u NODE_PATH BERTH_CAPABILITY_POLICY="$POLICY" \
    node /opt/berth/sdk-node/generate-capability-policy.mjs >&2
APP_NAME=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).appName)" "$POLICY")
chown 0:$APP_GID "$POLICY"
chmod 0640 "$POLICY"
# The app's identity, berth-<app>: the root is read-only, so passwd and group
# are copied to tmpfs, extended, and bound over /etc (as berth-init does).
mkdir -p /run/berth/etc
cp /etc/passwd /etc/group /run/berth/etc/
echo "berth-$APP_NAME:x:$APP_UID:$APP_GID:berth app $APP_NAME:/nonexistent:/sbin/nologin" >> /run/berth/etc/passwd
echo "berth-$APP_NAME:x:$APP_GID:" >> /run/berth/etc/group
sed -i "s/^\(berth:x:9999:.*\)\$/\1,berth-$APP_NAME/" /run/berth/etc/group
mount --bind /run/berth/etc/passwd /etc/passwd
mount --bind /run/berth/etc/group /etc/group
# Per-app run/tmp dirs the compiled baseline grants (entrypoint.sh's provision_app_identity).
for d in /run/berth/$APP_NAME /tmp/$APP_NAME; do mkdir -p "$d"; chown $APP_UID:$APP_GID "$d"; chmod 0700 "$d"; done
log "policy compiled for \"$APP_NAME\" uptime=$(up)s"

# The environment agent-init reads, and what the app sees.
export BERTH_CAPABILITY_POLICY="$POLICY" BERTH_APP_UID=$APP_UID BERTH_APP_GID=$APP_GID \
    BERTH_REQUIRE_ENFORCEMENT="${BERTH_REQUIRE_ENFORCEMENT:-1}" BERTH_APP_NAME="$APP_NAME" BERTH_WORKSPACE_ROOT=/workspace \
    BERTH_APP_ENTRY=/app/dist/index.mjs BERTH_NO_SEMANTIC_FS=1 HOME=/tmp/$APP_NAME \
    TMPDIR=/tmp/$APP_NAME

# Stop: every process but PID 1 and this one, then flush and unmount the state
# disk, then exit (init.krun ends the VM when its child exits).
stop_vm() {
    kill -TERM -1 2>/dev/null || true
    sleep 0.2
    kill -KILL -1 2>/dev/null || true
    sync
    if mountpoint -q /state; then umount /workspace && umount /state && log "state disk unmounted cleanly"; fi
    log "stopped uptime=$(up)s"
    exit 0
}

case "${BERTH_VM_MODE:-rpc}" in
probe)
    log "probe as root, no agent-init (the VM wall alone):"
    /usr/local/bin/berth-probe /tmp | sed 's/^/[probe:root] /' >&2
    log "probe as the app, under agent-init (both walls):"
    /usr/local/bin/agent-init /usr/local/bin/berth-probe /workspace 2>&1 | sed 's/^/[probe:app] /' >&2
    # /etc is on the read-only image, so EROFS answers there before Landlock
    # does. /state (or /tmp without a state disk) is writable by root but not
    # declared: write_declared below is the Landlock denial on a writable fs.
    undeclared=/tmp; mountpoint -q /state && undeclared=/state
    log "probe as the app against undeclared writable $undeclared:"
    /usr/local/bin/agent-init /usr/local/bin/berth-probe $undeclared 2>&1 | grep 'name=write_declared' | sed 's/^/[probe:app-undeclared] /' >&2
    log "probe done"
    stop_vm
    ;;
inspect)
    log "mounts:"
    grep -E ' (/|/app|/state|/workspace|/context) ' /proc/mounts | sed 's/^/[inspect] /' >&2
    log "ownership (uid:gid mode path):"
    for p in / /etc /etc/passwd /usr/bin/node /usr/local/bin/agent-init /sbin/berth-init /opt/berth/sdk-node \
        /app /app/berth.yml /app/runtime.mjs /app/dist/index.mjs /state /state/workspace /workspace /workspace/*; do
        [ -e "$p" ] && stat -c '[inspect] %u:%g %a %n' "$p" >&2
    done
    log "files under /etc, /usr, /opt not owned by root: $(find /etc /usr /opt /sbin /bin /lib -xdev ! -user 0 2>/dev/null | wc -l)"
    getent passwd 10000 9001 | sed 's/^/[inspect] passwd /' >&2
    grep '^berth:' /etc/group | sed 's/^/[inspect] group /' >&2
    stop_vm
    ;;
rpc)
    ( sleep 2; log "guest-mem $(awk '/MemTotal|MemAvailable/ {sub(":", "", $1); printf "%s=%dMiB ", $1, $2/1024}' /proc/meminfo)" ) &
    log "serving $APP_NAME's stdio RPC on vsock:5000, control on vsock:1024 uptime=$(up)s"
    # One app process per host connection; its stdio is the RPC stream.
    socat VSOCK-LISTEN:5000,reuseaddr,fork EXEC:"/usr/local/bin/agent-init node /app/runtime.mjs" &
    # Blocks until the control handler writes a {"op":"shutdown"} into the fifo.
    # A child exiting (SIGCHLD) interrupts the fifo open with EINTR, which ash
    # does not retry, so loop until a line actually arrives.
    until read -r _ 2>/dev/null < /run/berth/ctl.fifo; do :; done
    log "shutdown requested on vsock:1024"
    stop_vm
    ;;
esac
