#!/bin/sh
# Stages the browser layer's own files into $1, laid over the root as is:
# playwright-core at /usr/lib/berth/node_modules/playwright-core, the version
# apps/browser-native's lockfile resolves. It reads its own package files at
# run time and doesn't survive being bundled into an app, so the CLI leaves it
# external in a VM bundle and points the import here.
set -eu
OUT=$1
NM=${NODE_MODULES_FROM:?NODE_MODULES_FROM is a checkout with node_modules}
src=$(cd "$NM/apps/browser-native/node_modules/playwright-core" && pwd -P)
mkdir -p "$OUT/usr/lib/berth/node_modules"
cp -R "$src" "$OUT/usr/lib/berth/node_modules/playwright-core"
find "$OUT/usr/lib/berth" -type d -exec chmod 0755 {} +
find "$OUT/usr/lib/berth" -type f -exec chmod 0644 {} +
chmod 0755 "$OUT/usr/lib/berth/node_modules/playwright-core/cli.js"
