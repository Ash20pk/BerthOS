#!/bin/sh
# Builds semantic-fs-daemon (static, CGO_ENABLED=0) for the guest, and runs its
# Go tests, in a pinned Alpine builder with Alpine's go (scripts/common.sh: a
# libkrun builder VM on macOS, a container on a Linux runner). Nothing is
# installed on the host.
#
# Sources: packages/semantic-fs-daemon at HEAD, the same daemon the Docker
# image runs. Output: $ART/semantic-fs-build/out, which build-rootfs.sh installs
# at /usr/local/bin/semantic-fs-daemon (SEMANTIC_FS_DAEMON). The binary is
# checked against rootfs/manifest.toml's semantic_fs_daemon_sha256;
# UPDATE_MANIFEST=1 rewrites that pin (and guest/semantic-fs.apk.lock) instead,
# CHECK=0 skips the check.
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
M="$ROOTFS_MANIFEST"
B="$ART/semantic-fs-build"
rm -rf "$B/src" "$B/out" && mkdir -p "$B/src" "$B/out"
git -C "$REPO_DIR" archive --format=tar HEAD packages/semantic-fs-daemon | tar -x -C "$B/src" --strip-components=1
run_builder semantic-fs "${CPUS:-8}" "${MEM:-4096}" 4 "$VMM_DIR/guest/build-semantic-fs-in-vm.sh" \
    src:"$B/src":ro out:"$B/out"
compare_lock "$VMM_DIR/guest/semantic-fs.apk.lock" "$B/out/apk.lock"
ls -l "$B/out"
sf=$(sha256_of "$B/out/semantic-fs-daemon")
echo "semantic-fs-daemon $sf"
if [ "${UPDATE_MANIFEST:-0}" = 1 ]; then
    sed_inplace "$M" -e "s/^semantic_fs_daemon_sha256 = .*/semantic_fs_daemon_sha256 = \"$sf\"/"
    cp "$B/out/apk.lock" "$VMM_DIR/guest/semantic-fs.apk.lock"
    echo "rootfs/manifest.toml updated"
elif [ "${CHECK:-1}" = 1 ]; then
    if [ "$sf" != "$(manifest_get "$M" semantic_fs_daemon_sha256)" ]; then
        echo "MISMATCH: built   semantic-fs-daemon $sf" >&2
        echo "          pinned  semantic-fs-daemon $(manifest_get "$M" semantic_fs_daemon_sha256) (rootfs/manifest.toml)" >&2
        echo "(a deliberate change: UPDATE_MANIFEST=1; a scratch build: CHECK=0)" >&2
        exit 1
    fi
    echo "matches rootfs/manifest.toml"
fi
