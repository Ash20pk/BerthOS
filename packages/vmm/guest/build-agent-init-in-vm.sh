#!/bin/sh
# Runs INSIDE a builder (scripts/common.sh run_builder: a libkrun builder VM
# with TSI on for apk/crates.io, or a container on a Linux runner; Alpine
# aarch64 from the pinned minirootfs either way).
# Alpine's rustc is natively aarch64-unknown-linux-musl, so this is the musl
# "cross" build without adding a rustup target on the host.
#   /src  (virtio-fs, read-only): agent-init sources + probe.c
#   /out  (virtio-fs): agent-init, probe
#   first /dev/vdX: ext4 scratch volume for cargo's registry and target dir
set -eu
apk add --no-cache rust cargo build-base linux-headers e2fsprogs >/dev/null
rustc --version
mkdir -p /src /out /build
mountpoint -q /src || mount -t virtiofs -o ro src /src
mountpoint -q /out || mount -t virtiofs out /out
mountpoint -q /build || {
    DEV=${BUILD_DEV:-$(ls /dev/vd[a-z] | head -1)}
    dumpe2fs -h "$DEV" >/dev/null 2>&1 || mkfs.ext4 -q -F "$DEV"
    mount "$DEV" /build
}
export CARGO_HOME=/build/cargo CARGO_TARGET_DIR=/build/target
rm -rf /build/agent-init && cp -r /src/agent-init /build/agent-init
cd /build/agent-init
# Static, like the image build: no dependency on the guest's libc. An explicit
# --target keeps RUSTFLAGS off the host-side proc-macro builds.
T=$(rustc -vV | sed -n 's/^host: //p')
RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked --target "$T"
cp /build/target/$T/release/agent-init /out/agent-init
gcc -O2 -static -o /out/probe /src/probe.c
{ rustc --version; cargo --version; gcc --version | head -1; } > /out/toolchain.txt
apk info -v 2>/dev/null | LC_ALL=C sort > /out/apk.lock
file /out/agent-init /out/probe 2>/dev/null || ls -l /out
echo "agent-init build ok"
