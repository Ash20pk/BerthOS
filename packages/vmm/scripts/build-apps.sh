#!/bin/sh
# App directories for the microVM: one read-only virtio-fs share per app,
# mounted by berth-init at /app (one app) or /app/<tag> (several). Each is
#   $ART/apps/<app>/berth.yml               the app's manifest (copied)
#   $ART/apps/<app>/dist/index.mjs          the app, @berthos/sdk and zod inlined
#   $ART/apps/<app>/runtime.mjs             @berthos/sdk's resident-app runtime
#   $ART/apps/<app>/proto/context_bus.proto what the runtime's bus client loads
# The image carries no app code; berth-vmm run --app <dir> shares one of these.
#
# APPS (default notes,filesystem,probe=packages/vmm/guest/probe-app,
# http-fetch=examples/resident-apps/http-fetch, the egress e2e's app): "<app>"
# is apps/<app>; "<app>=<dir>" is an app elsewhere in the repo. The probe app
# is the e2e's: it runs the enforcement probe from inside an app sandbox.
# TEST_RESOURCES=1 (default) appends a resources: block to the copied
# berth.yml of notes and filesystem, so per-app cgroup limits have something
# to apply; notes-plain is notes without one (the benchmark app). The repo's
# apps/ are never modified. NODE_MODULES_FROM: a checkout with installed
# node_modules (esbuild, yaml, zod, protobufjs), read only.
set -eu
. "$(dirname "$0")/common.sh"
NM=${NODE_MODULES_FROM:-$HOME/agentOS}
POLICY_REF=${POLICY_REF:-feat/per-app-cgroups}
APPS=${APPS:-notes,filesystem,probe=packages/vmm/guest/probe-app,http-fetch=examples/resident-apps/http-fetch}
REPO="$VMM_DIR/../.."
B="$ART/apps-build"
rm -rf "$B" && mkdir -p "$B/policy-src"
# bundle-apps.mjs also bundles the policy compiler; the image's copy is the
# one berth-init runs, this one is only a by-product.
git -C "$REPO" archive --format=tar "$POLICY_REF" packages/sdk/src packages/manifest-schema/src | tar -x -C "$B/policy-src"
node "$VMM_DIR/scripts/bundle-apps.mjs" "$B/bundle" "$REPO" "$B/policy-src" "$APPS" \
    "$NM/packages/sdk/node_modules" "$NM/packages/manifest-schema/node_modules" \
    "$NM/apps/notes/node_modules" "$NM/node_modules" >/dev/null

resources_for() {
    case "$1" in
    notes) printf 'resources:\n  cpu: 0.5\n  memory_mb: 160\n  pids: 256\n' ;;
    filesystem) printf 'resources:\n  cpu: 1\n  memory_mb: 192\n  pids: 256\n' ;;
    esac
}
for entry in $(echo "$APPS" | tr ',' ' '); do
    app=${entry%%=*}
    src=apps/$app
    [ "$entry" = "$app" ] || src=${entry#*=}
    D="$ART/apps/$app"
    rm -rf "$D" && mkdir -p "$D/dist" "$D/proto"
    cp "$REPO/$src/berth.yml" "$D/berth.yml"
    if [ "${TEST_RESOURCES:-1}" = 1 ] && ! grep -q '^resources:' "$D/berth.yml"; then
        r=$(resources_for "$app")
        [ -z "$r" ] || printf '\n%s\n' "$r" >> "$D/berth.yml"
    fi
    cp "$B/bundle/runtime.mjs" "$D/runtime.mjs"
    cp "$B/bundle/apps/$app.mjs" "$D/dist/index.mjs"
    cp "$REPO/packages/context-bus-daemon/proto/context_bus.proto" "$D/proto/"
done
# The benchmark's like-for-like with the spike: notes with no resources block
# (so no cpu.max throttling its startup).
if [ -d "$ART/apps/notes" ]; then
    rm -rf "$ART/apps/notes-plain" && cp -R "$ART/apps/notes" "$ART/apps/notes-plain"
    cp "$REPO/apps/notes/berth.yml" "$ART/apps/notes-plain/berth.yml"
fi
rm -rf "$B"
du -sh "$ART/apps"/*
