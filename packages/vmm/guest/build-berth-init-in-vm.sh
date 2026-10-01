#!/bin/sh
# Runs INSIDE a builder (scripts/common.sh run_builder: a libkrun builder VM
# with TSI on for apk/crates.io, or a container on a Linux runner), like
# build-agent-init-in-vm.sh. Alpine's rustc is natively aarch64 musl, so the
# static build needs no rustup target anywhere.
#   /src  (virtio-fs, read-only): berth-init/ and, optionally, context-bus-daemon/
#   /out  (virtio-fs): berth-init, context-bus-daemon, Cargo.lock, test.log, apk.lock
#   first /dev/vdX: ext4 scratch volume for cargo's registry and target dirs
set -eu
apk add --no-cache rust cargo build-base linux-headers e2fsprogs protobuf protobuf-dev >/dev/null
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
T=$(rustc -vV | sed -n 's/^host: //p')

rm -rf /build/berth-init && cp -r /src/berth-init /build/berth-init
cd /build/berth-init
LOCKED=--locked
[ -f Cargo.lock ] || LOCKED=
# Unit tests first (boot plan, cgroup limit writing); the log goes to /out.
if cargo test --release $LOCKED --target "$T" > /out/test.log 2>&1; then
    echo "berth-init tests ok"; tail -n 5 /out/test.log
else
    echo "berth-init tests FAILED"; cat /out/test.log; exit 1
fi
RUSTFLAGS="-C target-feature=+crt-static" cargo build --release $LOCKED --target "$T"
cp /build/target/$T/release/berth-init /out/berth-init
cp Cargo.lock /out/berth-init.Cargo.lock

if [ -d /src/context-bus-daemon ]; then
    rm -rf /build/context-bus-daemon && cp -r /src/context-bus-daemon /build/context-bus-daemon
    cd /build/context-bus-daemon
    RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked --target "$T"
    cp /build/target/$T/release/context-bus-daemon /out/context-bus-daemon
fi
apk info -v 2>/dev/null | LC_ALL=C sort > /out/apk.lock
file /out/berth-init /out/context-bus-daemon 2>/dev/null || ls -l /out
echo "berth-init build ok"
