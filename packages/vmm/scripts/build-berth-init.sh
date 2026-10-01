#!/bin/sh
# Builds berth-init (static aarch64 musl), runs its unit tests, and builds
# context-bus-daemon, all inside a libkrun builder VM with Alpine's rust.
# Nothing is installed on the host and no host rustup target is used.
#
# The builder root is its own (builders/berth-init, a fresh Alpine root on
# first use, like the kernel and image builders). Output: $ART/berth-init-build/out,
# which build-rootfs.sh installs into the image (BERTH_INIT, CONTEXT_BUS_DAEMON).
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
B="$ART/berth-init-build"
ROOT="$BERTH_INIT_BUILDER_ROOT"
mkdir -p "$B/src" "$B/out"
[ -d "$ROOT" ] || alpine_tree "$ROOT"
mkdir -p "$ROOT/berth"
cp "$VMM_DIR/guest/build-berth-init-in-vm.sh" "$ROOT/berth/"
rm -rf "$B/src/berth-init" "$B/src/context-bus-daemon"
mkdir -p "$B/src/berth-init"
# The working tree, not a commit: this is the edit-build-test loop.
(cd "$VMM_DIR/init" && tar -cf - --exclude target .) | tar -xf - -C "$B/src/berth-init"
if [ "${WITH_CONTEXT_BUS:-1}" = 1 ]; then
    git -C "$VMM_DIR/../.." archive --format=tar HEAD packages/context-bus-daemon | tar -x -C "$B/src" --strip-components=1
fi
[ -f "$B/build.img" ] || mkfile -n 4g "$B/build.img"
builder_vm "$ROOT" "${CPUS:-8}" "${MEM:-4096}" \
    --disk build:"$B/build.img" --share src:"$B/src":ro --share out:"$B/out" \
    -- /bin/sh /berth/build-berth-init-in-vm.sh
# The first build resolves the lock file; keep it with the sources.
[ -f "$VMM_DIR/init/Cargo.lock" ] || cp "$B/out/berth-init.Cargo.lock" "$VMM_DIR/init/Cargo.lock"
[ "${KEEP_SCRATCH:-0}" = 1 ] || rm -f "$B/build.img"
ls -l "$B/out"
