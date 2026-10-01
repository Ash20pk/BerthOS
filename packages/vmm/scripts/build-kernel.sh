#!/bin/sh
# Builds the pinned Berth guest kernel Image (kernel/manifest.toml) in a pinned
# Alpine builder (scripts/common.sh: a libkrun builder VM on macOS, a container
# on a Linux runner; CI uses this script as is). Nothing is installed on the
# host: sources are downloaded into $ART/cache and sha256-checked here, the
# toolchain comes from Alpine's apk inside a builder used for nothing else.
#
# Output: $ART/kernel/sha256/<image sha256>/{Image,config,check.txt,toolchain.txt,apk.lock}
# (the same layout a download cache would use). Fails if the Image's sha256 is
# not the manifest's image_sha256. UPDATE_MANIFEST=1 rewrites the output pins
# instead, for a deliberate config change. kernel/apk.lock is the builder's
# package set from the last pinned build; a difference is reported, not fatal.
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
M="$KERNEL_MANIFEST"
get() { manifest_get "$M" "$1"; }

LINUX_TXZ="$CACHE/linux-$(get linux_version).tar.xz"
fetch "$(get libkrunfw_tarball)" "$LIBKRUNFW_TGZ" "$(get libkrunfw_tarball_sha256)"
fetch "$(get linux_tarball)" "$LINUX_TXZ" "$(get linux_tarball_sha256)"
delta="$VMM_DIR/kernel/$(get config_delta)"
have=$(sha256_of "$delta")
if [ "$have" != "$(get config_delta_sha256)" ] && [ "${UPDATE_MANIFEST:-0}" != 1 ]; then
    echo "$(get config_delta) sha256 is $have, manifest pins $(get config_delta_sha256)" >&2
    echo "(a deliberate change: rerun with UPDATE_MANIFEST=1)" >&2
    exit 1
fi

B="$ART/kernel-build"
rm -rf "$B/in" "$B/out" && mkdir -p "$B/in" "$B/out"
ln "$LIBKRUNFW_TGZ" "$B/in/libkrunfw.tar.gz"
ln "$LINUX_TXZ" "$B/in/linux.tar.xz"
cp "$delta" "$B/in/berth-kernel.config"
# Scratch: sparse in a VM, only what the build writes is allocated (~2.2 GB at peak).
run_builder kernel "${CPUS:-8}" "${MEM:-4096}" 8 "$VMM_DIR/kernel/build-in-vm.sh" \
    in:"$B/in":ro out:"$B/out"
rm -rf "$B/in"
compare_lock "$VMM_DIR/kernel/apk.lock" "$B/out/apk.lock"

img_sha=$(sha256_of "$B/out/Image")
cfg_sha=$(sha256_of "$B/out/config")
size=$(file_size "$B/out/Image")
D="$ART/kernel/sha256/$img_sha"
mkdir -p "$D"
for f in Image config check.txt toolchain.txt apk.lock; do mv "$B/out/$f" "$D/$f"; done
cp "$M" "$D/manifest.toml"
echo "Image  sha256 $img_sha  ($size bytes)"
echo "config sha256 $cfg_sha"
echo "output $D"

if [ "${UPDATE_MANIFEST:-0}" = 1 ]; then
    sed_inplace "$M" -e "s/^config_delta_sha256 = .*/config_delta_sha256 = \"$have\"/" \
        -e "s/^config_sha256 = .*/config_sha256 = \"$cfg_sha\"/" \
        -e "s/^image_size = .*/image_size = $size/" \
        -e "s/^image_sha256 = .*/image_sha256 = \"$img_sha\"/"
    cp "$D/apk.lock" "$VMM_DIR/kernel/apk.lock"
    echo "manifest updated; rebuild berth-vmm so it embeds the new pin"
elif [ "$img_sha" != "$(get image_sha256)" ] || [ "$cfg_sha" != "$(get config_sha256)" ]; then
    echo "MISMATCH: built   Image $img_sha, config $cfg_sha" >&2
    echo "          pinned  Image $(get image_sha256), config $(get config_sha256) (kernel/manifest.toml)" >&2
    exit 1
else
    echo "matches kernel/manifest.toml"
fi
