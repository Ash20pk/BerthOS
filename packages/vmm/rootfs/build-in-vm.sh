#!/bin/sh
# Runs INSIDE the image builder (scripts/common.sh run_builder: a libkrun
# builder VM with TSI on so apk works, or a container on a Linux runner; the
# pinned Alpine root either way). Assembles the Berth base rootfs on an ext4 scratch
# volume as guest root, so every file is owned by a real guest uid, and packs
# it into a read-only erofs image.
#   /in  (read-only): alpine-minirootfs.tar.gz, packages.txt, extra-packages,
#                     files/ (the tree overlaid onto the root, see build-rootfs.sh),
#                     SOURCE_DATE_EPOCH, HOST_UID (the uid that owns /in/files)
#   /out: rootfs.erofs, packages.lock, tree.txt, mkfs.txt, apk.lock (the builder's)
#   first /dev/vdX: ext4 scratch volume
set -eu
apk add --no-cache erofs-utils e2fsprogs >/dev/null
mkdir -p /in /out /build
mountpoint -q /in || mount -t virtiofs -o ro in /in
mountpoint -q /out || mount -t virtiofs out /out
# mkfs.erofs's version shapes the image, so the builder's package set is recorded.
apk info -v 2>/dev/null | LC_ALL=C sort > /out/apk.lock
mountpoint -q /build || {
    DEV=${BUILD_DEV:-$(ls /dev/vd[a-z] | head -1)}
    mkfs.ext4 -q -F "$DEV"
    mount "$DEV" /build
}
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
# Package scripts run chrooted into "$R", and where the builder gives that
# root no /dev (a container, unlike the VM), a script's `>/dev/null` creates
# a plain file there. The image's /dev holds no files of its own: the guest
# kernel mounts devtmpfs over it.
find "$R/dev" -mindepth 1 ! -type c ! -type b ! -type d -exec rm -f {} +

# Berth's files (agent-init, berth-init, sdk-node, ...), then identities.
# cp -a keeps modes; the owner it keeps is the host user's (virtio-fs, or a
# bind mount), on the copied files and on the existing directories it lands
# in, so reset every path that came from /in/files to root.
cp -a /in/files/. "$R/"
(cd /in/files && find .) | while read -r p; do chown -h 0:0 "$R/$p"; done
# Static system identities only: group berth (9999) and context-bus-daemon
# (9001), as entrypoint.sh creates them in the container. Per-app users
# (berth-<app>, uid 10000+index) are NOT baked in: the guest init writes them
# at boot onto a tmpfs copy of passwd/group bound over /etc (the root is
# read-only), because context-bus-daemon names peers by those names.
echo "berth:x:9999:berth-context-bus" >> "$R/etc/group"
echo "berth-context-bus:x:9001:" >> "$R/etc/group"
echo "berth-context-bus:x:9001:9001:berth context-bus daemon:/nonexistent:/sbin/nologin" >> "$R/etc/passwd"
echo "berth-context-bus:!::0:::::" >> "$R/etc/shadow"   # "!" = no password login
# Mount points the guest init uses; the image itself is never written.
mkdir -p "$R/app" "$R/workspace" "$R/state" "$R/context"
chmod 0755 "$R/app" "$R/workspace" "$R/state" "$R/context"
: > "$R/etc/resolv.conf"        # no network in a sandbox VM
echo berth > "$R/etc/hostname"
# apk.log carries the wall-clock install time; the image must not.
rm -rf "$R/var/cache/apk"/* "$R/tmp"/* "$R/root/.ash_history" "$R/var/log/apk.log"

# A listing of the tree with owners and modes, for review and diffing.
(cd "$R" && find . | LC_ALL=C sort | while read -r p; do
    stat -c '%u:%g %a %n' "$p"; done) > /out/tree.txt
HOST_UID=$(cat /in/HOST_UID 2>/dev/null || echo 501)
if [ "$HOST_UID" != 0 ] && awk -v u="$HOST_UID" 'index($1, u ":") == 1' /out/tree.txt | grep -q .; then
    echo "host uid $HOST_UID leaked into the tree:" >&2; awk -v u="$HOST_UID" 'index($1, u ":") == 1' /out/tree.txt >&2; exit 1
fi
du -sk "$R" | cut -f1 > /out/tree-kib.txt

# Reproducible erofs: fixed timestamp on every inode, fixed UUID, lz4hc.
rm -f /out/rootfs.erofs
mkfs.erofs --version > /out/mkfs.txt 2>&1 || true
mkfs.erofs -zlz4hc -T"$EPOCH" --all-time -U 6b3a5e2c-0d4f-4c8e-9a1b-be27f1a5e0c1 \
    /out/rootfs.erofs "$R" >> /out/mkfs.txt 2>&1 || { cat /out/mkfs.txt; exit 1; }
ls -l /out/rootfs.erofs
echo "rootfs build ok"
