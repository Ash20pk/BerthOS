#!/bin/sh
# Builds an optional layer (docs/design/microvm-layers.md): files added to the
# base rootfs that only some sandboxes need, shipped as their own
# content-addressed erofs image and attached by `berth-vmm run --layer <name>`.
#
#   build-layer.sh <name>
#
# Inputs: rootfs/layers/<name>/packages.txt (apk packages, locked in
# rootfs/layers/<name>/apk.lock), and, if the layer has one,
# rootfs/layers/<name>/stage-files.sh, which fills a directory with files laid
# over the root as is (run with that directory and NODE_MODULES_FROM). The
# base is the pinned rootfs image, $ART/rootfs/rootfs-<image_sha256>.erofs
# (build-rootfs.sh first).
#
# Output: $ART/layers/layer-<name>-<sha256>.erofs, with its .tree.txt (every
# path, owner and mode) and .delta.txt (the paths it adds or changes). A layer
# is built for one base: rootfs/manifest.toml pins it as
#   layer_<name>_sha256, layer_<name>_size, layer_<name>_base
# and berth-vmm refuses it on any other base. UPDATE_MANIFEST=1 rewrites those
# pins (and the apk.lock); CHECK=0 skips the check.
set -eu
. "$(dirname "$0")/common.sh"
NAME=${1:?usage: build-layer.sh <name>}
case "$NAME" in *[!a-z]*) echo "a layer name is lowercase letters" >&2; exit 2 ;; esac
L="$VMM_DIR/rootfs/layers/$NAME"
[ -f "$L/packages.txt" ] || { echo "no layer $NAME ($L/packages.txt)" >&2; exit 2; }
min_free_gb 10
build_vmm
M="$ROOTFS_MANIFEST"
pin() { manifest_get "$M" "$1"; }
BASE=$(pin image_sha256)
BASE_IMG="$ART/rootfs/rootfs-$BASE.erofs"
[ -f "$BASE_IMG" ] || { echo "the base rootfs $BASE_IMG is not built (build-rootfs.sh)" >&2; exit 1; }
if [ -n "${NODE_MODULES_FROM:-}" ]; then NM=$NODE_MODULES_FROM
elif [ -d "$REPO_DIR/node_modules" ]; then NM=$REPO_DIR
else NM=$HOME/agentOS; fi

B="$ART/layer-build-$NAME"
rm -rf "$B" && mkdir -p "$B/in/files" "$B/out"
ln "$BASE_IMG" "$B/in/base.erofs" 2>/dev/null || cp "$BASE_IMG" "$B/in/base.erofs"
cp "$L/packages.txt" "$B/in/"
pin source_date_epoch > "$B/in/SOURCE_DATE_EPOCH"
id -u > "$B/in/HOST_UID"
# A fixed UUID per layer name, so the image depends only on its contents.
printf '%s' "berth-layer-$NAME" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-32 \
    | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/' > "$B/in/UUID"
if [ -f "$L/stage-files.sh" ]; then
    NODE_MODULES_FROM="$NM" sh "$L/stage-files.sh" "$B/in/files"
fi

run_builder "layer-$NAME" "${CPUS:-4}" "${MEM:-2048}" 8 "$VMM_DIR/rootfs/build-layer-in-vm.sh" \
    in:"$B/in":ro out:"$B/out"
compare_lock "$L/apk.lock" "$B/out/packages.lock"

h=$(sha256_of "$B/out/layer.erofs")
size=$(file_size "$B/out/layer.erofs")
D="$ART/layers"
mkdir -p "$D"
mv "$B/out/layer.erofs" "$D/layer-$NAME-$h.erofs"
chmod 0444 "$D/layer-$NAME-$h.erofs"
cp "$B/out/tree.txt" "$D/layer-$NAME-$h.tree.txt"
cp "$B/out/delta.txt" "$D/layer-$NAME-$h.delta.txt"
cp "$B/out/packages.lock" "$D/layer-$NAME-$h.packages.lock"
echo "layer-$NAME-$h.erofs" > "$D/LATEST-$NAME"
rm -rf "$B"
echo "layer $NAME: $D/layer-$NAME-$h.erofs ($size bytes, $(wc -l < "$D/layer-$NAME-$h.delta.txt") paths, base $BASE)"

if [ "${UPDATE_MANIFEST:-0}" = 1 ]; then
    if grep -q "^layer_${NAME}_sha256 = " "$M"; then
        sed_inplace "$M" -e "s/^layer_${NAME}_sha256 = .*/layer_${NAME}_sha256 = \"$h\"/" \
            -e "s/^layer_${NAME}_size = .*/layer_${NAME}_size = $size/" \
            -e "s/^layer_${NAME}_base = .*/layer_${NAME}_base = \"$BASE\"/"
    else
        printf '# Optional layer %s (rootfs/layers/%s, build-layer.sh), built for the base above.\nlayer_%s_sha256 = "%s"\nlayer_%s_size = %s\nlayer_%s_base = "%s"\n' \
            "$NAME" "$NAME" "$NAME" "$h" "$NAME" "$size" "$NAME" "$BASE" >> "$M"
    fi
    cp "$D/layer-$NAME-$h.packages.lock" "$L/apk.lock"
    echo "rootfs/manifest.toml updated; rebuild berth-vmm so it embeds the new pin"
elif [ "${CHECK:-1}" = 1 ]; then
    if [ "$h" != "$(pin "layer_${NAME}_sha256")" ] || [ "$BASE" != "$(pin "layer_${NAME}_base")" ]; then
        echo "MISMATCH: built   layer $NAME $h on base $BASE" >&2
        echo "          pinned  layer $NAME $(pin "layer_${NAME}_sha256") on base $(pin "layer_${NAME}_base") (rootfs/manifest.toml)" >&2
        exit 1
    fi
    echo "matches rootfs/manifest.toml"
fi
