#!/bin/sh
# Assembles the guest root filesystem and the read-only app directory:
#   $ART/rootfs-notes : Alpine + node + socat + agent-init + probe + berth-init
#   $ART/app-notes    : berth.yml + bundled notes app + bundled SDK runtime
# Needs build-agent-init.sh to have run. NODE_MODULES_FROM points at a checkout
# with installed node_modules (esbuild, yaml, zod), read only.
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
R="$ART/rootfs-notes"
APP="$ART/app-notes"
AI="$ART/agent-init-build/out"
NM=${NODE_MODULES_FROM:-$HOME/agentOS}
[ -f "$AI/agent-init" ] || { echo "run build-agent-init.sh first" >&2; exit 1; }

if [ ! -x "$R/usr/bin/node" ]; then
    alpine_tree "$R"
    mkdir -p "$R/berth" && cp "$VMM_DIR/guest/prep-rootfs-in-vm.sh" "$R/berth/"
    DYLD_LIBRARY_PATH="$STOCK_KRUNFW_DIR" "$VMM" --tsi --cpus 4 --mem 1024 --root "$R" \
        -- /bin/sh /berth/prep-rootfs-in-vm.sh </dev/null
    rm -rf "$R/berth"
    : > "$R/etc/resolv.conf"   # no network in the sandbox VM; nothing to resolve with
fi

grep -q '^notes:' "$R/etc/passwd" || {
    echo "notes:x:10000:10000:berth app:/nonexistent:/sbin/nologin" >> "$R/etc/passwd"
    echo "notes:x:10000:" >> "$R/etc/group"
}
mkdir -p "$R/workspace" "$R/app" "$R/usr/local/bin" "$R/opt/berth/sdk-node"
install -m 0755 "$AI/agent-init" "$R/usr/local/bin/agent-init"
install -m 0755 "$AI/probe" "$R/usr/local/bin/berth-probe"
install -m 0755 "$VMM_DIR/guest/berth-init.sh" "$R/sbin/berth-init"
install -m 0755 "$VMM_DIR/guest/net-probe.sh" "$R/usr/local/bin/net-probe"

B="$ART/notes-bundle"
node "$VMM_DIR/scripts/bundle-notes.mjs" "$B" \
    "$NM/packages/sdk/node_modules" "$NM/packages/manifest-schema/node_modules" \
    "$NM/apps/notes/node_modules" "$NM/node_modules"
install -m 0644 "$B/generate-capability-policy.mjs" "$R/opt/berth/sdk-node/"
rm -rf "$APP" && mkdir -p "$APP/dist"
cp "$VMM_DIR/../../apps/notes/berth.yml" "$APP/"
cp "$B/runtime.mjs" "$APP/runtime.mjs"
cp "$B/notes.mjs" "$APP/dist/index.mjs"
du -sh "$R" "$APP"
