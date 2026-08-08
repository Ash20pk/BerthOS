#!/usr/bin/env bash
# Runs every staged app's on_install script as a Docker build layer.
#
# This is the build-time half of REMEDIATION.md 1.5. on_install used to run
# at container boot, from run-lifecycle.ts, as uid 0 with CAP_SYS_ADMIN and
# no Landlock domain applied — before agent-init could apply one, since the
# capability policy is generated in the same script. Running it here instead
# means a berth.yml's shell executes under the builder's isolation, against a
# staged copy, in a layer, rather than inside the sandbox it was meant to be
# constrained by.
#
# One argument: the directory holding the staged app(s). Both targets use the
# same two shapes, which is why one script serves both —
#
#   production   /app                      (single app: .berth/on-install.sh here)
#                /app/apps/<name>          (multi-app, and `berth os up`'s
#                                           forceCompanionLayout)
#   dev          /berth-install-ctx/apps/<name>
#
# A missing script is the normal case (most manifests declare no on_install)
# and is not an error. A *failing* script is: `set -e` here takes the build
# down, so a broken on_install surfaces at build time with the command's own
# output, rather than at boot as a container that exits 1 for reasons nobody
# is told to look for.
set -euo pipefail

BASE="${1:?usage: run-on-install.sh <staged-app-base-dir>}"

run_one() {
  local root="$1"
  local script="$root/.berth/on-install.sh"
  [ -f "$script" ] || return 0
  echo "[berth:build] running on_install for $root" >&2
  # A subshell, so a `cd` inside one app's script can't leak into the next.
  (cd "$root" && bash "$script")
}

run_one "$BASE"

# nullglob: with no apps/ subdirectory the pattern must expand to nothing
# rather than to the literal string, which would then fail the -d test in a
# way that reads like a real error.
shopt -s nullglob
for app_dir in "$BASE"/apps/*/; do
  [ -d "$app_dir" ] || continue
  run_one "${app_dir%/}"
done
