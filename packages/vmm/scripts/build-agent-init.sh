#!/bin/sh
# Builds agent-init (static aarch64 musl) and the enforcement probe in a pinned
# Alpine builder (scripts/common.sh: a libkrun builder VM on macOS, a container
# on a Linux runner) using Alpine's own rust/gcc. No host rustup target.
#
# The source is packages/agent-init at rootfs/manifest.toml's agent_init_commit
# (fix/seccomp-io-uring-vsock, which main's history contains), not the working
# tree: the image pins that build. AGENT_INIT_REF overrides it for a deliberate
# change. The output is checked against agent_init_sha256 / probe_sha256 when
# building the pinned commit (CHECK=0 skips that).
# Output: $ART/agent-init/{agent-init,probe,agent-init.ref,toolchain.txt,apk.lock}
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
M="$ROOTFS_MANIFEST"
PINNED=$(manifest_get "$M" agent_init_commit)
REF=${AGENT_INIT_REF:-$PINNED}
B="$ART/agent-init-build"
O="$ART/agent-init"
rm -rf "$B" "$O" && mkdir -p "$B/src" "$O"
git -C "$REPO_DIR" archive --format=tar "$REF" packages/agent-init | tar -x -C "$B/src" --strip-components=1
commit=$(git -C "$REPO_DIR" rev-parse "$REF^{commit}")
echo "$commit" > "$B/src/agent-init/REF"
cp "$VMM_DIR/guest/probe.c" "$B/src/"
run_builder agent-init "${CPUS:-8}" "${MEM:-4096}" 4 "$VMM_DIR/guest/build-agent-init-in-vm.sh" \
    src:"$B/src":ro out:"$O"
echo "$commit" > "$O/agent-init.ref"
rm -rf "$B"
chmod 0755 "$O/agent-init" "$O/probe"
compare_lock "$VMM_DIR/guest/agent-init.apk.lock" "$O/apk.lock"
ai=$(sha256_of "$O/agent-init")
pr=$(sha256_of "$O/probe")
echo "agent-init $ai  (from $REF, $commit)"
echo "probe      $pr"
if [ "$commit" = "$PINNED" ] && [ "${CHECK:-1}" = 1 ]; then
    if [ "$ai" != "$(manifest_get "$M" agent_init_sha256)" ] || [ "$pr" != "$(manifest_get "$M" probe_sha256)" ]; then
        echo "MISMATCH: built   agent-init $ai, probe $pr" >&2
        echo "          pinned  agent-init $(manifest_get "$M" agent_init_sha256), probe $(manifest_get "$M" probe_sha256) (rootfs/manifest.toml)" >&2
        exit 1
    fi
    echo "matches rootfs/manifest.toml"
fi
