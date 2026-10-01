# Shared paths and pins for the packages/vmm scripts. Artifacts (builder roots,
# kernels, rootfs images, state disks) live OUTSIDE the repo, so nothing big is
# ever committed. BERTH_VMM_ARTIFACTS overrides the location.
VMM_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_DIR=$(cd "$VMM_DIR/../.." && pwd)
ART=${BERTH_VMM_ARTIFACTS:-$(cd "$REPO_DIR/.." && pwd)/vm-runtime-artifacts}
VMM="$VMM_DIR/target/release/berth-vmm"
CACHE="$ART/cache"

# Pinned inputs. Every download is checked against its sha256 before use.
ALPINE_VER=3.24.2
ALPINE_TGZ="$CACHE/alpine-minirootfs-$ALPINE_VER-aarch64.tar.gz"
ALPINE_SHA256=9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773
LIBKRUNFW_VER=5.6.2
LIBKRUNFW_TGZ="$CACHE/libkrunfw-$LIBKRUNFW_VER.tar.gz"
LIBKRUNFW_SHA256=df45d649fcbd07a4d0ca03fa836b2f640fdcf9b40187f3eb7023259c6e83d582

# Builder VMs (and only they) boot the stock Homebrew libkrunfw kernel, because
# they run with TSI on to reach the Alpine mirror, and TSI needs libkrunfw's
# patches plus dummy0, which the Berth kernel drops.
STOCK_KRUNFW_DIR=/opt/homebrew/opt/libkrunfw/lib

# Each builder gets its own root, made fresh from the pinned minirootfs, so
# what one build installs can never leak into another's output (the spike's
# shared root put rustc into the kernel's .config).
KERNEL_BUILDER_ROOT="$ART/builders/kernel"
IMAGE_BUILDER_ROOT="$ART/builders/image"
BERTH_INIT_BUILDER_ROOT="$ART/builders/berth-init"

KERNEL_MANIFEST="$VMM_DIR/kernel/manifest.toml"
ROOTFS_MANIFEST="$VMM_DIR/rootfs/manifest.toml"
mkdir -p "$ART" "$CACHE"

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

# fetch <url> <dest> <sha256>: download once into the cache, always verify.
fetch() {
    if [ ! -f "$2" ]; then
        curl -fsSL -o "$2.part" "$1"
        mv "$2.part" "$2"
    fi
    echo "$3  $2" | shasum -a 256 -c - >/dev/null || { echo "sha256 mismatch for $2" >&2; exit 1; }
}

fetch_alpine() {
    fetch "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER%.*}/releases/aarch64/$(basename "$ALPINE_TGZ")" \
        "$ALPINE_TGZ" "$ALPINE_SHA256"
}

alpine_tree() { # alpine_tree <dir>: fresh minirootfs at <dir>
    fetch_alpine
    rm -rf "$1" && mkdir -p "$1" && tar -xzf "$ALPINE_TGZ" -C "$1"
    echo "nameserver 1.1.1.1" > "$1/etc/resolv.conf"
}

# manifest_get <file> <key>: value of a flat `key = "value"` or `key = 123` line.
manifest_get() {
    awk -v k="$2" -F' *= *' '$1 == k { v = $2; gsub(/^"|"$/, "", v); print v; exit }' "$1"
}

# builder_vm <root> <cpus> <mem> [berth-vmm args...] -- cmd...
# The only VMs with TSI on and with libkrunfw's bundled (unpinned) kernel.
builder_vm() {
    root=$1 cpus=$2 mem=$3
    shift 3
    DYLD_LIBRARY_PATH="$STOCK_KRUNFW_DIR" "$VMM" --libkrunfw-kernel --tsi --cpus "$cpus" --mem "$mem" \
        --root "$root" "$@" </dev/null
}
