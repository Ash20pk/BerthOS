#!/bin/sh
# Runs INSIDE a builder (scripts/common.sh run_builder: a libkrun builder VM
# with TSI on for apk and the Go module proxy, or a container on a Linux
# runner), like build-berth-init-in-vm.sh. Alpine's go is native to the builder's architecture, and
# with CGO_ENABLED=0 the daemon is a static binary with no libc at all.
#   /src  (virtio-fs, read-only): semantic-fs-daemon/
#   /out  (virtio-fs): semantic-fs-daemon, test.log, apk.lock
#   first /dev/vdX: ext4 scratch volume for the module cache and build cache
set -eu
apk add --no-cache go e2fsprogs >/dev/null
go version
mkdir -p /src /out /build
mountpoint -q /src || mount -t virtiofs -o ro src /src
mountpoint -q /out || mount -t virtiofs out /out
mountpoint -q /build || {
    DEV=${BUILD_DEV:-$(ls /dev/vd[a-z] | head -1)}
    dumpe2fs -h "$DEV" >/dev/null 2>&1 || mkfs.ext4 -q -F "$DEV"
    mount "$DEV" /build
}
# Alpine's go, never a downloaded toolchain: a go.mod that asks for a newer Go
# than Alpine ships fails here rather than fetching one.
export GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0
export GOPATH=/build/go GOMODCACHE=/build/go/mod GOCACHE=/build/go/cache

rm -rf /build/semantic-fs-daemon && cp -r /src/semantic-fs-daemon /build/semantic-fs-daemon
cd /build/semantic-fs-daemon
# Modules are checked against go.sum as they are fetched.
go mod download
if go test ./... > /out/test.log 2>&1; then
    echo "semantic-fs-daemon tests ok"; tail -n 5 /out/test.log
else
    echo "semantic-fs-daemon tests FAILED"; cat /out/test.log; exit 1
fi
# No paths, VCS stamp or build id in the binary, so the bytes depend only on
# the sources, go.sum and the Go version.
go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /out/semantic-fs-daemon .
apk info -v 2>/dev/null | LC_ALL=C sort > /out/apk.lock
go version -m /out/semantic-fs-daemon > /out/semantic-fs-daemon.modules.txt
ls -l /out/semantic-fs-daemon
echo "semantic-fs-daemon build ok"
