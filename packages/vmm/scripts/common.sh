# Shared paths and pins for the packages/vmm scripts. Artifacts (builder roots,
# kernels, rootfs images, state disks) live OUTSIDE the repo, so nothing big is
# ever committed. BERTH_VMM_ARTIFACTS overrides the location. Paths must not
# contain spaces.
#
# The scripts run on macOS (a developer machine) and on Linux (CI, an arm64
# runner). Only the *builder* differs; what runs inside it is the same script
# on the same pinned Alpine root either way:
#
#   BERTH_BUILDER=vm      a libkrun builder VM booting a root unpacked from the
#                         pinned minirootfs (the default on macOS)
#   BERTH_BUILDER=docker  a container whose image is that same minirootfs,
#                         `docker import`ed, never pulled from a registry
#                         (the default on Linux)
#
# Both install the toolchain with apk from the same Alpine release, so with the
# same apk package versions they produce the same bytes. The in-builder scripts
# see the same paths either way: inputs at /in or /src (read-only), outputs at
# /out, an empty ext4 scratch volume at /build.
VMM_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_DIR=$(cd "$VMM_DIR/../.." && pwd)
ART=${BERTH_VMM_ARTIFACTS:-$(cd "$REPO_DIR/.." && pwd)/vm-runtime-artifacts}
VMM="$VMM_DIR/target/release/berth-vmm"
CACHE="$ART/cache"

case "$(uname -s)" in
Darwin) BUILDER=${BERTH_BUILDER:-vm} ;;
*) BUILDER=${BERTH_BUILDER:-docker} ;;
esac
case "$BUILDER" in
vm | docker) ;;
*) echo "BERTH_BUILDER=$BUILDER: expected vm or docker" >&2; exit 1 ;;
esac

# The guest architecture: the host's own. Guests are built natively (an
# aarch64 builder on an arm64 host, x86_64 on x86_64), never emulated, and each
# architecture has its own pins: kernel/manifest-<arch>.toml,
# rootfs/manifest-<arch>.toml and the <name>.<arch>.apk.lock package records.
# BERTH_GUEST_ARCH may name the host's architecture explicitly, nothing else.
case "$(uname -m)" in
arm64 | aarch64) HOST_ARCH=aarch64 ;;
x86_64 | amd64) HOST_ARCH=x86_64 ;;
*) HOST_ARCH=$(uname -m) ;;
esac
ARCH=${BERTH_GUEST_ARCH:-$HOST_ARCH}
if [ "$ARCH" != "$HOST_ARCH" ]; then
    echo "BERTH_GUEST_ARCH=$ARCH on a $HOST_ARCH host: guests are built natively, not emulated" >&2
    exit 1
fi
KERNEL_MANIFEST="$VMM_DIR/kernel/manifest-$ARCH.toml"
ROOTFS_MANIFEST="$VMM_DIR/rootfs/manifest-$ARCH.toml"
for m in "$KERNEL_MANIFEST" "$ROOTFS_MANIFEST"; do
    [ -f "$m" ] || { echo "no $ARCH pins: $m is missing" >&2; exit 1; }
done

# arch_lock <dir> [name]: the package record for this architecture,
# <dir>/<name>.<arch>.apk.lock, or <dir>/<arch>.apk.lock without a name.
arch_lock() {
    if [ -n "${2:-}" ]; then echo "$1/$2.$ARCH.apk.lock"; else echo "$1/$ARCH.apk.lock"; fi
}

# manifest_get <file> <key>: value of a flat `key = "value"` or `key = 123` line.
manifest_get() {
    awk -v k="$2" -F' *= *' '$1 == k { v = $2; gsub(/^"|"$/, "", v); print v; exit }' "$1"
}

# Pinned inputs. Every download is checked against its sha256 before use.
ALPINE_VER=$(manifest_get "$ROOTFS_MANIFEST" alpine)
ALPINE_TGZ="$CACHE/alpine-minirootfs-$ALPINE_VER-$ARCH.tar.gz"
ALPINE_SHA256=$(manifest_get "$ROOTFS_MANIFEST" alpine_minirootfs_sha256)
LIBKRUNFW_VER=$(manifest_get "$KERNEL_MANIFEST" libkrunfw_version)
LIBKRUNFW_TGZ="$CACHE/libkrunfw-$LIBKRUNFW_VER.tar.gz"

# Builder VMs (and only they) boot the stock Homebrew libkrunfw kernel, because
# they run with TSI on to reach the Alpine mirror, and TSI needs libkrunfw's
# patches plus dummy0, which the Berth kernel drops.
STOCK_KRUNFW_DIR=/opt/homebrew/opt/libkrunfw/lib

mkdir -p "$ART" "$CACHE"

# --- portable helpers (BSD userland on macOS, GNU or busybox on Linux) -------

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

file_size() {
    # GNU/busybox stat first: BSD stat has no -c and falls through to -f %z.
    stat -c %s "$1" 2>/dev/null || stat -f %z "$1"
}

# sed_inplace <file> <sed args...>: GNU and BSD sed disagree on -i.
sed_inplace() {
    f=$1
    shift
    sed "$@" "$f" > "$f.sed-tmp" && mv "$f.sed-tmp" "$f"
}

min_free_gb() {
    free=$(df -Pk "$ART" | awk 'NR==2 {print int($4 / 1048576)}')
    if [ "$free" -lt "${1:-10}" ]; then
        echo "only ${free} GB free under $ART; refusing to continue (need ${1:-10})" >&2
        exit 1
    fi
}

