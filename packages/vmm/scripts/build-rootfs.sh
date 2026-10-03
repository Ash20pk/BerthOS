#!/bin/sh
# Builds the Berth base rootfs as a content-addressed, read-only erofs image,
# in a pinned Alpine builder (scripts/common.sh: a libkrun builder VM on macOS,
# a container on a Linux runner; CI runs this script as is). App directories:
# build-apps.sh.
#
#   $ART/rootfs/rootfs-<sha256>.erofs          the image, named by its sha256
#   $ART/rootfs/rootfs-<sha256>.inputs.json    what went into it
#   $ART/rootfs/rootfs-<sha256>.tree.txt       every path with owner and mode
#   $ART/rootfs/LATEST                         file name of the last build
#
# Image contents: Alpine minirootfs + rootfs/packages.txt (node, e2fsprogs,
# python3 and berth_sdk's dependencies, fuse3), agent-init + probe (build-agent-init.sh), the
# sdk-node tools (bundle-sdk-node.mjs, from rootfs/manifest.toml's
# policy_compiler_commit), berth-init at /sbin/berth-init and
# context-bus-daemon (both from build-berth-init.sh), and the egress broker
# (docker-orchestrator/docker/egress-broker.cjs from this tree, no npm
# dependencies) at /usr/local/bin/berth-egress-broker.cjs, semantic-fs-daemon
# (build-semantic-fs.sh) at /usr/local/bin/semantic-fs-daemon, and berth_sdk
# (packages/sdk-python/berth_sdk at HEAD, sources only) at /opt/berth/sdk-python.
#
# Every input binary is checked against its pin in rootfs/manifest.toml before
# the build, and the image against image_sha256 after it. UPDATE_MANIFEST=1
# rewrites the image pins (and rootfs/apk.lock) for a deliberate change;
# CHECK=0 skips the checks (a scratch build, e.g. with BERTH_INIT=<file>).
#
# The guest init seam: BERTH_INIT=<file> places that file at /sbin/berth-init
# (default: the Rust berth-init from build-berth-init.sh). The pinned kernel
# command line starts it as PID 1. CONTEXT_BUS_DAEMON=<static binary> likewise
# (default: build-berth-init.sh's), and SEMANTIC_FS_DAEMON=<static binary>
# (default: build-semantic-fs.sh's). See docs/design/microvm-runtime.md.
#
# NODE_MODULES_FROM: a checkout with installed node_modules (esbuild, yaml,
# zod), read only. Default: this checkout if it has them, else ~/agentOS. The
# versions are the lockfile's; which ones went in is recorded in the image.
set -eu
. "$(dirname "$0")/common.sh"
min_free_gb 10
build_vmm
umask 022
M="$ROOTFS_MANIFEST"
pin() { manifest_get "$M" "$1"; }
AI="$ART/agent-init"
BI="$ART/berth-init-build/out"
INIT=${BERTH_INIT:-$BI/berth-init}
BUS=${CONTEXT_BUS_DAEMON:-$BI/context-bus-daemon}
SFS=${SEMANTIC_FS_DAEMON:-$ART/semantic-fs-build/out/semantic-fs-daemon}
if [ -n "${NODE_MODULES_FROM:-}" ]; then NM=$NODE_MODULES_FROM
elif [ -d "$REPO_DIR/node_modules" ]; then NM=$REPO_DIR
else NM=$HOME/agentOS; fi
POLICY_REF=${POLICY_REF:-$(pin policy_compiler_commit)}
EPOCH=$(pin source_date_epoch)
CHECK=${CHECK:-1}
[ -f "$AI/agent-init" ] || { echo "run build-agent-init.sh first" >&2; exit 1; }
[ -f "$INIT" ] || { echo "BERTH_INIT=$INIT does not exist (run build-berth-init.sh)" >&2; exit 1; }
[ -f "$BUS" ] || { echo "CONTEXT_BUS_DAEMON=$BUS does not exist (run build-berth-init.sh)" >&2; exit 1; }
[ -f "$SFS" ] || { echo "SEMANTIC_FS_DAEMON=$SFS does not exist (run build-semantic-fs.sh)" >&2; exit 1; }
BROKER="$REPO_DIR/packages/docker-orchestrator/docker/egress-broker.cjs"
GHBROKER="$REPO_DIR/packages/docker-orchestrator/docker/github-api-broker.cjs"

