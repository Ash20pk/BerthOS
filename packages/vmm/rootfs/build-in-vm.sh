#!/bin/sh
# Runs INSIDE the image builder VM (fresh Alpine root, stock libkrunfw kernel,
# TSI on so apk works). Assembles the Berth base rootfs on an ext4 scratch
# volume as guest root, so every file is owned by a real guest uid, and packs
# it into a read-only erofs image.
#   /in  (read-only): alpine-minirootfs.tar.gz, packages.txt, extra-packages,
#                     files/ (the tree overlaid onto the root, see build-rootfs.sh),
#                     SOURCE_DATE_EPOCH
#   /out: rootfs.erofs, packages.lock, tree.txt, mkfs.txt
#   first /dev/vdX: ext4 scratch volume
set -eu
apk add --no-cache erofs-utils e2fsprogs >/dev/null
mkdir -p /in /out /build
mountpoint -q /in || mount -t virtiofs -o ro in /in
mountpoint -q /out || mount -t virtiofs out /out
DEV=${BUILD_DEV:-$(ls /dev/vd[a-z] | head -1)}
mountpoint -q /build || { mkfs.ext4 -q -F "$DEV"; mount "$DEV" /build; }
EPOCH=$(cat /in/SOURCE_DATE_EPOCH)
export SOURCE_DATE_EPOCH=$EPOCH

R=/build/rootfs
rm -rf "$R" && mkdir -p "$R"
tar -xzf /in/alpine-minirootfs.tar.gz -C "$R"
PKGS=$(sed -e 's/#.*//' /in/packages.txt /in/extra-packages | tr -s ' \n' ' ')
cp /etc/resolv.conf "$R/etc/resolv.conf"
apk --root "$R" --keys-dir "$R/etc/apk/keys" --repositories-file "$R/etc/apk/repositories" \
    --no-cache --update-cache add $PKGS >/dev/null
apk --root "$R" info -v 2>/dev/null | sort > /out/packages.lock

# Berth's files (agent-init, berth-init, sdk-node, ...), then identities.
# cp -a keeps modes; the owner it keeps is the host user's (virtio-fs), on the
# copied files and on the existing directories it lands in, so reset every
# path that came from /in/files to root.
cp -a /in/files/. "$R/"
(cd /in/files && find .) | while read -r p; do chown -h 0:0 "$R/$p"; done
# The shared group and the daemon/app identities entrypoint.sh creates at boot
# in the container. The rootfs is read-only, so they are baked in: per-app
# slots uid/gid 10000+index (index = position in BERTH_APPS, as in Docker),
# context-bus-daemon at 9001, all in group berth (9999).
{
    echo "berth:x:9999:berth-context-bus$(i=0; while [ $i -lt 16 ]; do printf ',berth-app%d' $i; i=$((i+1)); done)"
    echo "berth-context-bus:x:9001:"
    i=0; while [ $i -lt 16 ]; do echo "berth-app$i:x:$((10000+i)):"; i=$((i+1)); done
} >> "$R/etc/group"
{
    echo "berth-context-bus:x:9001:9001:berth context-bus daemon:/nonexistent:/sbin/nologin"
    i=0; while [ $i -lt 16 ]; do echo "berth-app$i:x:$((10000+i)):$((10000+i)):berth app slot $i:/nonexistent:/sbin/nologin"; i=$((i+1)); done
} >> "$R/etc/passwd"
# shadow entries keep busybox tools quiet; "!" = no password login.
{
    echo "berth-context-bus:!::0:::::"
    i=0; while [ $i -lt 16 ]; do echo "berth-app$i:!::0:::::"; i=$((i+1)); done
} >> "$R/etc/shadow"
# Mount points the guest init uses; the image itself is never written.
mkdir -p "$R/app" "$R/workspace" "$R/state"
chmod 0755 "$R/app" "$R/workspace" "$R/state"
: > "$R/etc/resolv.conf"        # no network in a sandbox VM
echo berth > "$R/etc/hostname"
# apk.log carries the wall-clock install time; the image must not.
rm -rf "$R/var/cache/apk"/* "$R/tmp"/* "$R/root/.ash_history" "$R/var/log/apk.log"

# A listing of the tree with owners and modes, for review and diffing.
(cd "$R" && find . | LC_ALL=C sort | while read -r p; do
    stat -c '%u:%g %a %n' "$p"; done) > /out/tree.txt
if awk '$1 ~ /^501:/' /out/tree.txt | grep -q .; then echo "host uid leaked into the tree:" >&2; awk '$1 ~ /^501:/' /out/tree.txt >&2; exit 1; fi
du -sk "$R" | cut -f1 > /out/tree-kib.txt

# Reproducible erofs: fixed timestamp on every inode, fixed UUID, lz4hc.
rm -f /out/rootfs.erofs
mkfs.erofs --version > /out/mkfs.txt 2>&1 || true
mkfs.erofs -zlz4hc -T"$EPOCH" --all-time -U 6b3a5e2c-0d4f-4c8e-9a1b-be27f1a5e0c1 \
    /out/rootfs.erofs "$R" >> /out/mkfs.txt 2>&1 || { cat /out/mkfs.txt; exit 1; }
ls -l /out/rootfs.erofs
echo "rootfs build ok"