# fetch <url> <dest> <sha256>: download once into the cache, always verify.
fetch() {
    if [ ! -f "$2" ]; then
        curl -fsSL --retry 3 -o "$2.part" "$1"
        mv "$2.part" "$2"
    fi
    have=$(sha256_of "$2")
    [ "$have" = "$3" ] || { echo "sha256 mismatch for $2: have $have, pinned $3" >&2; exit 1; }
}

fetch_alpine() {
    fetch "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER%.*}/releases/$ARCH/$(basename "$ALPINE_TGZ")" \
        "$ALPINE_TGZ" "$ALPINE_SHA256"
}

# --- builders -----------------------------------------------------------------

# berth-vmm, for builder VMs. Not needed (and not buildable: no libkrun) on a
# Linux CI runner with the docker builder.
build_vmm() {
    [ "$BUILDER" = vm ] || return 0
    (cd "$VMM_DIR" && cargo build --release -q)
    codesign --entitlements "$VMM_DIR/berth-vmm.entitlements" --force -s - "$VMM" 2>/dev/null
}

alpine_tree() { # alpine_tree <dir>: fresh minirootfs at <dir>
    fetch_alpine
    rm -rf "$1" && mkdir -p "$1" && tar -xzf "$ALPINE_TGZ" -C "$1"
    echo "nameserver 1.1.1.1" > "$1/etc/resolv.conf"
}

# builder_vm <root> <cpus> <mem> [berth-vmm args...] -- cmd...
# The only VMs with TSI on and with libkrunfw's bundled (unpinned) kernel.
builder_vm() {
    root=$1 cpus=$2 mem=$3
    shift 3
    DYLD_LIBRARY_PATH="$STOCK_KRUNFW_DIR" "$VMM" --libkrunfw-kernel --tsi --cpus "$cpus" --mem "$mem" \
        --root "$root" "$@" </dev/null
}

# The docker builder image: the pinned minirootfs itself, imported, so the
# container starts from exactly the root a builder VM unpacks. Tagged by the
# tarball's sha256; nothing is pulled from a registry.
builder_image() {
    fetch_alpine
    tag="berth-builder:alpine-$ALPINE_VER-$(echo "$ALPINE_SHA256" | cut -c1-12)"
    docker image inspect "$tag" >/dev/null 2>&1 || docker import "$ALPINE_TGZ" "$tag" >/dev/null
    echo "$tag"
}

# run_builder <name> <cpus> <mem MiB> <scratch GiB> <script> <tag>:<dir>[:ro]...
#
# Runs <script> as `/bin/sh /berth/<basename>` in a pinned Alpine builder, with
# each <dir> at /<tag> and an ext4 scratch volume at /build.
#  - vm: root $ART/builders/<name>, unpacked from the minirootfs on first use
#    and then kept with its apk installs (delete it to start fresh); shares over
#    virtio-fs; scratch a sparse disk image $ART/builders/<name>.scratch.img,
#    deleted afterwards unless KEEP_SCRATCH=1.
#  - docker: `docker run --rm` on the imported minirootfs, fresh every time;
#    bind mounts; scratch a named volume, removed afterwards. The container
#    runs as root, so the writable mounts are handed back to the caller's uid.
run_builder() {
    name=$1 cpus=$2 mem=$3 scratch=$4 script=$5
    shift 5
    base=$(basename "$script")
    rc=0
    case "$BUILDER" in
    vm)
        root="$ART/builders/$name"
        img="$ART/builders/$name.scratch.img"
        [ -d "$root" ] || alpine_tree "$root"
        mkdir -p "$root/berth"
        cp "$script" "$root/berth/$base"
        if [ ! -f "$img" ]; then
            if command -v mkfile >/dev/null 2>&1; then mkfile -n "${scratch}g" "$img"; else truncate -s "${scratch}G" "$img"; fi
        fi
        shares=""
        for s in "$@"; do shares="$shares --share $s"; done
        # shellcheck disable=SC2086 # $shares is a word list by design
        builder_vm "$root" "$cpus" "$mem" --disk build:"$img" $shares -- /bin/sh "/berth/$base" || rc=$?
        [ "${KEEP_SCRATCH:-0}" = 1 ] || rm -f "$img"
        ;;
    docker)
        image=$(builder_image)
        vol="berth-build-$name-$$"
        mounts="" owned=""
        for s in "$@"; do
            tag=${s%%:*} rest=${s#*:}
            case "$rest" in
            *:ro) mounts="$mounts -v ${rest%:ro}:/$tag:ro" ;;
            *) mounts="$mounts -v $rest:/$tag" owned="$owned /$tag" ;;
            esac
        done
        # shellcheck disable=SC2086
        docker run --rm -e JOBS="${JOBS:-}" \
            -v "$vol:/build" -v "$script:/berth/$base:ro" $mounts "$image" \
            /bin/sh -c "/bin/sh /berth/$base; rc=\$?; chown -R $(id -u):$(id -g)$owned; exit \$rc" </dev/null || rc=$?
        docker volume rm -f "$vol" >/dev/null 2>&1 || true
        ;;
    esac
    return "$rc"
}

# compare_lock <lock in the repo> <resolved list>: report where the Alpine
# packages a builder resolved differ from the ones the pinned build used. A
# different toolchain may still produce the same bytes, so this only reports;
# the output hash check is the gate.
compare_lock() {
    [ -f "$1" ] || return 0
    if ! diff -u "$1" "$2" > "$2.diff"; then
        echo "note: the builder resolved different Alpine packages than $1 records:" >&2
        cat "$2.diff" >&2
        [ -z "${GITHUB_ACTIONS:-}" ] || echo "::warning title=Alpine packages moved::$(basename "$1") differs from what the builder resolved; see the log"
    fi
    rm -f "$2.diff"
}
