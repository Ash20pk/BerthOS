#!/bin/sh
# Builds agent-init (static aarch64 musl) and the enforcement probe inside a
# libkrun builder VM using Alpine's own rust/gcc. No host rustup target.
# AGENT_INIT_REF picks the git ref whose packages/agent-init is built; the
# default carries the io_uring/AF_VSOCK seccomp refusal, which main lacks.
# Output: $ART/agent-init/{agent-init,probe,agent-init.ref,toolchain.txt}
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
REF=${AGENT_INIT_REF:-fix/seccomp-io-uring-vsock}
ROOT="$ART/builders/agent-init"
B="$ART/agent-init-build"
O="$ART/agent-init"
rm -rf "$B" && mkdir -p "$B/src" "$O"
[ -d "$ROOT" ] || alpine_tree "$ROOT"
mkdir -p "$ROOT/berth"
cp "$VMM_DIR/guest/build-agent-init-in-vm.sh" "$ROOT/berth/"
git -C "$REPO_DIR" archive --format=tar "$REF" packages/agent-init | tar -x -C "$B/src" --strip-components=1
git -C "$REPO_DIR" rev-parse "$REF^{commit}" > "$B/src/agent-init/REF"
cp "$VMM_DIR/guest/probe.c" "$B/src/"
mkfile -n 4g "$B/build.img"
builder_vm "$ROOT" "${CPUS:-8}" "${MEM:-4096}" \
    --disk build:"$B/build.img" --share src:"$B/src":ro --share out:"$O" \
    -- /bin/sh /berth/build-agent-init-in-vm.sh
cp "$B/src/agent-init/REF" "$O/agent-init.ref"
[ "${KEEP_SCRATCH:-0}" = 1 ] || rm -rf "$B"
chmod 0755 "$O/agent-init" "$O/probe"
shasum -a 256 "$O/agent-init" "$O/probe"
echo "agent-init from $REF ($(cat "$O/agent-init.ref"))"
