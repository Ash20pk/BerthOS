#!/bin/sh
# Runs once in a TSI-on prep VM to add the guest runtime packages.
set -eu
apk add --no-cache nodejs socat >/dev/null
rm -rf /var/cache/apk/*
node --version
