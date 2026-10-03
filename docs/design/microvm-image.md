# microVM image: pinned kernel, content-addressed rootfs, per-sandbox state

Date: 2026-10-01. Branch `feat/vm-image`, stacked on `spike/libkrun-vm` (65fe6bf). Machine: Apple M4, 16 GB, macOS 27.0, HVF, libkrun 1.19.6.

**Aligned with `feat/vm-guest-init`** (the Rust berth-init) so the two branches merge cleanly. That covers the vsock port plan (1024 control, 1025 logs, 5000+i RPC, shutdown via `{"op":"shutdown"}` on 1024), identities written at boot instead of baked in, `/context`, the policy compiler from `feat/per-app-cgroups`, `rcupdate.rcu_expedited=1`, and cgroup2 with `favordynmods`. See "Guest init contract".

> **Follow-up (2026-10-01, `feat/vm-runtime`):** current state in [`microvm-runtime.md`](microvm-runtime.md). The image now carries the Rust berth-init and context-bus-daemon (no socat, no shell stand-in; rootfs `57e7ef8b…`, pinned in `rootfs/manifest.toml`). The pinned command line boots berth-init directly as PID 1 (`root=/dev/vda rootfstype=erofs ro init=/sbin/berth-init`), with no init.krun. `run-probe.sh` and `boot-notes.mjs` are replaced by `berth-vmm run` and `scripts/e2e.mjs`.

This follows the libkrun spike (`docs/design/microvm-spike.md`). The spike booted notes from a host directory over virtio-fs and loaded the kernel by putting a rebuilt `libkrunfw.5.dylib` on `DYLD_LIBRARY_PATH`. This branch replaces both:

- **The kernel** is a pinned raw `Image`. `berth-vmm` compiles in `kernel/manifest.toml` and boots a kernel through `krun_set_kernel` only if the file's sha256 matches the pin.
- **The root filesystem** is a read-only erofs image. It is named by its sha256, built reproducibly in a builder VM, and every file in it has a real guest owner.
- **Writable state** lives on a small per-sandbox ext4 disk. `/workspace` survives a reboot of the same sandbox.

Artifacts live in `/Users/ash/berth-wt/vm-image-artifacts/` (`$ART`). Nothing big is committed.

## Results

