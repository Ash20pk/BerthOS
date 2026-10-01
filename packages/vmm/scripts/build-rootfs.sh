#!/bin/sh
# Builds the Berth base rootfs as a content-addressed, read-only erofs image,
# inside a libkrun builder VM, plus the notes app directory:
#
#   $ART/rootfs/rootfs-<sha256>.erofs          the image, named by its sha256
#   $ART/rootfs/rootfs-<sha256>.inputs.json    what went into it
#   $ART/rootfs/LATEST                         file name of the last build
#   $ART/app-notes/                            berth.yml + bundled app + SDK runtime
#                                              (shared read-only at /app; not in the image)
#
# Image contents: Alpine minirootfs + rootfs/packages.txt (node, socat,
# e2fsprogs; python3 with PYTHON=1), agent-init + probe (build-agent-init.sh),
# the sdk-node tools (from POLICY_REF), the guest init at /sbin/berth-init, and
# optionally CONTEXT_BUS_DAEMON=<static binary>.
#
# The guest init seam: BERTH_INIT=<file> places that file at /sbin/berth-init
# (default guest/berth-init.sh). A static Rust init binary drops in the same
# way; nothing else in the image changes. See docs/design/microvm-image.md for
# the contract it must meet.
#
# NODE_MODULES_FROM points at a checkout with installed node_modules (esbuild,
# yaml, zod), read only; this worktree has none.
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
AI="$ART/agent-init"
INIT=${BERTH_INIT:-$VMM_DIR/guest/berth-init.sh}
NM=${NODE_MODULES_FROM:-$HOME/agentOS}
POLICY_REF=${POLICY_REF:-feat/per-app-cgroups}
EPOCH=$(manifest_get "$ROOTFS_MANIFEST" source_date_epoch)
[ -f "$AI/agent-init" ] || { echo "run build-agent-init.sh first" >&2; exit 1; }
[ -f "$INIT" ] || { echo "BERTH_INIT=$INIT does not exist" >&2; exit 1; }

B="$ART/rootfs-build"
rm -rf "$B" && mkdir -p "$B/in/files" "$B/out" "$B/bundle"
F="$B/in/files"

# Host-side inputs, all into /in (read-only in the builder).
fetch_alpine
ln "$ALPINE_TGZ" "$B/in/alpine-minirootfs.tar.gz"
cp "$VMM_DIR/rootfs/packages.txt" "$B/in/"
if [ "${PYTHON:-0}" = 1 ]; then echo python3 > "$B/in/extra-packages"; else : > "$B/in/extra-packages"; fi
echo "$EPOCH" > "$B/in/SOURCE_DATE_EPOCH"

# The policy compiler comes from POLICY_REF (default feat/per-app-cgroups,
# whose compiler writes the cgroupLimits berth-init applies), not this tree.
mkdir -p "$B/policy-src"
git -C "$REPO_DIR" archive --format=tar "$POLICY_REF" packages/sdk/src packages/manifest-schema/src | tar -x -C "$B/policy-src"
policy_commit=$(git -C "$REPO_DIR" rev-parse "$POLICY_REF^{commit}")
BERTH_POLICY_SRC="$B/policy-src" node "$VMM_DIR/scripts/bundle-notes.mjs" "$B/bundle" \
    "$NM/packages/sdk/node_modules" "$NM/packages/manifest-schema/node_modules" \
    "$NM/apps/notes/node_modules" "$NM/node_modules" >/dev/null
