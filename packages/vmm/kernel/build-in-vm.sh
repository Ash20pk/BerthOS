#!/bin/sh
# Runs INSIDE the builder VM (Alpine, stock libkrunfw kernel, TSI on so apk and
# curl work). The first /dev/vdX is a raw disk image that becomes a case-sensitive ext4
# build volume (the kernel tree does not survive a case-insensitive APFS root).
# Output: /out/Image, /out/config, /out/check.txt (on the /out virtio-fs share).
set -eu
JOBS=${JOBS:-$(nproc)}
apk add --no-cache build-base bc flex bison elfutils-dev openssl-dev perl python3 \
    linux-headers xz e2fsprogs patch findutils diffutils curl tar >/dev/null

DEV=${BUILD_DEV:-$(ls /dev/vd[a-z] | head -1)}
mount | grep -q ' /build ' || {
    dumpe2fs -h "$DEV" >/dev/null 2>&1 || mkfs.ext4 -q -F "$DEV"
    mkdir -p /build && mount "$DEV" /build
}
mkdir -p /out /build
mountpoint -q /out || mount -t virtiofs out /out
cd /build
[ -d libkrunfw ] || { mkdir libkrunfw && tar -xzf /out/src/libkrunfw.tar.gz -C libkrunfw --strip-components=1; }
cd libkrunfw

KV=$(sed -n 's/^KERNEL_VERSION = //p' Makefile)
mkdir -p tarballs
[ -f tarballs/$KV.tar.xz ] || curl -fsSL -o tarballs/$KV.tar.xz https://cdn.kernel.org/pub/linux/kernel/v6.x/$KV.tar.xz

# Base config + our delta, then let kconfig resolve dependencies.
cat config-libkrunfw_aarch64 /out/src/berth-kernel.config > config-berth_aarch64
if [ ! -d "$KV" ]; then
    tar xf tarballs/$KV.tar.xz
    for p in $(find patches/ -name "0*.patch" | sort); do patch -s -p1 -d "$KV" < "$p"; done
fi
cp config-berth_aarch64 "$KV/.config"
cd "$KV"
# The builder root is shared with the agent-init build, which installs rustc.
# Kconfig probes for it and records its version in .config, so hide it: the
# kernel has no Rust code in this config, and the output should not depend on
# what else the builder has installed.
KMAKE="make RUSTC=/bin/false"
$KMAKE -s olddefconfig

# Every line in the delta must have survived olddefconfig.
grep -E '^(CONFIG_|# CONFIG_)' /out/src/berth-kernel.config | while read -r line; do
    name=$(echo "$line" | sed -E 's/^# //; s/ is not set$//; s/=.*$//')
    if grep -qxF "$line" .config; then echo "ok   $line"; else echo "MISS $line (have: $(grep -E "^$name=|^# $name is not set" .config || echo absent))"; fi
done | tee /out/check.txt
if grep -q '^MISS' /out/check.txt; then echo "config delta did not apply cleanly" >&2; exit 1; fi

rm -f .version
time $KMAKE -j"$JOBS" KBUILD_BUILD_TIMESTAMP="Mon Sep 21 20:29:27 CEST 2026" KBUILD_BUILD_USER=berth KBUILD_BUILD_HOST=berth-kernel Image >/out/build.log 2>&1 || { tail -40 /out/build.log; exit 1; }
cp arch/arm64/boot/Image /out/Image
cp .config /out/config
ls -l /out/Image
echo "kernel build ok"
