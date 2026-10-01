#!/bin/sh
# Boots the base rootfs image in probe mode (BERTH_VM_MODE=probe): compiles the
# notes policy, runs the enforcement probe as root (VM wall only) and as the
# app under agent-init (both walls), prints the console and exits.
# MODE=inspect prints mounts and file ownership instead. STATE=<disk> attaches
# a state disk. STOCK=1 boots libkrunfw's stock kernel for comparison. Extra
# arguments go to the guest as --env K=V (e.g. BERTH_REQUIRE_ENFORCEMENT=0).
set -eu
. "$(dirname "$0")/common.sh"
build_vmm
extra=""
for kv in "$@"; do extra="$extra --env $kv"; done
[ -z "${STATE:-}" ] || extra="$extra --state $STATE --state-size ${STATE_SIZE:-256}"
ROOTFS=${ROOTFS:-$ART/rootfs/$(cat "$ART/rootfs/LATEST")}
if [ "${STOCK:-0}" = 1 ]; then
    kernel="--libkrunfw-kernel"
    export DYLD_LIBRARY_PATH="$STOCK_KRUNFW_DIR"
else
    kernel="--kernel ${KERNEL:-$ART/kernel/sha256/$(manifest_get "$KERNEL_MANIFEST" image_sha256)/Image}"
fi
"$VMM" --cpus 2 --mem 512 $kernel --rootfs "$ROOTFS" --share app:"$ART/app-notes":ro \
    --env BERTH_VM_MODE="${MODE:-probe}" $extra -- /sbin/berth-init </dev/null
