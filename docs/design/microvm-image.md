# microVM image: pinned kernel, content-addressed rootfs, per-sandbox state

Date: 2026-10-01. Branch `feat/vm-image`, stacked on `spike/libkrun-vm` (65fe6bf). Machine: Apple M4, 16 GB, macOS 27.0, HVF, libkrun 1.19.6.

This follows the libkrun spike (`docs/design/microvm-spike.md`). The spike booted notes from a host directory over virtio-fs and loaded the kernel by putting a rebuilt `libkrunfw.5.dylib` on `DYLD_LIBRARY_PATH`. This branch replaces both:

- **The kernel** is a pinned raw `Image`. `berth-vmm` compiles in `kernel/manifest.toml` and boots a kernel through `krun_set_kernel` only if the file's sha256 matches the pin.
- **The root filesystem** is a read-only erofs image. It is named by its sha256, built reproducibly in a builder VM, and every file in it has a real guest owner.
- **Writable state** lives on a small per-sandbox ext4 disk. `/workspace` survives a reboot of the same sandbox.

Artifacts live in `/Users/ash/berth-wt/vm-image-artifacts/` (`$ART`). Nothing big is committed.

## Results

| Goal | Result | Evidence |
|---|---|---|
| 1. Pinned kernel, raw Image, sha256-verified, measured | **Pass** | A fresh, rust-free builder root rebuilt `Image` with sha256 `8f79e8da…` (the spike's hash). `berth-vmm --kernel` boots it, refuses a one-byte-modified copy, and prints the hash in a `measurements` line |
| 2. Content-addressed read-only rootfs + per-sandbox state disk | **Pass** | `rootfs-42b32ced….erofs` (46.4 MB), built 3+ times with the same hash, mounted `/dev/vda erofs ro`. It is all root-owned, with baked-in uids. The state disk is `/dev/vdb` ext4, created sparse, formatted on first boot |
| 3. End to end | **Pass** | Boot 1: `add_note`, then a graceful stop. Boot 2: `list_notes` returns the note. `ruleset=FullyEnforced`. Ownership was checked (table below). Boot times are below; the host was under load from other work |
| 4. Docs | This file | |

python3 is **not** in the base image. It adds 20.8 MB to the image (+45%) and 41 MB to the tree. `PYTHON=1 ./scripts/build-rootfs.sh` builds that variant (67.2 MB image, reproducible).

## How to build and run

```sh
cd packages/vmm
./scripts/build-kernel.sh       # ~5 to 9 min, 8 vCPU builder VM, ~2.2 GB scratch at peak (deleted after)
./scripts/build-agent-init.sh   # ~30 s
./scripts/build-rootfs.sh       # ~7 s after the first apk download; PYTHON=1 adds python3
./scripts/run-probe.sh                          # enforcement probe on the image
MODE=inspect STATE=$ART/state/x.img ./scripts/run-probe.sh   # mounts + ownership

STATE=$ART/state/notes.img ACTIONS=add  node scripts/boot-notes.mjs   # boot 1: add, graceful stop
STATE=$ART/state/notes.img ACTIONS=list node scripts/boot-notes.mjs   # boot 2: list
STATE=$ART/state/notes.img RUNS=6 node scripts/boot-notes.mjs         # first + 5 repeats
```

Each build script checks for 10 GB free before it starts. Builder VMs are the only VMs that run with TSI on, and the only ones that use libkrunfw's bundled kernel (`--libkrunfw-kernel`, through `DYLD_LIBRARY_PATH`). A sandbox never does either.

## 1. The kernel

### What is pinned

`packages/vmm/kernel/manifest.toml`:

| Key | Value |
|---|---|
| `linux_version` | 6.12.109 (`linux_tarball_sha256` `5484e552…e3fa`, from kernel.org's `sha256sums.asc`) |
| `libkrunfw_version` | 5.6.2 (`libkrunfw_tarball_sha256` `df45d649…d582`, the GitHub tag tarball): base config `config-libkrunfw_aarch64` + its 36 patches |
| `config_delta` | `kernel/berth-kernel.config`, `config_delta_sha256` `ac5c0c4e…39b8` |
| `config_sha256` | `e3f33c2bd4bffa16e52a066c325967e4bde091f20063e6eb5b81e8a2efac4dc8` (resolved `.config`) |
| `image_sha256` | **`8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8`** (23,668,744 bytes, `raw`) |
| `cmdline` | `reboot=k panic=-1 panic_print=0 nomodule console=hvc0 rootfstype=virtiofs rw quiet no-kvmapf init=/init.krun` |
| builder | Alpine 3.24.2 minirootfs (`9bf70a7f…`), gcc (Alpine 15.2.0), GNU ld 2.45.1, build timestamp fixed |

The config delta is the spike's, plus three assertions the rootfs depends on (`VIRTIO_BLK`, `EROFS_FS`, `EROFS_FS_ZIP`). All three were already on, so the Image did not change.

### Build (`scripts/build-kernel.sh`, `kernel/build-in-vm.sh`)

1. The host downloads the linux and libkrunfw tarballs into `$ART/cache` and checks both against the manifest. It also checks the config delta's sha256. A changed delta stops the build unless `UPDATE_MANIFEST=1` is set, which rewrites the output pins.
2. A builder VM boots a fresh Alpine root used only for kernel builds. The spike shared one root with the agent-init build, and its rustc leaked into `.config`. The sources reach the VM on a read-only `/in` share. The VM installs the toolchain with apk, untars, patches, merges the config, checks every delta line survived `olddefconfig`, and builds `Image` with `RUSTC=/bin/false` and a fixed timestamp, user and host. It writes `toolchain.txt` (gcc, ld, and every apk package with its version).
3. The host hashes the output and moves it to **`$ART/kernel/sha256/<sha256>/{Image,config,check.txt,toolchain.txt,manifest.toml}`**, the layout a download cache would use. The build fails if the hash is not `image_sha256`.

**Reproducibility:** the Image built in this fresh root has the same hash as the three spike builds from the shared root, `8f79e8da…`. agent-init, built in its own new root, is also bit-identical to the spike's binary (`9ec8b25e…`).

The libkrunfw dylib wrapping (`bin2cbundle.py` + `cc`) is gone. Nothing boots the kernel that way any more.

### How berth-vmm uses it

- `include_str!("../kernel/manifest.toml")` puts the pin inside the binary. Changing the kernel means changing the manifest and rebuilding `berth-vmm`, which is what we want: the launcher and its kernel are versioned together.
- `--kernel <path>`: berth-vmm hashes the file and refuses on a mismatch, with exit 2 before libkrun is touched:
  `berth-vmm: kernel …/Image.bad has sha256 b4417e61…, but this berth-vmm is pinned to 8f79e8da… (linux 6.12.109, kernel/manifest.toml); refusing to boot it`
- The format and **command line come from the manifest**, and `--cmdline`/`--kernel-format` are gone. A caller-supplied `lsm=` would turn Landlock off, and `init=` would replace the guest init, so neither is the caller's to choose. A unit test asserts that the pinned cmdline has no `lsm=`.
- With no `--kernel`, berth-vmm refuses to start unless `--libkrunfw-kernel` is passed explicitly (builders).
- Hashing the 23.7 MB Image takes **11 to 17 ms** (CommonCrypto). SHA-256 is CommonCrypto on macOS, with a portable implementation elsewhere. Both are tested against the FIPS vectors, and the crate still has no dependencies.

### The measurement line (for attestation)

Every boot prints one JSON line on stderr before the VM starts:

```json
{"source":"berth-vmm","event":"measurements",
 "kernel":{"sha256":"8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8","pinned":true,"linux":"6.12.109",
           "configSha256":"e3f33c2b…","cmdline":"reboot=k … init=/init.krun","hashMs":12},
 "rootfs":{"sha256":"42b32ced43f8d431d21106b90182238b5cf6ed10e87ec8f52492420d72d1bdd3","fstype":"erofs","readOnly":true,"hashMs":22},
 "state":{"path":"…/state/notes.img","sizeBytes":268435456,"created":false,"restoredBytes":65536}}
```

`kernel: null` (a builder on libkrunfw) or `rootfs: null` (a virtio-fs root) means "not pinned", and attestation must report it as such. The line is not signed yet: the host prints it, and a later step signs it or feeds it to the attestation record.

### Distribution (planned, not built)

Users should never build the kernel. The plan:

- **Artifact keyed by hash:** `https://<artifact host>/kernel/sha256/<image_sha256>/{Image,config,manifest.toml,toolchain.txt}`. The manifest's `dist_url` holds a placeholder host. One directory per arch (`aarch64` now, `x86_64` with the same pipeline on `config-libkrunfw_x86_64`).
- **Fetch:** the CLI (or `berth-vmm fetch-kernel`) reads the pin compiled into berth-vmm, downloads into `~/.berth/kernels/sha256/<hash>/Image`, verifies the sha256 and moves the file into place. The cache is content-addressed, so it is safe to share across Berth versions. Every boot re-verifies anyway (~15 ms).
- **Integrity:** the sha256 pin is the root of trust, and it is compiled into a binary the user already trusts. Signing (minisign or Sigstore) on the release side adds provenance on top. It is not a substitute for the pin.
- **GPL:** publish the exact sources next to the Image: the linux tarball hash, the libkrunfw tag and patches, `berth-kernel.config`, the resolved `config`, and the build script.
- **CI:** the same `build-in-vm.sh` runs on an arm64 Linux runner (in a container or a libkrun VM). A second, independent build that reproduces `image_sha256` is the release gate.

## 2. The root filesystem

### Image

`$ART/rootfs/rootfs-42b32ced43f8d431d21106b90182238b5cf6ed10e87ec8f52492420d72d1bdd3.erofs`: **46,362,624 bytes**, erofs with lz4hc, built from an 82.5 MB tree.

| Content | Source |
|---|---|
| Alpine 3.24.2 minirootfs | official tarball, sha256-pinned |
| `nodejs` 24.18.1-r0, `socat` 1.8.1.3-r0, `e2fsprogs` 1.47.4-r0 (+ deps, 40 packages total, busybox 1.37.0-r31) | `rootfs/packages.txt`; exact versions in `inputs.json` and the image's own apk db |
| `/usr/local/bin/agent-init` (static-pie musl, `9ec8b25e…`), `/usr/local/bin/berth-probe` | `fix/seccomp-io-uring-vsock` @ c558ef8, built by `build-agent-init.sh` as the spike did. We use this branch, not `main`, because `main` lacks the io_uring/AF_VSOCK seccomp refusal |
| `/opt/berth/sdk-node/{generate-capability-policy,run-lifecycle}.mjs` | the sdk-node bundles (`bundle-daemons.mjs`'s esbuild options), from this worktree's `packages/sdk` |
| `/sbin/berth-init` | `guest/berth-init.sh`, the init seam (below) |
| `/usr/local/bin/{net-probe,leak-probe}` | spike probes |
| `/etc/passwd`, `/etc/group`, `/etc/shadow` | group `berth` 9999; `berth-context-bus` 9001; **`berth-app0`…`berth-app15` = uid/gid 10000…10015**, members of `berth` |
| `/etc/berth/build-inputs.json` | the input record, minus the image's own hash and the git commit |
| `/app`, `/workspace`, `/state` | empty mount points, root 0755 |

The identities are baked in, because a read-only root cannot `adduser` at boot the way `entrypoint.sh` does. The numbering rule is unchanged: uid = 10000 + the app's index in `BERTH_APPS`, and single-app mode is index 0. The names are slots (`berth-app0`), not `berth-<app>`. Nothing in the VM path looks them up by name. The Docker path's `getent group berth-<target>` (app:invoke peer dirs) would have to map by index there. 16 slots is a fixed limit, which is easy to raise.

### Build (`scripts/build-rootfs.sh`, `rootfs/build-in-vm.sh`)

1. On the host: fetch and check the minirootfs, bundle the sdk-node tools and notes with esbuild, and stage `/in`: the tarball, `packages.txt`, `SOURCE_DATE_EPOCH` (from `rootfs/manifest.toml`), and a `files/` overlay tree.
2. In a builder VM (its own fresh Alpine root, TSI on, 4 vCPU): untar onto an ext4 scratch disk **as guest root**, `apk --root … add`, overlay `files/` and chown every overlaid path to 0:0, then append the identities and empty `resolv.conf`. Drop `/var/cache/apk` and `/var/log/apk.log`. List every path with `uid:gid mode` and **fail if uid 501 appears**. Then `mkfs.erofs -zlz4hc -T$EPOCH --all-time -U <fixed uuid>` (erofs-utils 1.9).
3. On the host: name the file `rootfs-<sha256>.erofs` (mode 0444) and write `rootfs-<sha256>.inputs.json` next to it, with the image hash and size, packages requested and resolved, the agent-init hash, source ref and commit, the berth-init and sdk-node hashes, the mkfs version, the tree listing hash, and the source commit and dirty flag. Also write `rootfs-<sha256>.tree.txt` (the ownership listing) and `LATEST`.

**Reproducibility.** Two leaks of build time had to go: `/var/log/apk.log` (it carries a wall-clock line) and the git commit, which is now only in the outer `inputs.json`, since inside the image it would change the hash on every unrelated commit. After that, rebuilds gave the same hash every time: three in a row of one tree (`30eb84a4…`), and the final image `42b32ced…` from a dirty and then a clean tree. Every build formats a new scratch disk, so ext4 directory order does not leak in either. The limit is that apk resolves the newest package versions in v3.24, so a rebuild next month may differ. Content addressing makes that visible (a new hash, a diffable `inputs.json`) rather than silent. Bit-exact rebuilds of an old image need a pinned apk package cache (open item).

### How berth-vmm boots it

- `--rootfs IMG`: the expected hash comes from the file name (`<name>-<sha256>.<ext>`), or from `--rootfs-sha256`. A name without a hash is refused. berth-vmm probes the fstype once from the superblock magic (erofs or ext4), while the image is still trusted. It hashes the file (18 to 38 ms for 46 MB) and refuses a mismatch. Then `krun_add_disk(read_only=true)` makes it `/dev/vda`, and `krun_set_root_disk_remount("/dev/vda", "erofs", "ro")`: libkrun boots init.krun from its internal dummy virtio-fs root, then mounts the image and switches to it. The guest shows `/dev/vda / erofs ro,relatime,user_xattr,acl,cache_strategy=readaround`.
- The image is shared by every sandbox, so it must be immutable from inside any of them. Three layers protect it: the guest kernel refuses writes (`dd of=/dev/vda` gives `EPERM`, `/sys/block/vda/ro` = 1), libkrun opens a read-only disk `O_RDONLY`, and the file is mode 0444. The image's hash was unchanged after that attempt.

### App code: keep the read-only virtio-fs share

We keep the spike's `app` virtio-fs share, mounted read-only at `/app`, instead of baking the app into a per-app layer:

- **`berth dev` edits must show up without a rebuild.** A layer means a mkfs plus a new hash on every save. The share is the Docker bind mount's equivalent.
- The app is small and read once at start (5 MB of bundles), so virtio-fs's per-access cost is negligible there. That cost is why the *system* tree, which `node` dlopens and reads all over, moved to a block image.
- The base image stays one shared, cacheable artifact per Berth release instead of one per app.
- The cost is ownership. virtio-fs has no uid mapping, so `/app` shows the host user, **501:20**, inside the guest. It is read-only and world-readable (0644/0755), so the app (10000) can read it and nobody can write it. 501 is not in the guest's passwd. For `berth deploy` or attested runs, a per-app erofs layer (same builder, hashed, owner 0:0) is the better fit: it would be measured like the rootfs, while the share is not.

### Ownership inside the guest (`MODE=inspect`)

```
0:0 755 /                       0:0 755 /usr/local/bin/agent-init
0:0 755 /etc                    0:0 755 /sbin/berth-init
0:0 644 /etc/passwd             0:0 755 /opt/berth/sdk-node
0:0 755 /usr/bin/node           files under /etc /usr /opt /sbin /bin /lib not owned by root: 0
501:20 755 /app                 501:20 644 /app/berth.yml, /app/dist/index.mjs   (virtio-fs share)
0:0 755 /state                  10000:10000 750 /state/workspace = /workspace
10000:10000 644 /workspace/notes.json, /workspace/notes.json.lock
passwd: berth-app0:x:10000:10000 …   berth-context-bus:x:9001:9001 …
```

The only non-0:0 file in the image is `/etc/shadow` (0:42 0640, Alpine's `shadow` group). The spike's problem, guest uid 501 owning `/`, `/etc` and `/etc/passwd`, is gone. While fixing it we found two bugs of the same kind: `cp -a` from the virtio-fs `/in` carried 501 onto existing directories and onto the image root itself. The build now fails if any 501 remains.

### Per-sandbox state disk

- `--state IMG [--state-size MiB]` (default 1024): if the file is missing, berth-vmm creates it sparse at that size, and the size is the cap. The disk attaches read-write as `/dev/vdb`, and the guest gets `BERTH_STATE_DEV=/dev/vdb`. On a 256 MiB disk, a new disk with notes on it allocates ~25 MB on the host.
- In the guest, `berth-init` checks the ext4 magic, runs `mkfs.ext4 -L berth-state -m 0 -E root_owner=0:0,nodiscard` on a blank disk, mounts it `nosuid,nodev` at `/state`, creates `/state/workspace` (10000:10000, 0750) and bind-mounts it onto `/workspace`. Without `--state`, `/workspace` is tmpfs, as in the spike.
- **Stop:** a host connection to vsock 5001 makes `berth-init` kill every other process, `sync`, unmount `/workspace` and `/state`, and exit. init.krun then ends the VM, and berth-vmm exits 0, ~210 ms after the request. A `SIGKILL` of berth-vmm also kept the note in one trial (ext4 journal, writes already flushed), but only the graceful path is a guarantee.

**libkrun bug found (and worked around):** on macOS, libkrun 1.19.6 truncates a raw disk image when the guest discards or write-zeroes a range that reaches the end of the device. `blkdiscard -o <size-64K> -l 64K /dev/vdb` shortens the file by 64 KiB, the same range 64 KiB further from the end does not, and `blkdiscard /dev/vdb` leaves a 0-byte file. `mkfs.ext4` zeroes the last blocks, so every freshly formatted disk came back 64 KiB short. The next boot then failed with `mount: mounting /dev/vdb on /state failed: Invalid argument`, because the filesystem was larger than the device. berth-vmm now extends a short state disk back to `--state-size` before boot. The lost tail is a range the guest asked to read as zeros, so a sparse zero tail is the right content. It reports `restoredBytes` (65536 after a first format). This should go upstream. A guest can still truncate its *own* disk mid-run (denial of its own state only). The read-only rootfs cannot be truncated (see above).

## 3. End to end

Final image `42b32ced…`, kernel `8f79e8da…`, new 256 MiB state disk, notes app shared at `/app`:

```
boot 1  ACTIONS=add   state created=true   formatting ext4 → add_note → {"id":"5fe514bb-…"}
        stop requested → state disk unmounted cleanly → exit code 0
boot 2  ACTIONS=list  state created=false restoredBytes=65536
        list_notes → {"notes":[{"id":"5fe514bb-…","text":"survives a reboot","completed":false}]}
        [agent-init] landlock restrict_self() status: ruleset=FullyEnforced no_new_privs=true
```

Enforcement (`./scripts/run-probe.sh` on the final image):

| Check | Root, no agent-init | App uid 10000 under agent-init |
|---|---|---|
| Landlock ABI | 6 | 6, `ruleset=FullyEnforced` |
| write `/etc/x` | `EROFS` | `EROFS` (the read-only image answers before Landlock does; on the spike's virtio-fs root it was `EACCES`) |
| write to an undeclared, writable path (`/tmp`, mode 1777) | ok | **`EACCES`** (Landlock) |
| write `/workspace` (declared) | ok | ok |
| `connect(1.1.1.1:443)` | `ENETUNREACH` | `EACCES` |
| `io_uring_setup` | `ENOSYS` | `ENOSYS` |
| `socket(AF_VSOCK)` / UDP | fd / fd | `EPERM` / `EPERM` |
| network devices | `lo` only | |

### Boot time

Spawn of berth-vmm to the first RPC reply, 2 vCPU / 512 MiB, first boot plus 5 repeats, median of the repeats. **The host was busy during this session**: load average 6 to 13 from other work, which we did not control. The spike's own layout, re-run in this session for control, took 0.58 to 1.5 s, against its 0.39 s on a quiet host. So the absolute numbers below are upper bounds. Only same-round comparisons mean anything.

| Run (same session) | Median of 5 repeats |
|---|---:|
| Image, tmpfs `/workspace` (quietest run) | **409 ms** (391–412) |
| Image + state disk (quietest run) | **424 ms** (408–442) |
| Image + state disk under the Seatbelt profile | 514 ms (443–546, busier) |
| Round 1, interleaved: image+state / image / spike virtio-fs root | 573 / 409 / 580 ms |
| Round 2 | 493 / 462 / 1301 ms |
| Round 3 | 969 / 604 / 1539 ms |

The image root was faster than the spike's virtio-fs root in every interleaved round, by 1.4 to 2.8x. That fits the reasoning behind option A: `node` and its libraries load through the guest page cache instead of a FUSE round trip per file. Our quietest image runs (409 to 424 ms) are within 5 to 10% of the spike's 393 ms on a quiet host, and they include ~35 ms of new work, hashing the kernel (11 to 17 ms) and the rootfs (18 to 38 ms) before boot. The repeat run in `$ART/bench-final.log` was meant to run on a quieter host. See the addendum at the end if it ran.

Phase marks (image + state, a typical repeat): guest init at 157 ms, state disk mounted at 171 (+14 ms), policy compiled at 275, agent-init applied at 278, app ready at 397. The state disk costs ~15 ms per boot, plus ~20 ms of mkfs on the first boot. berth-vmm's physical footprint is 113 to 117 MiB (the spike measured 104 to 107).

## Guest init contract (the seam with `feat/vm-guest-init`)

The init is just a file: whatever `BERTH_INIT=<file>` names is installed at **`/sbin/berth-init`**, mode 0755, owner 0:0, and its hash is recorded in `inputs.json` (`berthInit`). A static Rust binary drops in the same way, and nothing else in the image or in berth-vmm changes. We checked this by building with `BERTH_INIT=guest/net-probe.sh`: the image booted it as init. The shell version stays the default until the Rust init lands.

What the init gets, and has to do (what `guest/berth-init.sh` does today):

| | |
|---|---|
| Started by | libkrun's `init.krun` as PID 1, which mounts `/proc`, `/sys`, `/dev`, switches to the image and execs `/sbin/berth-init` as root with berth-vmm's explicit env (never the host's) |
| Root | `/dev/vda`, erofs, **read-only**. Writable places: tmpfs it mounts on `/run` and `/tmp`, and the state disk |
| Env from berth-vmm | `PATH`, `BERTH_STATE_DEV=/dev/vdb` when there is a state disk, plus `--env` (today `BERTH_VM_MODE=rpc,probe,inspect`, `BERTH_REQUIRE_ENFORCEMENT`) |
| Must mount | securityfs, cgroup2 (`nsdelegate`), tmpfs `/run` and `/tmp`, virtio-fs tag `app` read-only on `/app` |
| State disk | if `BERTH_STATE_DEV` is set: ext4 magic `0xEF53` at byte 1080, else `mkfs.ext4 -L berth-state -m 0 -E root_owner=0:0,nodiscard`; mount `nosuid,nodev` on `/state`; `/state/workspace` owned by the app uid, 0750, bind-mounted on `/workspace`. Without one: tmpfs `/workspace` |
| Identities | uid/gid 10000 + app index (`berth-app<N>`), `berth` group 9999, context-bus 9001; all already in `/etc/passwd` and `/etc/group`; never add users at runtime |
| Policy | `node /opt/berth/sdk-node/generate-capability-policy.mjs` in `/app` as root, with `NODE_OPTIONS`/`NODE_PATH` unset → `/run/berth/capability-policy.json`, 0:appgid 0640 |
| vsock | 5000: app RPC (host connects in); **5001: stop**, where the first connection means kill the apps, `sync`, unmount `/workspace` and `/state`, exit 0 (init.krun then ends the VM) |
| Exit | the init's exit ends the VM; exit after the state disk is unmounted |

## Problems and open questions

1. **libkrun tail-discard truncation** (above). Worked around in berth-vmm. Report it upstream with the `blkdiscard` reproduction. Until it is fixed, a guest can shrink its own state disk mid-run, so reads near the end fail until the next boot restores the size.
2. **Pre-boot hashing costs ~30 to 50 ms** (kernel and rootfs, CommonCrypto, warm page cache). A verified-stamp cache keyed on (dev, inode, size, mtime, ctime) would remove it from warm boots, at the cost of trusting file metadata. Alternatively, erofs fs-verity or dm-verity would verify lazily inside the guest.
3. **The rootfs rebuild depends on Alpine's live repository.** A later build can resolve newer packages. Pin with a mirrored apk cache to rebuild an exact old image.
4. **`/app` is unmeasured and owned by host uid 501** (virtio-fs, no idmap). That is fine for `berth dev`. Attested and deployed runs want a hashed per-app layer.
5. **Builder VMs** still run with TSI (host network) on libkrunfw's unpinned kernel through `DYLD_LIBRARY_PATH`. They only run our build scripts, but the toolchain they download is trusted by apk signature and not pinned. kernel.org's `sha256sums.asc` signature was not checked with gpg; the hash is pinned from it.
6. **The measurement line is not signed**, and nothing consumes it yet. That is the attestation step.
7. **16 app slots, named `berth-appN`**, not `berth-<app>`. Multi-app peer directories have to map by index.
8. **Graceful stop needs the guest to cooperate.** A hung guest gets SIGKILL after 10 s, and only the ext4 journal protects the state then. The control port is unauthenticated: anything on the host that can reach `$ART/run/*-ctl.sock` can stop the VM, so the socket directory's permissions are its access control.
9. **The Seatbelt profile** now allows writes under `$ART/state`, but still all of `$ART` for reads. It should allow exactly this sandbox's kernel, image, app dir, state disk and sockets.
10. **python3 is not in the base image** (+20.8 MB, +45%). It could be a second erofs layer (overlay lower) mounted only for `runtime: python` apps, or a `PYTHON=1` variant image.
11. **Timing was measured on a loaded host** (see above). Re-measure on a quiet one.

## Commits

On `feat/vm-image` (on top of 65fe6bf):

```
build(vmm): pin the guest kernel in kernel/manifest.toml and build it in its own builder root
feat(vmm): verify the pinned kernel, boot a content-addressed rootfs, add a state disk
fix(vmm): restore a state disk that libkrun truncated on a tail discard
feat(vmm): build the base rootfs as a reproducible, content-addressed erofs image
test(vmm): boot notes on the pinned kernel, rootfs image and a state disk
fix(vmm): keep the git commit out of the rootfs image
test(vmm): probe a Landlock write denial on a writable path, compare with a virtio-fs root
docs: write up the microVM image work
```

## Disk used

`$ART` holds 1.2 GB: three builder roots (kernel, agent-init, image) 1.0 GB, the download cache 151 MB (mostly the 145 MB linux tarball), the kernel 23 MB, the rootfs image and records 44 MB, a 25 MB state disk, and the app dir 5 MB. Scratch disks (kernel 2.2 GB at peak) are deleted after each build. Free space on the data volume stayed between 17 and 22 GB.
