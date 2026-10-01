#!/bin/sh
# Goal 1 probe: serve one connection on vsock port 5000 (host connects via the
# mapped unix socket) and echo lines back with a prefix.
echo "guest: listening on vsock:5000"
socat VSOCK-LISTEN:5000 SYSTEM:'while read l; do echo "guest-echo: $l"; done'
echo "guest: done"
