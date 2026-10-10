#!/bin/sh
# Builds berth-init (static musl, the host's architecture), runs its unit tests, and builds
# context-bus-daemon, all in a pinned Alpine builder with Alpine's rust
# (scripts/common.sh: a libkrun builder VM on macOS, a container on a Linux
# runner). Nothing is installed on the host and no host rustup target is used.
#
# Sources: packages/vmm/init from the working tree (this is the edit-build-test
# loop) and packages/context-bus-daemon at HEAD. Output: $ART/berth-init-build/out,
# which build-rootfs.sh installs into the image (BERTH_INIT, CONTEXT_BUS_DAEMON).
# Both binaries are checked against rootfs/manifest-<arch>.toml's berth_init_sha256 and
# context_bus_daemon_sha256; UPDATE_MANIFEST=1 rewrites those pins instead (a
# deliberate change), CHECK=0 skips the check.
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
M="$ROOTFS_MANIFEST"
B="$ART/berth-init-build"
rm -rf "$B/src" "$B/out" && mkdir -p "$B/src/berth-init" "$B/out"
(cd "$VMM_DIR/init" && tar -cf - --exclude target .) | tar -xf - -C "$B/src/berth-init"
if [ "${WITH_CONTEXT_BUS:-1}" = 1 ]; then
    git -C "$REPO_DIR" archive --format=tar HEAD packages/context-bus-daemon | tar -x -C "$B/src" --strip-components=1
fi
run_builder berth-init "${CPUS:-8}" "${MEM:-4096}" 4 "$VMM_DIR/guest/build-berth-init-in-vm.sh" \
    src:"$B/src":ro out:"$B/out"
# The first build resolves the lock file; keep it with the sources.
[ -f "$VMM_DIR/init/Cargo.lock" ] || cp "$B/out/berth-init.Cargo.lock" "$VMM_DIR/init/Cargo.lock"
compare_lock "$(arch_lock "$VMM_DIR/guest" berth-init)" "$B/out/apk.lock"
ls -l "$B/out"
bi=$(sha256_of "$B/out/berth-init")
echo "berth-init         $bi"
[ "${WITH_CONTEXT_BUS:-1}" = 1 ] || exit 0
cb=$(sha256_of "$B/out/context-bus-daemon")
echo "context-bus-daemon $cb"
if [ "${UPDATE_MANIFEST:-0}" = 1 ]; then
    sed_inplace "$M" -e "s/^berth_init_sha256 = .*/berth_init_sha256 = \"$bi\"/" \
        -e "s/^context_bus_daemon_sha256 = .*/context_bus_daemon_sha256 = \"$cb\"/"
    cp "$B/out/apk.lock" "$(arch_lock "$VMM_DIR/guest" berth-init)"
    echo "rootfs/manifest-$ARCH.toml updated"
elif [ "${CHECK:-1}" = 1 ]; then
    if [ "$bi" != "$(manifest_get "$M" berth_init_sha256)" ] || [ "$cb" != "$(manifest_get "$M" context_bus_daemon_sha256)" ]; then
        echo "MISMATCH: built   berth-init $bi, context-bus-daemon $cb" >&2
        echo "          pinned  berth-init $(manifest_get "$M" berth_init_sha256), context-bus-daemon $(manifest_get "$M" context_bus_daemon_sha256) (rootfs/manifest-$ARCH.toml)" >&2
        echo "(a deliberate change: UPDATE_MANIFEST=1; a scratch build: CHECK=0)" >&2
        exit 1
    fi
    echo "matches rootfs/manifest-$ARCH.toml"
fi
