#!/bin/sh
# Runs INSIDE the kernel builder VM (a fresh Alpine root used for nothing else,
# stock libkrunfw kernel, TSI on so apk works). Every source input arrives
# already sha256-checked by the host on the read-only /in share:
#   /in/libkrunfw.tar.gz, /in/linux.tar.xz, /in/berth-kernel.config
# The first /dev/vdX is a raw disk image that becomes a case-sensitive ext4
# build volume (the kernel tree does not survive a case-insensitive APFS root).
# Output on /out: Image, config, check.txt, toolchain.txt, build.log.
set -eu
JOBS=${JOBS:-$(nproc)}
apk add --no-cache build-base bc flex bison elfutils-dev openssl-dev perl python3 \
    linux-headers xz e2fsprogs patch findutils diffutils tar >/dev/null

mkdir -p /in /out /build
mountpoint -q /in || mount -t virtiofs -o ro in /in
mountpoint -q /out || mount -t virtiofs out /out
DEV=${BUILD_DEV:-$(ls /dev/vd[a-z] | head -1)}
mountpoint -q /build || {
    dumpe2fs -h "$DEV" >/dev/null 2>&1 || mkfs.ext4 -q -F "$DEV"
    mount "$DEV" /build
}
cd /build
rm -rf libkrunfw && mkdir libkrunfw && tar -xzf /in/libkrunfw.tar.gz -C libkrunfw --strip-components=1
cd libkrunfw
KV=$(sed -n 's/^KERNEL_VERSION = //p' Makefile)
tar xf /in/linux.tar.xz
[ -d "$KV" ] || { echo "linux.tar.xz does not unpack to $KV (libkrunfw's KERNEL_VERSION)" >&2; exit 1; }
for p in $(find patches/ -name "0*.patch" | sort); do patch -s -p1 -d "$KV" < "$p"; done

# Base config + our delta, then let kconfig resolve dependencies.
cat config-libkrunfw_aarch64 /in/berth-kernel.config > "$KV/.config"
cd "$KV"
# Kconfig probes for rustc and records its version in .config. This builder has
# no rustc, and RUSTC=/bin/false keeps it that way even if one appears: the
# config has no Rust code and the output must not depend on the builder's extras.
KMAKE="make RUSTC=/bin/false"
$KMAKE -s olddefconfig

# Every line in the delta must have survived olddefconfig.
grep -E '^(CONFIG_|# CONFIG_)' /in/berth-kernel.config | while read -r line; do
    name=$(echo "$line" | sed -E 's/^# //; s/ is not set$//; s/=.*$//')
    if grep -qxF "$line" .config; then echo "ok   $line"; else echo "MISS $line (have: $(grep -E "^$name=|^# $name is not set" .config || echo absent))"; fi
done > /out/check.txt
if grep -q '^MISS' /out/check.txt; then cat /out/check.txt; echo "config delta did not apply cleanly" >&2; exit 1; fi

{
    echo "builder: alpine $(cat /etc/alpine-release) $(uname -m)"
    gcc --version | head -1
    ld --version | head -1
    apk info -v 2>/dev/null | sort
} > /out/toolchain.txt

# Fixed build metadata: the timestamp, user and host end up in the Image's
# version string, so they are part of what the sha256 pins.
rm -f .version
time $KMAKE -j"$JOBS" KBUILD_BUILD_TIMESTAMP="Mon Sep 21 20:29:27 CEST 2026" \
    KBUILD_BUILD_USER=berth KBUILD_BUILD_HOST=berth-kernel \
    Image >/out/build.log 2>&1 || { tail -40 /out/build.log; exit 1; }
cp arch/arm64/boot/Image /out/Image
cp .config /out/config
ls -l /out/Image
echo "kernel build ok"
