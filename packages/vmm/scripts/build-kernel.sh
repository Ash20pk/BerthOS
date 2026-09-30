#!/bin/sh
# Builds the Berth guest kernel (libkrunfw v5.6.2 + kernel/berth-kernel.config)
# inside a libkrun builder VM, then wraps it into libkrunfw.5.dylib on the host.
# Nothing is installed on the host: the toolchain comes from Alpine's apk inside
# the builder VM (which, alone among the spike VMs, runs with TSI on).
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm

B="$ART/kernel-build"
mkdir -p "$B/out/src" "$ART/kernel/lib"
[ -d "$BUILDER_ROOT" ] || alpine_tree "$BUILDER_ROOT"
# The build script goes into the builder's root (the /out share is only mounted
# by the script itself); the config delta travels over /out.
mkdir -p "$BUILDER_ROOT/berth"
cp "$VMM_DIR/kernel/build-in-vm.sh" "$BUILDER_ROOT/berth/"
cp "$VMM_DIR/kernel/berth-kernel.config" "$B/out/src/"
[ -f "$B/out/src/libkrunfw.tar.gz" ] || curl -fsSL -o "$B/out/src/libkrunfw.tar.gz" \
    "https://codeload.github.com/containers/libkrunfw/tar.gz/refs/tags/v$LIBKRUNFW_VER"
# Sparse; only what the build writes is allocated.
[ -f "$B/build.img" ] || mkfile -n 8g "$B/build.img"

DYLD_LIBRARY_PATH="$STOCK_KRUNFW_DIR" "$VMM" --tsi --cpus "${CPUS:-8}" --mem "${MEM:-6144}" \
    --root "$BUILDER_ROOT" --disk build:"$B/build.img" --share out:"$B/out" \
    -- /bin/sh /berth/build-in-vm.sh </dev/null

# Host side: kernel Image -> kernel.c -> libkrunfw.5.dylib, exactly as
# libkrunfw's Makefile does for OS=Darwin.
S="$B/libkrunfw-src"
rm -rf "$S" && mkdir -p "$S" && tar -xzf "$B/out/src/libkrunfw.tar.gz" -C "$S" --strip-components=1
python3 "$S/bin2cbundle.py" --os Darwin -t Image "$B/out/Image" "$S/kernel.c"
cc -fPIC -DABI_VERSION=5 -shared -o "$ART/kernel/lib/libkrunfw.5.dylib" "$S/kernel.c"
cp "$B/out/Image" "$B/out/config" "$B/out/check.txt" "$ART/kernel/"
rm -rf "$S"
shasum -a 256 "$ART/kernel/Image" "$ART/kernel/config" "$ART/kernel/lib/libkrunfw.5.dylib"
