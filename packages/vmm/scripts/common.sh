# Shared paths for the spike scripts. Artifacts (rootfs trees, disk images,
# kernels) live OUTSIDE the repo so nothing big is ever committed.
VMM_DIR=$(cd "$(dirname "$0")/.." && pwd)
ART=${BERTH_VMM_ARTIFACTS:-$(cd "$VMM_DIR/../../.." && pwd)/libkrun-vm-artifacts}
VMM="$VMM_DIR/target/release/berth-vmm"
ALPINE_VER=3.24.2
ALPINE_TGZ="$ART/alpine-minirootfs-$ALPINE_VER-aarch64.tar.gz"
ALPINE_SHA256=9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773
LIBKRUNFW_VER=5.6.2
STOCK_KRUNFW_DIR=/opt/homebrew/opt/libkrunfw/lib
BERTH_KRUNFW_DIR="$ART/kernel/lib"
mkdir -p "$ART"

min_free_gb() {
    free=$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')
    if [ "$free" -lt "${1:-10}" ]; then
        echo "only ${free} GB free on the data volume; refusing to continue (need ${1:-10})" >&2
        exit 1
    fi
}

build_vmm() {
    (cd "$VMM_DIR" && cargo build --release -q)
    codesign --entitlements "$VMM_DIR/berth-vmm.entitlements" --force -s - "$VMM" 2>/dev/null
}

alpine_tree() { # alpine_tree <dir>: fresh minirootfs at <dir>
    [ -f "$ALPINE_TGZ" ] || curl -fsSL -o "$ALPINE_TGZ" \
        "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER%.*}/releases/aarch64/$(basename "$ALPINE_TGZ")"
    echo "$ALPINE_SHA256  $ALPINE_TGZ" | shasum -a 256 -c - >/dev/null
    rm -rf "$1" && mkdir -p "$1" && tar -xzf "$ALPINE_TGZ" -C "$1"
    echo "nameserver 1.1.1.1" > "$1/etc/resolv.conf"
}

# One Alpine builder root shared by the kernel and agent-init builds (the only
# VMs that run with TSI on). Their scratch volumes are separate disk images.
BUILDER_ROOT="$ART/kernel-build/root"
