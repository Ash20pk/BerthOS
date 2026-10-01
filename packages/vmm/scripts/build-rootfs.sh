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
# Image contents: Alpine minirootfs + rootfs/packages.txt (node, e2fsprogs;
# python3 with PYTHON=1), agent-init + probe (build-agent-init.sh), the
# sdk-node tools (from rootfs/manifest.toml's policy_compiler_commit),
# berth-init at /sbin/berth-init and
# context-bus-daemon (both from build-berth-init.sh), and the egress broker
# (docker-orchestrator/docker/egress-broker.cjs from this tree, no npm
# dependencies) at /usr/local/bin/berth-egress-broker.cjs.
#
# Every input binary is checked against its pin in rootfs/manifest.toml before
# the build, and the image against image_sha256 after it. UPDATE_MANIFEST=1
# rewrites the image pins (and rootfs/apk.lock) for a deliberate change;
# CHECK=0 skips the checks (a scratch build, e.g. with BERTH_INIT=<file>).
#
# The guest init seam: BERTH_INIT=<file> places that file at /sbin/berth-init
# (default: the Rust berth-init from build-berth-init.sh). The pinned kernel
# command line starts it as PID 1. CONTEXT_BUS_DAEMON=<static binary> likewise
# (default: build-berth-init.sh's). See docs/design/microvm-runtime.md.
#
# NODE_MODULES_FROM: a checkout with installed node_modules (esbuild, yaml,
# zod), read only. Default: this checkout if it has them, else ~/agentOS.
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
if [ -n "${NODE_MODULES_FROM:-}" ]; then NM=$NODE_MODULES_FROM
elif [ -d "$REPO_DIR/node_modules" ]; then NM=$REPO_DIR
else NM=$HOME/agentOS; fi
POLICY_REF=${POLICY_REF:-$(pin policy_compiler_commit)}
EPOCH=$(pin source_date_epoch)
CHECK=${CHECK:-1}
[ -f "$AI/agent-init" ] || { echo "run build-agent-init.sh first" >&2; exit 1; }
[ -f "$INIT" ] || { echo "BERTH_INIT=$INIT does not exist (run build-berth-init.sh)" >&2; exit 1; }
[ -f "$BUS" ] || { echo "CONTEXT_BUS_DAEMON=$BUS does not exist (run build-berth-init.sh)" >&2; exit 1; }
BROKER="$REPO_DIR/packages/docker-orchestrator/docker/egress-broker.cjs"

# The inputs must be the pinned ones before any time goes into an image.
if [ "$CHECK" = 1 ]; then
    bad=0
    for c in "agent_init_sha256 $AI/agent-init" "probe_sha256 $AI/probe" "berth_init_sha256 $INIT" \
        "context_bus_daemon_sha256 $BUS" "egress_broker_sha256 $BROKER"; do
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
if [ "${PYTHON:-0}" = 1 ]; then echo python3 > "$B/in/extra-packages"; else : > "$B/in/extra-packages"; fi
echo "$EPOCH" > "$B/in/SOURCE_DATE_EPOCH"
id -u > "$B/in/HOST_UID"

# The policy compiler comes from policy_compiler_commit (feat/per-app-cgroups,
# whose compiler writes the cgroupLimits berth-init applies; main contains it).
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
# berth-init starts it confined (uid 9001) before any app.
install -m 0755 "$BUS" "$F/usr/local/bin/context-bus-daemon"
install -m 0644 "$B/bundle/generate-capability-policy.mjs" "$B/bundle/run-lifecycle.mjs" "$F/opt/berth/sdk-node/"
# berth-init starts it confined (uid 9002) when one app declares network:host:.
install -m 0644 "$BROKER" "$F/usr/local/bin/berth-egress-broker.cjs"

sha() { sha256_of "$1"; }
src_rev=$(git -C "$REPO_DIR" rev-parse HEAD)
src_dirty=$(git -C "$REPO_DIR" status --porcelain -- packages/vmm packages/sdk packages/manifest-schema packages/docker-orchestrator/docker/egress-broker.cjs | grep -q . && echo true || echo false)
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
  "egressBroker": {"path": "/usr/local/bin/berth-egress-broker.cjs", "sha256": "$(sha "$BROKER")"},
  "sdkNode": {
    "sourceRef": "$(pin policy_compiler_ref)", "sourceCommit": "$policy_commit",
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

rm -rf "$B"
echo "rootfs $D/$name ($size bytes)"
if [ "${UPDATE_MANIFEST:-0}" = 1 ]; then
    sed_inplace "$M" -e "s/^image_sha256 = .*/image_sha256 = \"$h\"/" -e "s/^image_size = .*/image_size = $size/"
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