| Goal | Result | Evidence |
|---|---|---|
| 1. Pinned kernel, raw Image, sha256-verified, measured | **Pass** | A fresh, rust-free builder root rebuilt `Image` with sha256 `8f79e8da…` (the spike's hash). `berth-vmm --kernel` boots it, refuses a one-byte-modified copy, and prints the hash in a `measurements` line |
| 2. Content-addressed read-only rootfs + per-sandbox state disk | **Pass** | `rootfs-2eaa3e0a….erofs` (46.4 MB), rebuilt with the same hash every time, mounted `/dev/vda erofs ro`. Every file is root-owned; the static uids are baked in and the app uids are written at boot. The state disk is `/dev/vdb` ext4, created sparse, formatted on first boot |
| 3. End to end | **Pass** | Boot 1: `add_note`, then a graceful stop. Boot 2: `list_notes` returns the note. `ruleset=FullyEnforced`. Ownership was checked (table below). Boot times are below; the host was under load from other work |
| 4. Docs | This file | |

python3 was **not** in the base image at first. Since feat/vm-python it is, with berth_sdk's dependencies from Alpine (py3-yaml, py3-pydantic, py3-protobuf) and berth_sdk itself at `/opt/berth/sdk-python`: rootfs `322ee4f3…` is 74.7 MB against 46.7 MB without (+28 MB, +60%). The `PYTHON=1` variant is gone. Since feat/vm-semantic-fs-build it also holds `fuse3` (fusermount3, setuid bit removed) and `semantic-fs-daemon` (7.5 MB, static Go): rootfs `7f361418…` is 79.5 MB. berth-init starting it (feat/vm-semantic-fs-init) made that `30845aab…`, 79.5 MB, and its `kill_daemon` test hook (test/vm-semantic-fs-e2e) `e3b83441…`.

## How to build and run

```sh
cd packages/vmm
./scripts/build-kernel.sh       # ~5 to 9 min, 8 vCPU builder VM, ~2.2 GB scratch at peak (deleted after)
./scripts/build-agent-init.sh   # ~30 s
./scripts/build-rootfs.sh       # ~7 s after the first apk download
./scripts/run-probe.sh                          # enforcement probe on the image
MODE=inspect STATE=$ART/state/x.img ./scripts/run-probe.sh   # mounts + ownership

STATE=$ART/state/notes.img ACTIONS=add  node scripts/boot-notes.mjs   # boot 1: add, graceful stop
STATE=$ART/state/notes.img ACTIONS=list node scripts/boot-notes.mjs   # boot 2: list
STATE=$ART/state/notes.img RUNS=6 node scripts/boot-notes.mjs         # first + 5 repeats
```

On Linux the same scripts build in a container instead of a builder VM (`BERTH_BUILDER=docker`, the default there; see [Distribution](#distribution)), which is how CI runs them. Each build script checks for 10 GB free before it starts. Builder VMs are the only VMs that run with TSI on, and the only ones that use libkrunfw's bundled kernel (`--libkrunfw-kernel`, through `DYLD_LIBRARY_PATH`). A sandbox never does either.

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
| `cmdline` | `reboot=k panic=-1 panic_print=0 nomodule console=hvc0 rootfstype=virtiofs rw quiet no-kvmapf rcupdate.rcu_expedited=1 init=/init.krun` (`rcu_expedited`: about 60 ms off a berth-init boot, measured on feat/vm-guest-init) |
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
           "configSha256":"e3f33c2b…","cmdline":"reboot=k … rcupdate.rcu_expedited=1 init=/init.krun","hashMs":12},
 "rootfs":{"sha256":"2eaa3e0afc4597ad084d74df1d4fe37e7cc9aa1ddbd35051357d7ffab2142414","fstype":"erofs","readOnly":true,"hashMs":22},
 "state":{"path":"…/state/notes.img","sizeBytes":268435456,"created":false,"restoredBytes":65536}}
```

`kernel: null` (a builder on libkrunfw) or `rootfs: null` (a virtio-fs root) means "not pinned", and attestation must report it as such. The line is not signed yet: the host prints it, and a later step signs it or feeds it to the attestation record.

### Distribution

Implemented on `feat/vm-artifacts-release`. Users never build the kernel or the rootfs: CI does, and proves the result is the pinned bytes.

**The workflow** (`.github/workflows/vm-artifacts.yml`, on `workflow_dispatch` or a pushed `vm-artifacts-*` tag):

| Job | Runner | What |
|---|---|---|
| `pins` | ubuntu-24.04 | reads `image_sha256` from both manifests, names the release `vm-artifacts-<kernel8>-<rootfs8>`, checks the CLI's `pins.ts` carries the same pins, and that a pushed tag is that name |
| `kernel` | ubuntu-24.04-arm | `scripts/build-kernel.sh`. Fails unless the Image is `image_sha256` and the config is `config_sha256` |
| `guest` | ubuntu-24.04-arm | `build-agent-init.sh` (from `agent_init_commit`), `build-berth-init.sh` (unit tests, then the static binaries). Each checks its outputs against `rootfs/manifest.toml` |
| `rootfs` | ubuntu-24.04-arm | `pnpm install --frozen-lockfile` (esbuild, yaml, zod), then `build-rootfs.sh` on the guest job's binaries. Checks every input against its pin, then the image against `image_sha256` |
| `vmm` | macos-15 (arm64) | libkrun 1.19.6 from the `libkrun/krun` tap at a pinned commit (`brew trust --formula` where Homebrew needs it), Rust 1.89.0, `cargo test` and `cargo build --release --locked`, ad hoc signed with `berth-vmm.entitlements`. Checks the entitlement, that the binary carries this release's kernel and rootfs pins, and that it links `/opt/homebrew/opt/libkrun/lib/libkrun.1.dylib`. It cannot boot a VM (no nested virtualization on hosted runners) |
| `publish` | ubuntu-24.04 | only on a tag push or `publish: true`; the only job with `contents: write`. Re-hashes every asset against its name, writes `SHA256SUMS`, `SOURCES.md` and the notes, and creates the release (`--latest=false`, so the npm `v0.x` release stays "Latest") or updates it |

A failed check prints both hashes, the built one and the pinned one. Every third-party action is pinned by commit SHA (`scripts/lint-workflows.sh` passes).

**One build path, two builders.** The scripts are the ones a developer runs. `scripts/common.sh`'s `run_builder` starts the in-builder script (`kernel/build-in-vm.sh`, `guest/build-*-in-vm.sh`, `rootfs/build-in-vm.sh`) in either:

- **`BERTH_BUILDER=vm`** (macOS default): a libkrun builder VM booting a root unpacked from the pinned minirootfs, with virtio-fs shares and an ext4 scratch disk.
- **`BERTH_BUILDER=docker`** (Linux default, CI): a container whose image is that same minirootfs, `docker import`ed from the sha256-checked tarball and never pulled from a registry, with bind mounts and a scratch volume.

The in-builder scripts see `/in` or `/src`, `/out` and `/build` either way, and install the toolchain with apk from Alpine 3.24, so the toolchain is the same as long as Alpine serves the same versions. The host side is portable shell (`sha256_of`, `file_size`, `sed_inplace` for BSD, GNU and busybox userlands).

**Release assets**, named by sha256 so one release can hold several berth-vmm builds and every file is its own checksum:

| Asset | |
|---|---|
| `Image-<sha256>` | the guest kernel |
| `rootfs-<sha256>.erofs` | the base rootfs, plus `rootfs-<sha256>.inputs.json` and `.tree.txt` |
| `berth-vmm-darwin-arm64-<sha256>` | the launcher, plus a `.txt` with its toolchain, libkrun and pins |
| `SHA256SUMS` | every asset |
| GPL-2.0 sources | `linux-6.12.109.tar.xz` and `libkrunfw-5.6.2.tar.gz` (the exact tarballs, sha256-checked against the manifest), `berth-kernel.config`, `kernel-config-<sha256>` (the resolved `.config`), `kernel-build-in-vm.sh`, `kernel-toolchain-<sha256>.txt`, and `SOURCES.md` describing them |

**Fetch.** `berth vm install` takes the pins from berth-vmm (else its own), derives the tag, and downloads `https://github.com/Ash20pk/BerthOS/releases/download/vm-artifacts-{kernel8}-{rootfs8}/{asset}` into `~/.berth/vm`, checking the size as it streams and the sha256 before anything is renamed into place. A mirror is any URL template (`--url`, `BERTH_VM_ARTIFACTS_URL`, `vm.artifactsUrl`), including `file://`. When no berth-vmm is found, it downloads the published one, but only if the CLI pins its sha256 (`VMM_PINS` in `packages/cli/src/vm/pins.ts`). It then clears `com.apple.quarantine` on that verified file. The workflow prints the pin line to add after a build, since a binary CI builds can't be pinned before CI builds it.

**Integrity.** The sha256 pins are the root of trust. They are compiled into berth-vmm and the CLI, which the user already trusts. The CI rebuild is the independent second build that shows the pins come from this source. Sigstore or minisign signing of the release would add provenance on top, but is not done.

**Signing berth-vmm.** It is ad hoc signed. macOS runs it once it isn't quarantined, so a copy downloaded with a browser needs `xattr -d com.apple.quarantine`. `berth vm install` does that only after the sha256 matched, and a file Node downloads isn't quarantined in the first place. Proper distribution needs an Apple Developer ID Application certificate in the workflow (a `.p12` and its password as secrets, imported into a temporary keychain), `codesign --options runtime --timestamp` with the same entitlements, then `xcrun notarytool submit --wait` with an App Store Connect API key. A bare Mach-O can't be stapled, so the ticket is fetched online on first run, or it ships in a zip or pkg instead.

#### Reproducibility across machines (evidence, 2026-10-01)

| Artifact | Fresh root on the dev Mac, today | Pin |
|---|---|---|
| kernel `Image` | `8f79e8da…` (factored `build-kernel.sh`, new builder root). Alpine had since moved `python3` 3.14.7 to 3.14.8 and `nghttp2-libs` 1.69.0 to 1.70.0 in the builder, with no effect on the Image | `8f79e8da…`, unchanged |
| agent-init, probe | `9ec8b25e…`, `6ec735d8…` (from `c558ef8`) | unchanged |
| berth-init, context-bus-daemon | `c82613e7…`, `1138c359…` | unchanged |
| rootfs | `778f0b25…`, four builds, three from fresh builder roots, one with a different `node_modules` checkout | **re-pinned** from `5f80e448…` |
| rootfs, after CI | `5f696a92…`, three builds; the CI build's extracted tree packed the same way gives the same bytes; `e2e.mjs all` 51/51 | **re-pinned** from `778f0b25…` (3. below) |

The old rootfs pin could not be rebuilt anywhere but the machine that made it, for the first two reasons below; `778f0b25…` failed to match in CI for the third:

1. **esbuild wrote host paths into the sdk-node bundles.** It puts a `// <path>` comment above each inlined module, and keys CommonJS wrappers by path, relative to the working directory. The pinned bundles held `../../../../agentOS/node_modules/.pnpm/yaml@2.9.1/...` and `../../../vm-egress-artifacts/rootfs-build/policy-src/...`. Rebuilding from a different directory changed the bytes. Recreating that exact relative layout reproduced the old bundle hashes (`3f19608e…`, `9f023166…`), which confirms this was the cause. Now `scripts/bundle-sdk-node.mjs` stages the sources and the packages they use into one fixed layout (`packages/sdk/src`, `node_modules/<name>`) and bundles from there. The output is the same from any checkout, any `node_modules` tree and any working directory. The code is unchanged apart from those paths. The bundler version and the inlined package versions are now recorded in the image's `build-inputs.json`.
2. **Alpine moved a package.** `nghttp2-libs` (a nodejs dependency) went from 1.69.0-r0 to 1.70.0-r0 in v3.24, and Alpine's mirrors keep only the newest build. That alone changes the image.
3. **mkfs.erofs kept some directory mtimes.** CI's rebuild of `778f0b25…` (docker builder) had the same tree listing, the same file contents (every sha256) and no xattrs on either side, but 1027 bytes differed. With `SOURCE_DATE_EPOCH` in its environment, erofs-utils 1.9.1 only clamps newer mtimes to it and ignores `--all-time`. `/dev` and `lib/apk/exec` kept the minirootfs's mtime (2026-09-17) in the builder VM, but in the container the stray-file cleanup and apk's package scripts touched them, so they were clamped to the epoch there: different inode sizes (64 against 32 bytes), so every later nid moved. Re-packing each image's extracted tree with the old options gave back each original exactly; with `SOURCE_DATE_EPOCH` unset, both gave `5f696a92…`, as the fixed build does.

The new image passed `scripts/e2e.mjs all` (51/51) and `egress` (28/28). The CLI's `test/vm-e2e.mjs` also passed 17/17 on the kernel, rootfs and berth-vmm installed by `berth vm install` from a local GitHub-release-shaped server.

**The limit that remains.** apk resolves the newest versions in v3.24, and the mirror drops old ones. A pin is reproducible from source only while Alpine still serves the package set in `rootfs/apk.lock` (and `kernel/apk.lock` and `guest/*.apk.lock` for the toolchains). The scripts report any difference from those locks, and the hash check fails if it matters. The kernel's toolchain drift above did not matter, but a gcc or binutils update would. So publish soon after pinning, and re-pin (`UPDATE_MANIFEST=1`) when CI reports drift. Published assets don't expire. Only the ability to rebuild them bit for bit does. Making that permanent needs a package snapshot: `apk fetch` the exact `.apk` files, which Alpine signs, into a cache kept with the release, and install from it offline. That is the next step, and is not done.

## 2. The root filesystem

### Image

`$ART/rootfs/rootfs-2eaa3e0afc4597ad084d74df1d4fe37e7cc9aa1ddbd35051357d7ffab2142414.erofs`: **46,366,720 bytes**, erofs with lz4hc, built from an 82.5 MB tree.

| Content | Source |
|---|---|
| Alpine 3.24.2 minirootfs | official tarball, sha256-pinned |
| `nodejs` 24.18.1-r0, `e2fsprogs` 1.47.4-r0 (mkfs.ext4 for the state disk), `socat` 1.8.1.3-r0 (only for the shell stand-in init; drop it with the Rust init) (+ deps, 40 packages total, busybox 1.37.0-r31) | `rootfs/packages.txt`; exact versions in `inputs.json` and the image's own apk db |
| `/usr/local/bin/agent-init` (static-pie musl, `9ec8b25e…`), `/usr/local/bin/berth-probe` | `fix/seccomp-io-uring-vsock` @ c558ef8, built by `build-agent-init.sh` as the spike did. We use this branch, not `main`, because `main` lacks the io_uring/AF_VSOCK seccomp refusal |
| `/opt/berth/sdk-node/{generate-capability-policy,run-lifecycle}.mjs` | the sdk-node bundles (`bundle-daemons.mjs`'s esbuild options), from **`POLICY_REF`, default `feat/per-app-cgroups` @ 28b0999**, whose compiler writes `cgroupLimits` (the guest logs `cgroupLimits=cpu.weight=100, pids.max=1024` for notes) |
| `/usr/local/bin/context-bus-daemon` | optional, with `CONTEXT_BUS_DAEMON=<static binary>` (feat/vm-guest-init builds one); not in this image |
| `/sbin/berth-init` | `guest/berth-init.sh`, the init seam (below) |
| `/usr/local/bin/{net-probe,leak-probe}` | spike probes |
| `/etc/passwd`, `/etc/group`, `/etc/shadow` | static identities only: group `berth` 9999 (member `berth-context-bus`) and user/group `berth-context-bus` 9001. **No app users:** the init writes `berth-<app>` (10000+index) at boot |
| `/etc/berth/build-inputs.json` | the input record, minus the image's own hash and the git commit |
| `/app`, `/workspace`, `/context`, `/state` | empty mount points, root 0755 |

A read-only root cannot `adduser` at boot the way `entrypoint.sh` does. The first version of this branch baked in 16 slots (`berth-app0..15`). context-bus-daemon names peers by `berth-<app>`, though, so the image now carries only the static identities. The init copies `passwd` and `group` to tmpfs, appends `berth-<app>` (uid = 10000 + the app's index, as in Docker), adds it to `berth`, and bind-mounts the copies over `/etc/passwd` and `/etc/group`. feat/vm-guest-init's berth-init does the same, and the shell stand-in here does it for the single app. In the guest: `berth-notes:x:10000:10000`, `berth:x:9999:berth-context-bus,berth-notes`.

### Build (`scripts/build-rootfs.sh`, `rootfs/build-in-vm.sh`)

1. On the host: fetch and check the minirootfs, bundle the sdk-node tools and notes with esbuild, and stage `/in`: the tarball, `packages.txt`, `SOURCE_DATE_EPOCH` (from `rootfs/manifest.toml`), and a `files/` overlay tree.
2. In a builder VM (its own fresh Alpine root, TSI on, 4 vCPU): untar onto an ext4 scratch disk **as guest root**, `apk --root … add`, overlay `files/` and chown every overlaid path to 0:0, then append the identities and empty `resolv.conf`. Drop `/var/cache/apk` and `/var/log/apk.log`. List every path with `uid:gid mode` and **fail if uid 501 appears**. Then `mkfs.erofs -zlz4hc -T$EPOCH --all-time -U <fixed uuid>` (erofs-utils 1.9), with `SOURCE_DATE_EPOCH` unset so that every inode gets the epoch.
3. On the host: name the file `rootfs-<sha256>.erofs` (mode 0444) and write `rootfs-<sha256>.inputs.json` next to it, with the image hash and size, packages requested and resolved, the agent-init hash, source ref and commit, the berth-init and sdk-node hashes, the mkfs version, the tree listing hash, and the source commit and dirty flag. Also write `rootfs-<sha256>.tree.txt` (the ownership listing) and `LATEST`.

**Reproducibility.** Two leaks of build time had to go: `/var/log/apk.log` (it carries a wall-clock line) and the git commit, which is now only in the outer `inputs.json`, since inside the image it would change the hash on every unrelated commit. After that, rebuilds gave the same hash every time: three in a row of one tree (`30eb84a4…`), the pre-alignment image `42b32ced…` from a dirty and then a clean tree, and the final image `2eaa3e0a…` twice. Every build formats a new scratch disk, so ext4 directory order does not leak in either. The limit is that apk resolves the newest package versions in v3.24, so a rebuild next month may differ. Content addressing makes that visible (a new hash, a diffable `inputs.json`) rather than silent. Bit-exact rebuilds of an old image need a pinned apk package cache (open item). Later it turned out that the sdk-node bundles also carried the build machine's paths. That is fixed, see [Distribution](#distribution).

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
passwd: berth-notes:x:10000:10000 … (tmpfs copy, bound over /etc/passwd)   berth-context-bus:x:9001:9001 …
group:  berth:x:9999:berth-context-bus,berth-notes
mounts: tmpfs /context; cgroup2 rw,nosuid,nodev,noexec,relatime,nsdelegate,favordynmods
```

The only non-0:0 file in the image is `/etc/shadow` (0:42 0640, Alpine's `shadow` group). The spike's problem, guest uid 501 owning `/`, `/etc` and `/etc/passwd`, is gone. While fixing it we found two bugs of the same kind: `cp -a` from the virtio-fs `/in` carried 501 onto existing directories and onto the image root itself. The build now fails if any 501 remains.

### Per-sandbox state disk

- `--state IMG [--state-size MiB]` (default 1024): if the file is missing, berth-vmm creates it sparse at that size, and the size is the cap. The disk attaches read-write as `/dev/vdb`, and the guest gets `BERTH_STATE_DEV=/dev/vdb`. On a 256 MiB disk, a new disk with notes on it allocates ~25 MB on the host.
- In the guest, `berth-init` checks the ext4 magic, runs `mkfs.ext4 -L berth-state -m 0 -E root_owner=0:0,nodiscard` on a blank disk, mounts it `nosuid,nodev` at `/state`, creates `/state/workspace` (10000:10000, 0750) and bind-mounts it onto `/workspace`. Without `--state`, `/workspace` is tmpfs, as in the spike.
- **Stop:** `{"op":"shutdown"}` on the control port, vsock 1024, makes the init answer `shutting_down`, kill every other process, `sync`, unmount `/workspace` and `/state`, and exit. init.krun then ends the VM, and berth-vmm exits 0, ~210 ms after the request for the shell init (feat/vm-guest-init's Rust init: 37 to 48 ms). A `SIGKILL` of berth-vmm also kept the note in one trial (ext4 journal, writes already flushed), but only the graceful path is a guarantee.

**libkrun bug found (and worked around):** on macOS, libkrun 1.19.6 truncates a raw disk image when the guest discards or write-zeroes a range that reaches the end of the device. `blkdiscard -o <size-64K> -l 64K /dev/vdb` shortens the file by 64 KiB, the same range 64 KiB further from the end does not, and `blkdiscard /dev/vdb` leaves a 0-byte file. `mkfs.ext4` zeroes the last blocks, so every freshly formatted disk came back 64 KiB short. The next boot then failed with `mount: mounting /dev/vdb on /state failed: Invalid argument`, because the filesystem was larger than the device. berth-vmm now extends a short state disk back to `--state-size` before boot. The lost tail is a range the guest asked to read as zeros, so a sparse zero tail is the right content. It reports `restoredBytes` (65536 after a first format). This should go upstream. A guest can still truncate its *own* disk mid-run (denial of its own state only). The read-only rootfs cannot be truncated (see above).

## 3. End to end

Final image `2eaa3e0a…`, kernel `8f79e8da…`, new 256 MiB state disk, notes app shared at `/app`:

```
boot 1  ACTIONS=add   state created=true   formatting ext4 → add_note → {"id":"56044867-…"}
        {"op":"shutdown"} on vsock 1024 → state disk unmounted cleanly → exit code 0 (214 ms)
boot 2  ACTIONS=list  state created=false restoredBytes=65536
        list_notes → {"notes":[{"id":"56044867-…","text":"survives a reboot","completed":false}]}
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

Spawn of berth-vmm to the first RPC reply, 2 vCPU / 512 MiB, first boot plus 5 repeats, median of the repeats. **The host was busy during this session** (load average 3 to 13 from other work we did not control). The spike's own layout, re-run as a control, took 0.51 to 1.5 s, against its 0.39 s on a quiet host. So only same-round comparisons mean anything.

Final image (`2eaa3e0a…`, rcu_expedited), load 3.1 to 3.5, interleaved:

| Round | image + state disk | image, tmpfs `/workspace` | spike layout (virtio-fs root dir, same kernel) |
|---|---:|---:|---:|
| 1 | (run failed, see problem 12) | 465 ms | 527 ms |
| 2 | 462 ms | 454 ms | 517 ms |
| 5 more image+state runs (new disk each) | 451, 496, 466, 448, 490 ms | | |

Earlier in the day (image `42b32ced…`, no rcu_expedited, load 4 to 13): quietest image 409 ms and image+state 424 ms; under the Seatbelt profile 514 ms; three interleaved rounds of image+state / image / virtio-fs at 573/409/580, 493/462/1301 and 969/604/1539 ms; after waiting for load < 4, 450/528/526 and 587/459/509 ms.

What this shows:

- **The block-image root is faster than the virtio-fs root in every interleaved round**: 10 to 13% at load ~3, up to 2.8x under heavy load. That fits the reasoning behind option A: `node` and its libraries come from the guest page cache instead of a FUSE round trip per file, and the gap widens when the host is slow to serve those round trips.
- **Against the spike's 0.39 s:** the quiet-host figure could not be re-measured. Scaling by the control (the spike layout ran at 509 to 527 ms here, against 393 ms quiet), the image would be ~0.35 s on a quiet host. That is an estimate, not a measurement.
- New work in every boot: hashing the kernel (11 to 17 ms) and the rootfs (18 to 38 ms) before boot, and ~15 to 20 ms to mount the state disk (plus ~20 ms of mkfs on the first boot).

Phase marks (image + state, a repeat): guest init at 159 ms, state disk mounted at 181, policy compiled at 303, agent-init applied at 313, app ready at 462. berth-vmm's physical footprint is 91 to 117 MiB (the spike measured 104 to 107).

## Guest init contract (the seam with `feat/vm-guest-init`)

The init is just a file: whatever `BERTH_INIT=<file>` names is installed at **`/sbin/berth-init`**, mode 0755, owner 0:0, and its hash is recorded in `inputs.json` (`berthInit`). A static Rust binary drops in the same way, and nothing else in the image or in berth-vmm changes. We checked this by building with `BERTH_INIT=guest/net-probe.sh`: the image booted it as init. The shell version stays the default until the Rust init lands.

What the init gets, and has to do (what `guest/berth-init.sh` does today):

| | |
|---|---|
| Started by | libkrun's `init.krun` as PID 1, which mounts `/proc`, `/sys`, `/dev` and cgroup2 (without `nsdelegate`/`favordynmods`, so remount it), switches to the image and execs `/sbin/berth-init` as root with berth-vmm's explicit env (never the host's). libkrun passes that env on the kernel command line (`KRUN_INIT=… KRUN_BLOCK_ROOT_DEVICE=/dev/vda …`). feat/vm-guest-init's berth-init also runs directly as `init=`; over this erofs root it has only been tested exec'd by init.krun |
| Root | `/dev/vda`, erofs, **read-only**. Writable places: tmpfs it mounts on `/run` and `/tmp`, and the state disk |
| Env from berth-vmm | `PATH`, `BERTH_STATE_DEV=/dev/vdb` when there is a state disk, plus `--env` (today `BERTH_VM_MODE=rpc,probe,inspect`, `BERTH_REQUIRE_ENFORCEMENT`) |
| Must mount | securityfs, cgroup2 (`nsdelegate,favordynmods`, falling back without the latter), tmpfs `/run`, `/tmp` and `/context`, virtio-fs tag `app` read-only on `/app` (multi-app: `/app/<tag>`, per `BERTH_VM_APPS`) |
| State disk | if `BERTH_STATE_DEV` is set: ext4 magic `0xEF53` at byte 1080, else `mkfs.ext4 -L berth-state -m 0 -E root_owner=0:0,nodiscard`; mount `nosuid,nodev` on `/state`; `/state/workspace` owned by the app uid, 0750, bind-mounted on `/workspace`. Without one: tmpfs `/workspace` |
| Identities | the image has `berth` (9999) and `berth-context-bus` (9001). The init writes `berth-<app>` = 10000 + index into a tmpfs copy of passwd/group, adds it to `berth`, and binds the copies over `/etc/passwd` and `/etc/group` |
| Policy | `node /opt/berth/sdk-node/generate-capability-policy.mjs` in `/app` as root, with `NODE_OPTIONS`/`NODE_PATH` unset → `/run/berth/capability-policy.json`, 0:appgid 0640 |
| vsock (feat/vm-guest-init's plan, all listen-mode) | **1024 control**: a `hello` line, then line-JSON ops: `{"op":"status"}`, and `{"op":"shutdown"}`, which means stop the apps, `sync`, unmount `/workspace` and `/state`, exit (init.krun then ends the VM). **1025 logs** (the Rust init only). **5000+i RPC** for app i. The shell stand-in serves 1024 (hello, status, shutdown) and 5000 |
| Exit | the init's exit ends the VM; exit after the state disk is unmounted |

## Problems and open questions

1. **libkrun tail-discard truncation** (above). Worked around in berth-vmm. Report it upstream with the `blkdiscard` reproduction. Until it is fixed, a guest can shrink its own state disk mid-run, so reads near the end fail until the next boot restores the size.
2. **Pre-boot hashing costs ~30 to 50 ms** (kernel and rootfs, CommonCrypto, warm page cache). A verified-stamp cache keyed on (dev, inode, size, mtime, ctime) would remove it from warm boots, at the cost of trusting file metadata. Alternatively, erofs fs-verity or dm-verity would verify lazily inside the guest.
3. **The rootfs rebuild depends on Alpine's live repository.** A later build can resolve newer packages. Pin with a mirrored apk cache to rebuild an exact old image.
4. **`/app` is unmeasured and owned by host uid 501** (virtio-fs, no idmap). That is fine for `berth dev`. Attested and deployed runs want a hashed per-app layer.
5. **Builder VMs** still run with TSI (host network) on libkrunfw's unpinned kernel through `DYLD_LIBRARY_PATH`. They only run our build scripts, but the toolchain they download is trusted by apk signature and not pinned. kernel.org's `sha256sums.asc` signature was not checked with gpg; the hash is pinned from it.
6. **The measurement line is not signed**, and nothing consumes it yet. That is the attestation step.
7. **Identities at boot.** The image no longer bakes app users (fixed during the alignment). The shell stand-in writes only the single app. Multi-app identities, `tty` membership and peer directories come with the Rust init.
8. **Graceful stop needs the guest to cooperate.** A hung guest gets SIGKILL after 10 s, and only the ext4 journal protects the state then. The control port is unauthenticated on the host side: anything that can reach `$ART/run/*-ctl.sock` can stop the VM, so the socket directory's permissions are its access control. Guest root can also bind or speak on the port (feat/vm-guest-init's host validation rule applies).
9. **The Seatbelt profile** now allows writes under `$ART/state`, but still all of `$ART` for reads. It should allow exactly this sandbox's kernel, image, app dir, state disk and sockets.
10. **python3 is in the base image** (feat/vm-python, +28 MB, +60%), so every sandbox downloads it. A second erofs layer (overlay lower) mounted only for `runtime: python` apps would keep the Node-only image at 46.7 MB, at the cost of a second pinned artifact.
11. **Timing was measured on a loaded host** (see above). Re-measure on a quiet one.
12. **One image+state benchmark run printed no result** (the first after the alignment). The run's stderr was not captured, and 5 more runs (30 boots, a new disk each) passed. It is most likely the same class as the EINTR bug fixed in e235def, but that is unconfirmed.
13. **Fixed along the way:** the shell init's fifo open was interrupted by a child's SIGCHLD (EINTR, which busybox ash does not retry) and ended the VM two seconds into every boot. The 2-second guest-mem logger exposed it. The Rust init is unaffected, but anything that waits in ash on a fifo needs the retry.

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
perf(vmm): add rcupdate.rcu_expedited=1 to the pinned kernel command line
feat(vmm): align the rootfs image with berth-init's contract
feat(vmm): stop the VM through the control port, as berth-init does
docs: record the alignment with feat/vm-guest-init
```

## Disk used

`$ART` holds 1.2 GB: three builder roots (kernel, agent-init, image) 1.0 GB, the download cache 151 MB (mostly the 145 MB linux tarball), the kernel 23 MB, the rootfs image and records 44 MB, a 25 MB state disk, and the app dir 5 MB. Scratch disks (kernel 2.2 GB at peak) are deleted after each build. Free space on the data volume stayed between 17 and 22 GB.