# berth_sdk for runtime: python apps: the committed .py files only (no
# __pycache__, nothing uncommitted), so the tree is a function of HEAD.
SDKPY="$ART/sdk-python-src"
rm -rf "$SDKPY" && mkdir -p "$SDKPY"
git -C "$REPO_DIR" archive --format=tar HEAD packages/sdk-python/berth_sdk | tar -x -C "$SDKPY" --strip-components=2
find "$SDKPY/berth_sdk" -type f ! -name '*.py' -exec rm -f {} +
# One hash for the tree: "<sha256>  <path>" per file, sorted, hashed.
SDKPY_LIST="$ART/sdk-python-src.sha256"
(cd "$SDKPY" && find berth_sdk -type f | LC_ALL=C sort | while read -r f; do echo "$(sha256_of "$f")  $f"; done) > "$SDKPY_LIST"

# The embeddings kit (bundle-embeddings.mjs): transformers as one ES module,
# its WASM runtime and the model, hashed as a tree like berth_sdk above.
EMB="$ART/embeddings-kit"
node "$VMM_DIR/scripts/bundle-embeddings.mjs" "$EMB" "$NM" > "$ART/embeddings-kit.json"
EMB_LIST="$ART/embeddings-kit.sha256"
(cd "$EMB" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | while read -r f; do echo "$(sha256_of "$f")  $f"; done) > "$EMB_LIST"

