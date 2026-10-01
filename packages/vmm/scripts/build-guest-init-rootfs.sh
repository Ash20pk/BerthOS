#!/bin/sh
# Test root filesystem and app directories for berth-init, until the
# read-only image from feat/vm-image lands. It is an APFS clone of the spike's
# rootfs-notes (Alpine + node + agent-init), with:
#   /sbin/berth-init                      this branch's PID 1 (static musl)
#   /sbin/berth-init.sh                   the spike's shell init (probe mode)
#   /usr/local/bin/context-bus-daemon     static musl, built with berth-init
#   /opt/berth/sdk-node/generate-capability-policy.mjs
#                                         bundled from $POLICY_REF (default
#                                         feat/per-app-cgroups, whose compiler
#                                         writes cgroupLimits into the policy)
#   /context                              mount point (a tmpfs at boot)
# and one read-only app directory per app under $GI_ART/apps/<app>:
#   berth.yml, dist/index.mjs, runtime.mjs, proto/context_bus.proto
#
# TEST_RESOURCES=1 (default) appends a `resources:` block to each copied
# berth.yml so the per-app cgroup limits have something to apply. The repo's
# apps/ are never modified.
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
GI_ART=${GI_ART:-$(cd "$VMM_DIR/../../.." && pwd)/vm-guest-init-artifacts}
R="$GI_ART/rootfs"
OUT="$GI_ART/berth-init-build/out"
NM=${NODE_MODULES_FROM:-$HOME/agentOS}
POLICY_REF=${POLICY_REF:-feat/per-app-cgroups}
APPS=${APPS:-notes,filesystem}
REPO="$VMM_DIR/../.."
[ -f "$OUT/berth-init" ] || { echo "run build-berth-init.sh first" >&2; exit 1; }
[ -d "$ART/rootfs-notes" ] || { echo "no spike rootfs at $ART/rootfs-notes (run build-rootfs.sh on spike/libkrun-vm)" >&2; exit 1; }
[ -d "$R" ] || cp -cR "$ART/rootfs-notes" "$R"

install -m 0755 "$OUT/berth-init" "$R/sbin/berth-init"
install -m 0755 "$VMM_DIR/guest/berth-init.sh" "$R/sbin/berth-init.sh"
if [ -f "$OUT/context-bus-daemon" ]; then
    install -m 0755 "$OUT/context-bus-daemon" "$R/usr/local/bin/context-bus-daemon"
else
    rm -f "$R/usr/local/bin/context-bus-daemon"
fi
mkdir -p "$R/context" "$R/workspace" "$R/app"

PSRC="$GI_ART/policy-src"
rm -rf "$PSRC" && mkdir -p "$PSRC"
git -C "$REPO" archive --format=tar "$POLICY_REF" packages/sdk/src packages/manifest-schema/src | tar -x -C "$PSRC"
git -C "$REPO" rev-parse "$POLICY_REF" > "$GI_ART/policy-src.ref"

B="$GI_ART/bundle"
rm -rf "$B"
node "$VMM_DIR/scripts/bundle-apps.mjs" "$B" "$REPO" "$PSRC" "$APPS" \
    "$NM/packages/sdk/node_modules" "$NM/packages/manifest-schema/node_modules" \
    "$NM/apps/notes/node_modules" "$NM/node_modules"
mkdir -p "$R/opt/berth/sdk-node"
install -m 0644 "$B/generate-capability-policy.mjs" "$R/opt/berth/sdk-node/"

resources_for() {
    case "$1" in
    notes) printf 'resources:\n  cpu: 0.5\n  memory_mb: 160\n  pids: 256\n' ;;
    filesystem) printf 'resources:\n  cpu: 1\n  memory_mb: 192\n  pids: 256\n' ;;
    esac
}
for app in $(echo "$APPS" | tr ',' ' '); do
    D="$GI_ART/apps/$app"
    rm -rf "$D" && mkdir -p "$D/dist" "$D/proto"
    cp "$REPO/apps/$app/berth.yml" "$D/berth.yml"
    if [ "${TEST_RESOURCES:-1}" = 1 ] && ! grep -q '^resources:' "$D/berth.yml"; then
        printf '\n' >> "$D/berth.yml"
        resources_for "$app" >> "$D/berth.yml"
    fi
    cp "$B/runtime.mjs" "$D/runtime.mjs"
    cp "$B/apps/$app.mjs" "$D/dist/index.mjs"
    cp "$REPO/packages/context-bus-daemon/proto/context_bus.proto" "$D/proto/"
done
du -sh "$R" "$GI_ART/apps"/*