mkdir -p "$F/sbin" "$F/usr/local/bin" "$F/opt/berth/sdk-node" "$F/etc/berth"
install -m 0755 "$INIT" "$F/sbin/berth-init"
install -m 0755 "$AI/agent-init" "$F/usr/local/bin/agent-init"
install -m 0755 "$AI/probe" "$F/usr/local/bin/berth-probe"
install -m 0755 "$VMM_DIR/guest/net-probe.sh" "$F/usr/local/bin/net-probe"
install -m 0755 "$VMM_DIR/guest/leak-probe.sh" "$F/usr/local/bin/leak-probe"
# Optional: a static context-bus-daemon (berth-init starts it confined when
# present; otherwise apps use the SDK's local bus).
[ -z "${CONTEXT_BUS_DAEMON:-}" ] || install -m 0755 "$CONTEXT_BUS_DAEMON" "$F/usr/local/bin/context-bus-daemon"
install -m 0644 "$B/bundle/generate-capability-policy.mjs" "$B/bundle/run-lifecycle.mjs" "$F/opt/berth/sdk-node/"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
src_rev=$(git -C "$REPO_DIR" rev-parse HEAD)
src_dirty=$(git -C "$REPO_DIR" status --porcelain -- packages/vmm packages/sdk packages/manifest-schema | grep -q . && echo true || echo false)
# Recorded inside the image too (/etc/berth/build-inputs.json), minus the
# image's own hash, which cannot be inside itself, and minus the git commit,
# so that an unrelated commit does not change the image. The commit is in the
# outer inputs.json.
cat > "$F/etc/berth/build-inputs.json" <<EOF
{
  "schema": 1,
  "alpine": {"version": "$ALPINE_VER", "minirootfsSha256": "$ALPINE_SHA256"},
  "packages": $(sed -e 's/#.*//' "$B/in/packages.txt" "$B/in/extra-packages" | awk 'NF {printf "%s\"%s\"", (n++ ? ", " : "["), $1} END {print "]"}'),
  "agentInit": {"sha256": "$(sha "$AI/agent-init")", "sourceRef": "${AGENT_INIT_REF:-fix/seccomp-io-uring-vsock}", "sourceCommit": "$(cat "$AI/agent-init.ref")"},
  "probeSha256": "$(sha "$AI/probe")",
  "berthInit": {"path": "/sbin/berth-init", "source": "$(basename "$INIT")", "sha256": "$(sha "$INIT")"},
  "sdkNode": {
    "sourceRef": "$POLICY_REF", "sourceCommit": "$policy_commit",
    "generate-capability-policy.mjs": "$(sha "$B/bundle/generate-capability-policy.mjs")",
    "run-lifecycle.mjs": "$(sha "$B/bundle/run-lifecycle.mjs")"
  },
  "sourceDateEpoch": $EPOCH,
  "identities": {"berth": 9999, "berth-context-bus": 9001, "apps": "berth-<app> = 10000+index, written by the guest init at boot"}
}
EOF

[ -d "$IMAGE_BUILDER_ROOT" ] || alpine_tree "$IMAGE_BUILDER_ROOT"
mkdir -p "$IMAGE_BUILDER_ROOT/berth"
cp "$VMM_DIR/rootfs/build-in-vm.sh" "$IMAGE_BUILDER_ROOT/berth/"
mkfile -n 4g "$B/build.img"
builder_vm "$IMAGE_BUILDER_ROOT" "${CPUS:-4}" "${MEM:-2048}" \
    --disk build:"$B/build.img" --share in:"$B/in":ro --share out:"$B/out" \
    -- /bin/sh /berth/build-in-vm.sh
rm -f "$B/build.img"

h=$(sha "$B/out/rootfs.erofs")
name="rootfs-$h.erofs"
D="$ART/rootfs"
mkdir -p "$D"
mv "$B/out/rootfs.erofs" "$D/$name"
chmod 0444 "$D/$name"
SRC_REV=$src_rev SRC_DIRTY=$src_dirty node -e '
const fs = require("fs");
const [inputs, lock, mkfs, treeKiB, tree, sha, size] = process.argv.slice(1);
const out = {
  image: { sha256: sha, sizeBytes: Number(size), fstype: "erofs", compression: "lz4hc", treeKiB: Number(fs.readFileSync(treeKiB, "utf8")) },
  ...JSON.parse(fs.readFileSync(inputs, "utf8")),
  resolvedPackages: fs.readFileSync(lock, "utf8").trim().split("\n"),
  mkfs: fs.readFileSync(mkfs, "utf8").trim().split("\n")[0],
  sourceCommit: process.env.SRC_REV,
  sourceDirty: process.env.SRC_DIRTY === "true",
  treeListingSha256: require("crypto").createHash("sha256").update(fs.readFileSync(tree)).digest("hex"),
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
' "$F/etc/berth/build-inputs.json" "$B/out/packages.lock" "$B/out/mkfs.txt" "$B/out/tree-kib.txt" "$B/out/tree.txt" "$h" "$(stat -f %z "$D/$name")" \
    > "$D/rootfs-$h.inputs.json"
cp "$B/out/tree.txt" "$D/rootfs-$h.tree.txt"
echo "$name" > "$D/LATEST"

# The app directory, shared read-only into the guest at /app.
APP="$ART/app-notes"
rm -rf "$APP" && mkdir -p "$APP/dist"
cp "$REPO_DIR/apps/notes/berth.yml" "$APP/"
cp "$B/bundle/runtime.mjs" "$APP/runtime.mjs"
cp "$B/bundle/notes.mjs" "$APP/dist/index.mjs"
rm -rf "$B"
echo "rootfs $D/$name ($(stat -f %z "$D/$name") bytes)"
