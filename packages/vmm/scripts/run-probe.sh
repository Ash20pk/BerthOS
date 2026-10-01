#!/bin/sh
# Boots the notes rootfs in probe mode: compiles the notes policy, runs the
# enforcement probe as root (VM wall only) and as the app under agent-init
# (both walls), prints the console and exits. KRUNFW_DIR=/opt/homebrew/opt/libkrunfw/lib
# runs the same thing on the stock kernel for comparison. Extra arguments are
# passed to the guest as --env K=V (e.g. BERTH_REQUIRE_ENFORCEMENT=0).
set -eu
. "$(dirname "$0")/common.sh"
build_vmm
extra=""
for kv in "$@"; do extra="$extra --env $kv"; done
DYLD_LIBRARY_PATH="${KRUNFW_DIR:-$BERTH_KRUNFW_DIR}" "$VMM" --cpus 2 --mem 512 \
    --root "$ART/rootfs-notes" --root-ro --share app:"$ART/app-notes":ro \
    --env BERTH_VM_MODE=probe $extra -- /sbin/berth-init </dev/null
