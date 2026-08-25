#!/usr/bin/env bash
# One-command deploy for the Berth break-out box (BUILD_PLAN M2.3).
#
# The box protects its flags with exactly the enforcement Berth ships, so it is
# only honest to run it where that enforcement is real: a Linux host whose
# kernel has Landlock in its active LSM stack. On such a host this script
# builds the image, boots the box, and serves the public endpoint. On a host
# that cannot enforce, the server refuses to start rather than advertise a
# boundary that is not there (override only on purpose with
# BREAKOUT_ALLOW_UNENFORCED=1).
#
# The host is expected to be DISPOSABLE and to hold nothing else of value: the
# whole premise is handing strangers code execution inside a sandbox on it. Run
# it on a throwaway VM, not your laptop or a shared box.
#
#   BREAKOUT_BIND=0.0.0.0 BREAKOUT_PORT=8099 ./breakout/deploy.sh
#
# Put a TLS-terminating reverse proxy in front for a public deployment; this
# script binds loopback by default so a misconfigured run is not instantly
# exposed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "== Berth break-out box: preflight =="
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — the box needs a Docker daemon whose kernel enforces Landlock." >&2
  exit 1
fi

echo "== Checking enforcement with berth doctor =="
# Non-fatal here (the server does the authoritative check and refuses to serve
# unenforced), but surfaced so an operator sees it before anything boots.
node packages/cli/bin/berth.js doctor || true

echo "== Installing and building =="
pnpm install --frozen-lockfile
pnpm build

echo "== Starting the box server =="
echo "   bind: ${BREAKOUT_BIND:-127.0.0.1}:${BREAKOUT_PORT:-8099}  (set BREAKOUT_BIND=0.0.0.0 to expose)"
exec node breakout/server.mjs
