#!/bin/sh
# Runs INSIDE the image builder, like build-in-vm.sh. Builds one optional
# layer (docs/design/microvm-layers.md): the pinned base rootfs, extracted,
# plus the layer's packages and files, reduced to what is new or changed
# against the base, packed into a read-only erofs image.
#   /in  (read-only): base.erofs, packages.txt, files/ (overlaid as is),
#                     SOURCE_DATE_EPOCH, UUID, HOST_UID
#   /out: layer.erofs, packages.lock, tree.txt, delta.txt, mkfs.txt, apk.lock
#   first /dev/vdX: ext4 scratch volume
set -eu
apk add --no-cache erofs-utils e2fsprogs tar >/dev/null
mkdir -p /in /out /build
mountpoint -q /in || mount -t virtiofs -o ro in /in
mountpoint -q /out || mount -t virtiofs out /out
apk info -v 2>/dev/null | LC_ALL=C sort > /out/apk.lock
mountpoint -q /build || {
    DEV=${BUILD_DEV:-$(ls /dev/vd[a-z] | head -1)}
    mkfs.ext4 -q -F "$DEV"
    mount "$DEV" /build
}
EPOCH=$(cat /in/SOURCE_DATE_EPOCH)
BASE=/build/base R=/build/root D=/build/delta
rm -rf "$BASE" "$R" "$D" && mkdir -p "$D"

# The base as it is in the image, then a copy to install into.
fsck.erofs --extract="$BASE" /in/base.erofs >/dev/null
cp -a "$BASE" "$R"
cp /etc/resolv.conf "$R/etc/resolv.conf"
PKGS=$(sed -e 's/#.*//' /in/packages.txt | tr -s ' \n' ' ')
apk --root "$R" --keys-dir "$R/etc/apk/keys" --repositories-file "$R/etc/apk/repositories" \
    --no-cache --update-cache add $PKGS >/dev/null
apk --root "$R" info -v 2>/dev/null | LC_ALL=C sort > /out/packages.lock
cp -a "$BASE/etc/resolv.conf" "$R/etc/resolv.conf"
if [ -d /in/files ]; then
    cp -a /in/files/. "$R/"
    (cd /in/files && find .) | while read -r p; do chown -h 0:0 "$R/$p"; done
fi
rm -rf "$R/var/cache/apk"/* "$R/tmp"/* "$R/var/log/apk.log" "$R/root/.ash_history"
find "$R/dev" -mindepth 1 ! -type c ! -type b ! -type d -exec rm -f {} +
# As in the base: nothing setuid or setgid.
suid=$(find "$R" -xdev -type f \( -perm -4000 -o -perm -2000 \))
[ -z "$suid" ] || { echo "setuid/setgid files in the layer:" >&2; echo "$suid" >&2; exit 1; }

# The delta. A layer is laid over the base read-only, with no whiteouts, so
# it may add and change files but never remove one.
(cd "$BASE" && find . | LC_ALL=C sort) > /tmp/base.list
(cd "$R" && find . | LC_ALL=C sort) > /tmp/root.list
gone=$(comm -13 /tmp/root.list /tmp/base.list)
[ -z "$gone" ] || { echo "the layer's packages remove files from the base, which a layer can't express:" >&2; echo "$gone" | head -20 >&2; exit 1; }
meta() { stat -c '%u:%g %a %F' "$1"; }
: > /tmp/changed.list
while read -r p; do
    [ "$p" = . ] && continue
    if [ ! -e "$BASE/$p" ] && [ ! -L "$BASE/$p" ]; then echo "$p"; continue; fi
    [ "$(meta "$R/$p")" = "$(meta "$BASE/$p")" ] || { echo "$p"; continue; }
    if [ -L "$R/$p" ]; then
        [ "$(readlink "$R/$p")" = "$(readlink "$BASE/$p")" ] || echo "$p"
    elif [ -f "$R/$p" ]; then
        cmp -s "$R/$p" "$BASE/$p" || echo "$p"
    fi
done < /tmp/root.list > /tmp/changed.list
# Every directory above a changed path, so the delta keeps their owners and modes.
{
    cat /tmp/changed.list
    while read -r p; do
        d=$(dirname "$p")
        while [ "$d" != . ] && [ "$d" != / ]; do echo "$d"; d=$(dirname "$d"); done
    done < /tmp/changed.list
} | LC_ALL=C sort -u > /out/delta.txt
tar -C "$R" --no-recursion -cf - -T /out/delta.txt | tar -C "$D" -xpf -

(cd "$D" && find . | LC_ALL=C sort | while read -r p; do stat -c '%u:%g %a %n' "$p"; done) > /out/tree.txt
HOST_UID=$(cat /in/HOST_UID 2>/dev/null || echo 501)
if [ "$HOST_UID" != 0 ] && awk -v u="$HOST_UID" 'index($1, u ":") == 1' /out/tree.txt | grep -q .; then
    echo "host uid $HOST_UID leaked into the layer" >&2; exit 1
fi
rm -f /out/layer.erofs
mkfs.erofs --version > /out/mkfs.txt 2>&1 || true
env -u SOURCE_DATE_EPOCH mkfs.erofs -zlz4hc -T"$EPOCH" --all-time -U "$(cat /in/UUID)" \
    /out/layer.erofs "$D" >> /out/mkfs.txt 2>&1 || { cat /out/mkfs.txt; exit 1; }
ls -l /out/layer.erofs
echo "layer build ok: $(wc -l < /out/delta.txt) paths"
