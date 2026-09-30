#!/bin/sh
# Builds agent-init (static aarch64 musl) and the enforcement probe inside a
# libkrun builder VM using Alpine's own rust/gcc. No host rustup target.
# AGENT_INIT_REF picks the git ref whose packages/agent-init is built; the
# default carries the io_uring/AF_VSOCK seccomp refusal.
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
REF=${AGENT_INIT_REF:-fix/seccomp-io-uring-vsock}
B="$ART/agent-init-build"
mkdir -p "$B/src" "$B/out"
[ -d "$BUILDER_ROOT" ] || alpine_tree "$BUILDER_ROOT"
mkdir -p "$BUILDER_ROOT/berth"
cp "$VMM_DIR/guest/build-agent-init-in-vm.sh" "$BUILDER_ROOT/berth/"
rm -rf "$B/src/agent-init"
git -C "$VMM_DIR/../.." archive --format=tar "$REF" packages/agent-init | tar -x -C "$B/src" --strip-components=1
git -C "$VMM_DIR" rev-parse "$REF" > "$B/src/agent-init/REF"
cp "$VMM_DIR/guest/probe.c" "$B/src/"
[ -f "$B/build.img" ] || mkfile -n 4g "$B/build.img"
DYLD_LIBRARY_PATH="$STOCK_KRUNFW_DIR" "$VMM" --tsi --cpus "${CPUS:-8}" --mem "${MEM:-4096}" \
    --root "$BUILDER_ROOT" --disk build:"$B/build.img" \
    --share src:"$B/src":ro --share out:"$B/out" \
    -- /bin/sh /berth/build-agent-init-in-vm.sh </dev/null
cp "$B/src/agent-init/REF" "$B/out/agent-init.ref"
ls -l "$B/out"