# The inputs must be the pinned ones before any time goes into an image.
if [ "$CHECK" = 1 ]; then
    bad=0
    for c in "agent_init_sha256 $AI/agent-init" "probe_sha256 $AI/probe" "berth_init_sha256 $INIT" \
        "context_bus_daemon_sha256 $BUS" "semantic_fs_daemon_sha256 $SFS" "egress_broker_sha256 $BROKER" "github_api_broker_sha256 $GHBROKER" "sdk_python_sha256 $SDKPY_LIST" "embeddings_sha256 $EMB_LIST"; do
        key=${c%% *} file=${c#* }
        have=$(sha256_of "$file")
        if [ "$have" != "$(pin "$key")" ]; then
            echo "MISMATCH: $file has sha256 $have, rootfs/manifest.toml $key is $(pin "$key")" >&2
            bad=1
        fi
    done
    [ "$bad" = 0 ] || { echo "(CHECK=0 builds anyway, unpinned)" >&2; exit 1; }
fi

B="$ART/rootfs-build"
rm -rf "$B" && mkdir -p "$B/in/files" "$B/out"
F="$B/in/files"

# Host-side inputs, all into /in (read-only in the builder).
fetch_alpine
ln "$ALPINE_TGZ" "$B/in/alpine-minirootfs.tar.gz"
cp "$VMM_DIR/rootfs/packages.txt" "$B/in/"
: > "$B/in/extra-packages"
echo "$EPOCH" > "$B/in/SOURCE_DATE_EPOCH"
id -u > "$B/in/HOST_UID"

# The policy compiler comes from policy_compiler_commit (feat/per-app-cgroups,
# whose compiler writes the cgroupLimits berth-init applies; main contains it).
mkdir -p "$B/policy-src"
git -C "$REPO_DIR" archive --format=tar "$POLICY_REF" packages/sdk/src packages/manifest-schema/src | tar -x -C "$B/policy-src"
policy_commit=$(git -C "$REPO_DIR" rev-parse "$POLICY_REF^{commit}")
bundled=$(node "$VMM_DIR/scripts/bundle-sdk-node.mjs" "$B/sdk-stage" "$B/bundle" "$B/policy-src" \
    "$NM/packages/sdk/node_modules" "$NM/packages/manifest-schema/node_modules" "$NM/node_modules")
mkdir -p "$F/sbin" "$F/usr/local/bin" "$F/opt/berth/sdk-node" "$F/opt/berth/sdk-python" "$F/etc/berth"
install -m 0755 "$INIT" "$F/sbin/berth-init"
install -m 0755 "$AI/agent-init" "$F/usr/local/bin/agent-init"
install -m 0755 "$AI/probe" "$F/usr/local/bin/berth-probe"
install -m 0755 "$VMM_DIR/guest/net-probe.sh" "$F/usr/local/bin/net-probe"
install -m 0755 "$VMM_DIR/guest/leak-probe.sh" "$F/usr/local/bin/leak-probe"
# berth-init starts it confined (uid 9001) before any app.
install -m 0755 "$BUS" "$F/usr/local/bin/context-bus-daemon"
# berth-init starts it as root, to mount /context (FUSE, through fusermount3).
install -m 0755 "$SFS" "$F/usr/local/bin/semantic-fs-daemon"
install -m 0644 "$B/bundle/generate-capability-policy.mjs" "$B/bundle/run-lifecycle.mjs" "$F/opt/berth/sdk-node/"
# berth-init starts a runtime: python app as python3 -m berth_sdk.runtime with
# PYTHONPATH=/opt/berth/sdk-python, as entrypoint.sh does in a container.
cp -R "$SDKPY/berth_sdk" "$F/opt/berth/sdk-python/"
# Read-only for everyone, under /usr: in every app's baseline read paths.
mkdir -p "$F/usr/share/berth"
cp -R "$EMB" "$F/usr/share/berth/embeddings"
find "$F/usr/share/berth" -type d -exec chmod 0755 {} + && find "$F/usr/share/berth" -type f -exec chmod 0644 {} +
find "$F/opt/berth/sdk-python" -type d -exec chmod 0755 {} + && find "$F/opt/berth/sdk-python" -type f -exec chmod 0644 {} +
# berth-init starts it confined (uid 9002) when one app declares network:host:.
install -m 0644 "$BROKER" "$F/usr/local/bin/berth-egress-broker.cjs"
# berth-init starts it confined (uid 9003) when one app declares github:*.
install -m 0644 "$GHBROKER" "$F/usr/local/bin/berth-github-api-broker.cjs"

sha() { sha256_of "$1"; }
src_rev=$(git -C "$REPO_DIR" rev-parse HEAD)
src_dirty=$(git -C "$REPO_DIR" status --porcelain -- packages/vmm packages/sdk packages/sdk-python/berth_sdk packages/manifest-schema packages/docker-orchestrator/docker/egress-broker.cjs packages/docker-orchestrator/docker/github-api-broker.cjs | grep -q . && echo true || echo false)
# Recorded inside the image too (/etc/berth/build-inputs.json), minus the
# image's own hash, which cannot be inside itself, and minus the git commit,
# so that an unrelated commit does not change the image. The commit is in the
# outer inputs.json.
cat > "$F/etc/berth/build-inputs.json" <<EOF
{
  "schema": 1,
  "alpine": {"version": "$ALPINE_VER", "minirootfsSha256": "$ALPINE_SHA256"},
  "packages": $(sed -e 's/#.*//' "$B/in/packages.txt" "$B/in/extra-packages" | awk 'NF {printf "%s\"%s\"", (n++ ? ", " : "["), $1} END {print "]"}'),
  "agentInit": {"sha256": "$(sha "$AI/agent-init")", "sourceRef": "$(pin agent_init_ref)", "sourceCommit": "$(cat "$AI/agent-init.ref")"},
  "probeSha256": "$(sha "$AI/probe")",
  "berthInit": {"path": "/sbin/berth-init", "source": "$(basename "$INIT")", "sha256": "$(sha "$INIT")"},
  "contextBusDaemon": {"path": "/usr/local/bin/context-bus-daemon", "sha256": "$(sha "$BUS")"},
  "semanticFsDaemon": {"path": "/usr/local/bin/semantic-fs-daemon", "sha256": "$(sha "$SFS")"},
  "egressBroker": {"path": "/usr/local/bin/berth-egress-broker.cjs", "sha256": "$(sha "$BROKER")"},
  "githubApiBroker": {"path": "/usr/local/bin/berth-github-api-broker.cjs", "sha256": "$(sha "$GHBROKER")"},
  "sdkPython": {"path": "/opt/berth/sdk-python/berth_sdk", "treeSha256": "$(sha "$SDKPY_LIST")"},
  "embeddings": {"path": "/usr/share/berth/embeddings", "treeSha256": "$(sha "$EMB_LIST")", "build": $(cat "$ART/embeddings-kit.json")},
  "sdkNode": {
    "sourceRef": "$(pin policy_compiler_ref)", "sourceCommit": "$policy_commit",
    "bundle": $bundled,
    "generate-capability-policy.mjs": "$(sha "$B/bundle/generate-capability-policy.mjs")",
    "run-lifecycle.mjs": "$(sha "$B/bundle/run-lifecycle.mjs")"
  },
  "sourceDateEpoch": $EPOCH,
  "identities": {"berth": 9999, "berth-context-bus": 9001, "berth-egress": 9002, "apps": "berth-<app> = 10000+index, written by the guest init at boot"}
}
EOF

run_builder image "${CPUS:-4}" "${MEM:-2048}" 4 "$VMM_DIR/rootfs/build-in-vm.sh" \
    in:"$B/in":ro out:"$B/out"
compare_lock "$VMM_DIR/rootfs/apk.lock" "$B/out/packages.lock"
compare_lock "$VMM_DIR/rootfs/builder.apk.lock" "$B/out/apk.lock"

h=$(sha "$B/out/rootfs.erofs")
size=$(file_size "$B/out/rootfs.erofs")
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
' "$F/etc/berth/build-inputs.json" "$B/out/packages.lock" "$B/out/mkfs.txt" "$B/out/tree-kib.txt" "$B/out/tree.txt" "$h" "$size" \
    > "$D/rootfs-$h.inputs.json"
cp "$B/out/tree.txt" "$D/rootfs-$h.tree.txt"
cp "$B/out/packages.lock" "$D/rootfs-$h.packages.lock"
cp "$B/out/apk.lock" "$D/rootfs-$h.builder.apk.lock"
echo "$name" > "$D/LATEST"

rm -rf "$B" "$SDKPY" "$EMB"
echo "rootfs $D/$name ($size bytes)"
if [ "${UPDATE_MANIFEST:-0}" = 1 ]; then
    sed_inplace "$M" -e "s/^image_sha256 = .*/image_sha256 = \"$h\"/" -e "s/^image_size = .*/image_size = $size/" \
        -e "s/^sdk_python_sha256 = .*/sdk_python_sha256 = \"$(sha "$SDKPY_LIST")\"/" \
        -e "s/^embeddings_sha256 = .*/embeddings_sha256 = \"$(sha "$EMB_LIST")\"/"
    cp "$D/rootfs-$h.packages.lock" "$VMM_DIR/rootfs/apk.lock"
    cp "$D/rootfs-$h.builder.apk.lock" "$VMM_DIR/rootfs/builder.apk.lock"
    echo "rootfs/manifest.toml updated; rebuild berth-vmm so it embeds the new pin"
elif [ "$CHECK" = 1 ] && [ "$h" != "$(pin image_sha256)" ]; then
    echo "MISMATCH: built   rootfs $h ($size bytes)" >&2
    echo "          pinned  rootfs $(pin image_sha256) ($(pin image_size) bytes, rootfs/manifest.toml)" >&2
    exit 1
elif [ "$CHECK" = 1 ]; then
    echo "matches rootfs/manifest.toml"
fi
