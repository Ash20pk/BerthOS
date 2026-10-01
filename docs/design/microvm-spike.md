# Spike: Berth inside a Berth-owned microVM (libkrun on macOS)

Date: 2026-09-30. Branch `spike/libkrun-vm`. Machine: Apple M4 (10 cores), 16 GB RAM, macOS 27.0, HVF.

This spike checks the plan in the microVM research note (`/Users/ash/berth-wt/microvm-research.md`, section 7) on real hardware. It covers a launcher we own (`berth-vmm`), a guest kernel we build, agent-init plus `apps/notes` running inside the VM, and the enforcement checks. All four goals and both stretch goals pass. The problems we found are listed at the end.

> **Follow-up (2026-10-01, `feat/vm-image`):** the kernel is now a pinned raw Image that `berth-vmm --kernel` verifies against `kernel/manifest.toml`, and the root is a content-addressed erofs image plus a per-sandbox state disk. The libkrunfw dylib route, `--cmdline` and the `rootfs-notes` directory layout described below are gone; see `docs/design/microvm-image.md` for the current build and run commands.

Code lives in `packages/vmm/`. Nothing big is committed. Kernels, root filesystems and disk images go in `/Users/ash/berth-wt/libkrun-vm-artifacts/` (outside the repo; `$ART` below).

## Results at a glance

| Goal | Result | Evidence (details below) |
|---|---|---|
| 1. `berth-vmm` boots a guest with no NIC and TSI off, one vsock port, a fixed CPU/RAM cap, stock kernel | **Pass** | Guest runs commands, `connect(1.1.1.1:443)` fails with "Network unreachable", no routes. The stock kernel still creates a `dummy0` device (down, no address). Our kernel removes it (goal 2) |
| 2. Our own kernel with Landlock, built inside a libkrun guest | **Pass** | `/sys/kernel/security/lsm` = `capability,landlock,yama`, `landlock_create_ruleset(NULL,0,VERSION)` = **6**. Built in an Alpine builder VM in about 4.5 minutes, bit-for-bit reproducible across 3 builds; nothing installed on the host |
| 3. agent-init + apps/notes in the VM, RPC over vsock from the host | **Pass** | The host calls `add_note` then `list_notes`; `list_notes` returns the note just added. agent-init was built in a builder VM with Alpine's rustc |
| 4. Enforcement checks and measurements | **Pass** | `ruleset=FullyEnforced`; `/etc/x` gives `EACCES`; connect gives `EACCES` (Landlock) under the app and `ENETUNREACH` (no NIC) as root; io_uring and AF_VSOCK are refused. First boot to first RPC takes 0.54 s; the median of 5 repeats is **0.39 s** |
| Stretch: `berth-vmm` under a macOS sandbox profile | **Pass** | HVF works under a `(deny default)` Seatbelt profile. A virtio-fs share outside the allowed paths fails with `EPERM` |
| Stretch: virtio-fs shares only the app directory, read only | **Pass** | `/app` is a read-only share of the app dir, and the root filesystem is read only too (`EROFS` for root in the guest) |

## What was built

```
packages/vmm/
  src/main.rs                 berth-vmm: hand-written FFI over libkrun 1.19.6's C API
  build.rs                    links /opt/homebrew/opt/libkrun/lib/libkrun.dylib
  berth-vmm.entitlements      com.apple.security.hypervisor (+ disable-library-validation)
  berth-vmm.sb                Seatbelt profile (stretch goal)
  kernel/berth-kernel.config  our config delta on top of libkrunfw v5.6.2
  kernel/build-in-vm.sh       kernel build, runs inside the builder VM
  guest/berth-init.sh         guest init: the single-app part of entrypoint.sh
  guest/probe.c               enforcement probe (static musl C)
  guest/build-agent-init-in-vm.sh, prep-rootfs-in-vm.sh, net-probe.sh, vsock-echo.sh, leak-probe.sh
  scripts/common.sh           paths, disk-space guard, Alpine download + sha256 check
  scripts/build-kernel.sh     builder VM -> Image -> libkrunfw.5.dylib
  scripts/build-agent-init.sh builder VM -> static agent-init + probe
  scripts/build-rootfs.sh     guest rootfs + read-only app dir
  scripts/bundle-notes.mjs    esbuild bundles: policy compiler, SDK runtime, notes app
  scripts/run-probe.sh        boots in probe mode (goal 4 checks)
  scripts/boot-notes.mjs      boots, calls the app from the host, times it, samples memory
```

### berth-vmm

A ~300-line Rust binary with no crate dependencies. It declares the libkrun functions it uses by hand, against `libkrun.h` at 1.19.6 (`main` upstream has a different v2 builder API, so the version is pinned). One process runs one VM. It:

- sets `krun_set_vm_config(cpus, ram_mib)` (default 1 vCPU, 512 MiB; the spike runs use 2 and 512);
- uses a host directory as the root over virtio-fs. `--root-ro` exposes it read only, through `krun_add_virtiofs3("/dev/root", …, read_only=true)`;
- **never adds a virtio-net device**, and always calls `krun_disable_implicit_vsock` and then `krun_add_vsock(ctx, 0)`. The implicit device would turn TSI on, because no NIC is present. TSI is only enabled with `--tsi`, which only the builder VMs pass;
- maps vsock ports to host Unix sockets (`krun_add_vsock_port2`; `:listen` means the host connects in);
- passes an explicit guest environment, so the host environment is never copied in;
- prints one JSON `vm_config` line (cpus, memory, `tsi`, `nics: 0`, root and read-only flag, kernel, vsock ports, shares). Doctor and attestation would record the same facts;
- opens every share and disk before starting the VM. Without that check, a directory libkrun cannot open panics a vCPU thread and the VM hangs (see "Problems").

It is ad-hoc signed: `codesign --entitlements berth-vmm.entitlements --force -s - target/release/berth-vmm`. `scripts/common.sh:build_vmm` does this after every build.

The guest kernel is selected in one of two ways:

1. `DYLD_LIBRARY_PATH=<dir with libkrunfw.5.dylib>`. libkrun `dlopen`s `libkrunfw.5.dylib` by bare name. Without either option the launch fails with "Couldn't find or load libkrunfw.5.dylib".
2. `--kernel <raw arm64 Image> --kernel-format 0 --cmdline "…"` (`krun_set_kernel`). This **also works on the macOS build without any libkrunfw**, and the research note had listed that as unverified. Boot time is the same (median 136 ms from spawn to `/bin/true` exiting, for both methods).

### Guest kernel

`kernel/berth-kernel.config` is appended to libkrunfw v5.6.2's `config-libkrunfw_aarch64` (linux 6.12.109 plus libkrunfw's 36 patches), and then `make olddefconfig` runs. The build **fails if any line of the delta does not survive olddefconfig**. That check caught `CONFIG_IO_URING`, which is only settable with `CONFIG_EXPERT=y`.

| Added or changed | Why |
|---|---|
| `SECURITY`, `SECURITYFS`, `SECURITY_NETWORK`, `SECURITY_PATH`, `SECURITY_LANDLOCK`, `SECURITY_YAMA`, `LSM="landlock,yama"` | Landlock (ABI 6 on 6.12), active by default |
| `WIREGUARD=y` | Optional, for kernel-side mesh later |
| `EXPERT=y`, `# IO_URING is not set` | io_uring can create sockets without going through the seccomp-filtered `socket(2)` path |
| `# DUMMY is not set` | init.krun only uses `dummy0` for TSI. Without it the guest has `lo` and nothing else |
| `# USERFAULTFD is not set` | Hardening |
| Asserted as already on | `SECCOMP_FILTER`, cgroup v2 (`MEMCG`, `CGROUP_SCHED`, `CFS_BANDWIDTH`, `CGROUP_PIDS`), `FUSE_FS`, `VIRTIO_FS`, `VSOCKETS`, `VIRTIO_VSOCKETS`, `OVERLAY_FS`, `EXT4_FS` |

**How it is built, with nothing installed on the host:** `scripts/build-kernel.sh` boots a **builder VM** with the stock libkrunfw kernel and an Alpine 3.24.2 aarch64 minirootfs from the official CDN (sha256-checked). This VM, and the agent-init builder, are the only VMs that run with `--tsi`, so that `apk` and `curl` work. The builder gets 8 vCPUs, 4 to 6 GiB of RAM, and a sparse raw disk image that it formats as ext4 for the kernel tree. The kernel tree cannot live on the case-insensitive APFS virtio-fs root. The builder runs `apk add build-base bc flex bison elfutils-dev openssl-dev perl python3 …`, downloads linux-6.12.109 from cdn.kernel.org, applies libkrunfw's patches, merges our config and builds `Image`. On the host, libkrunfw's own `bin2cbundle.py --os Darwin` turns `Image` into `kernel.c`, and the Xcode CLT `cc` compiles that into `libkrunfw.5.dylib`, the same way libkrunfw's Makefile does for Darwin.

A clean build takes **263 to 270 s** wall time with 8 vCPUs (1,430 s user), including the `apk add` and the 145 MB kernel tarball download.

Output (in `$ART/kernel/`): `Image` (23.7 MB), `config`, `check.txt` (the per-line delta check), `lib/libkrunfw.5.dylib` (24 MB). `Image` sha256 `8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8`, config sha256 `e3f33c2bd4bffa16e52a066c325967e4bde091f20063e6eb5b81e8a2efac4dc8`.

**The Image is reproducible.** Three builds (one incremental, two from an empty scratch disk) produced the same `Image` hash. It was not reproducible at first: the builder root is shared with the agent-init build, which installs rustc, and kconfig probes for rustc and records its version in `.config` (`CONFIG_RUSTC_VERSION=109601`). That changed the config and Image hashes, though no feature changed. The build now runs make with `RUSTC=/bin/false` (the config has no Rust code). The general lesson: kernel outputs depend on what else is installed in the builder, so the builder should be a pinned image of its own.

### agent-init and the probe

`scripts/build-agent-init.sh` runs `git archive` on `packages/agent-init` at **`fix/seccomp-io-uring-vsock`** (c558ef8), which carries the io_uring/AF_VSOCK seccomp refusal, and builds it in the same kind of builder VM. It uses Alpine's `rust`/`cargo` (rustc 1.96.1). Alpine's host triple *is* `aarch64-alpine-linux-musl`, so this is a native build of the musl binary and **no rustup target was added on the host**. The build uses `RUSTFLAGS=-C target-feature=+crt-static` with an explicit `--target` (without it, the proc-macro crates fail to build) and produces a static-pie binary (0.9 MB). `guest/probe.c` is built with `gcc -static` in the same VM. The whole thing takes about 20 s.

### Guest rootfs and app directory

`scripts/build-rootfs.sh` produces:

- `$ART/rootfs-notes` (77 MB): the Alpine minirootfs, plus `nodejs` (v24.18.1) and `socat` installed in a one-off prep VM with TSI on, `/usr/local/bin/agent-init`, `/usr/local/bin/berth-probe`, `/sbin/berth-init`, the policy compiler bundle at `/opt/berth/sdk-node/generate-capability-policy.mjs`, and a `notes` user (uid/gid 10000). `/etc/resolv.conf` is emptied, since there is no network.
- `$ART/app-notes` (4.8 MB): `berth.yml` from `apps/notes`, `dist/index.mjs` (the notes app, with `@berthos/sdk` and zod bundled in) and `runtime.mjs` (the SDK runtime, bundled). The runtime has to be inside the app directory because the compiled read policy only grants the app's cwd plus the system directories, just as `node_modules/@berthos/sdk` sits under the app in the image.

The bundles come from `scripts/bundle-notes.mjs`, using the same esbuild options as `bundle-daemons.mjs`, built from this worktree's sources. The worktree has no `node_modules`, so esbuild, yaml and zod are resolved read-only from the main checkout's installed tree (`NODE_MODULES_FROM`, default `~/agentOS`). Nothing was installed.

### Guest init (`guest/berth-init.sh`)

libkrun's `init.krun` is PID 1. It mounts `/proc`, `/sys` and `/dev` and execs our init as root, which then does what `entrypoint.sh` does in single-app mode, trimmed to what notes needs:

1. Mounts securityfs, cgroup2 (`nsdelegate`), and tmpfs on `/run`, `/tmp` and `/workspace`. Mounts the `app` virtio-fs share **read only** at `/app`.
2. Runs `node /opt/berth/sdk-node/generate-capability-policy.mjs` in `/app` as root, with `NODE_OPTIONS`/`NODE_PATH` dropped, and writes `/run/berth/capability-policy.json`. It then chowns the policy to `0:10000` with mode 0640 and creates `/run/berth/notes` and `/tmp/notes` for uid 10000.
3. Exports `BERTH_APP_UID/GID=10000`, `BERTH_REQUIRE_ENFORCEMENT=1`, `BERTH_NO_SEMANTIC_FS=1` and the workspace/app entry variables.
4. `rpc` mode: `socat VSOCK-LISTEN:5000,fork EXEC:"agent-init node /app/runtime.mjs"`. Each host connection gets an app process under agent-init, and its stdio is the SDK's line-JSON RPC. The app itself never touches vsock; socat is the root-side relay.
5. `probe` mode: runs `berth-probe` as root, then as the app under agent-init, and exits.

## How to run it

```sh
cd packages/vmm
cargo build --release && codesign --entitlements berth-vmm.entitlements --force -s - target/release/berth-vmm

./scripts/build-kernel.sh         # ~4.5 min, needs ~3 GB free while it runs (ext4 scratch image, deleted after; KEEP_SCRATCH=1 keeps it)
./scripts/build-agent-init.sh     # ~20 s
./scripts/build-rootfs.sh         # ~4 s (plus apk download on first run)

./scripts/run-probe.sh                                              # goal 2 + 4 checks, our kernel
KRUNFW_DIR=/opt/homebrew/opt/libkrunfw/lib ./scripts/run-probe.sh   # same on the stock kernel
KRUNFW_DIR=/opt/homebrew/opt/libkrunfw/lib ./scripts/run-probe.sh BERTH_REQUIRE_ENFORCEMENT=0

node scripts/boot-notes.mjs                  # one boot, console on stderr, JSON result on stdout
RUNS=6 node scripts/boot-notes.mjs           # first + 5 repeats, median
SANDBOX_PROFILE=$PWD/berth-vmm.sb RUNS=6 node scripts/boot-notes.mjs   # under Seatbelt
```

Goal 1 by hand, comparing the stock kernel with TSI off and TSI on:

```sh
A=/Users/ash/berth-wt/libkrun-vm-artifacts
DYLD_LIBRARY_PATH=/opt/homebrew/opt/libkrunfw/lib target/release/berth-vmm --cpus 2 --mem 512 \
    --root $A/rootfs-notes --root-ro -- /usr/local/bin/net-probe
DYLD_LIBRARY_PATH=/opt/homebrew/opt/libkrunfw/lib target/release/berth-vmm --tsi \
    --root $A/rootfs-notes --root-ro -- /usr/local/bin/net-probe      # shows what TSI would give
```

Booting our kernel as a raw Image, with no libkrunfw at all:

```sh
target/release/berth-vmm --kernel $A/kernel/Image --kernel-format 0 \
    --cmdline "reboot=k panic=-1 panic_print=0 nomodule console=hvc0 rootfstype=virtiofs rw quiet no-kvmapf init=/init.krun" \
    --root $A/rootfs-notes --root-ro -- /usr/local/bin/net-probe
```

## Evidence per goal

### Goal 1: launcher, no network (stock kernel)

The guest boots and runs commands: `uname` gives `6.12.109`, `nproc` gives 2, and `free` shows 480 MiB total. With TSI off:

```
2: dummy0: <BROADCAST,NOARP> mtu 1500 qdisc noop state DOWN
--- routes
(end routes)
--- connect 1.1.1.1:443
nc rc=1
wget: can't connect to remote host (1.1.1.1): Network unreachable
```

With `--tsi`, for contrast, `dummy0` comes up as 203.0.113.1/24 and `nc 1.1.1.1 443` **succeeds** (rc 0). That confirms that TSI is direct host egress, and that turning it off is what closes it.

vsock: a guest `socat VSOCK-LISTEN:5000` answered a host connection on the mapped Unix socket (`b'guest-echo: hello from host\n'`).

Caveat: the stock kernel always creates `dummy0` (`CONFIG_DUMMY=y`). It is down, has no address and no route, but "only lo" is only true with our kernel.

### Goal 2: our kernel with Landlock

```
[berth:vm-init] lsm=capability,landlock,yama links=lo
[probe:root] name=landlock_abi result=6 errno=0
```

On the stock kernel the same probe gives `lsm=none links=dummy0 lo` and `landlock_abi result=-1 errno=ENOSYS`.

### Goal 3: agent-init + notes, RPC over vsock

From `node scripts/boot-notes.mjs` (guest console excerpts):

```
[berth:capability-policy] wrote /run/berth/capability-policy.json: writePaths=/dev/null, /tmp/notes, /run/berth/notes, /workspace; readPaths=/usr, /bin, /sbin, /lib, /etc, /proc, /dev, /tmp, /run/berth/notes, /app, /workspace; networkPorts=(none — network denied by default)
[agent-init] landlock restrict_self() status: ruleset=FullyEnforced no_new_privs=true
[agent-init] io_uring and AF_VSOCK sockets refused by seccomp for "notes"
[agent-init] no network capability declared — UDP and raw sockets refused by seccomp for "notes"
[agent-init] running "notes" as uid 10000 (gid 10000, supplementary []) — no longer root
[berth:runtime] "notes" ready
```

The host side got:

```json
{"added":{"id":"1","result":{"id":"41f64705-…"}},
 "listed":{"id":"2","result":{"notes":[{"id":"41f64705-…","text":"hello from the host","completed":false}]}}}
```

### Goal 4: enforcement

`./scripts/run-probe.sh` on our kernel:

| Check | Root, no agent-init (VM wall only) | App uid 10000 under agent-init (both walls) |
|---|---|---|
| Landlock ABI | 6 | 6 |
| write `/etc/x` | `EROFS` (read-only root) | **`EACCES`** (Landlock) |
| write `/workspace/probe-ok` (declared) | ok | ok |
| `connect(1.1.1.1:443)` | `ENETUNREACH` (no NIC, no TSI) | **`EACCES`** (Landlock; no port declared) |
| `io_uring_setup` | `ENOSYS` (compiled out) | `ENOSYS` |
| `socket(AF_VSOCK)` | fd (root may; the daemons need it) | **`EPERM`** (seccomp) |
| `socket(AF_INET, SOCK_DGRAM)` | fd | `EPERM` (seccomp) |

agent-init reported `ruleset=FullyEnforced no_new_privs=true`.

On the **stock** kernel with `BERTH_REQUIRE_ENFORCEMENT=1`, agent-init refuses to start the app: `FATAL: … landlock ruleset status was NotEnforced, not FullyEnforced … refusing to exec unrestricted`. With enforcement not required, the stock kernel shows the seccomp io_uring fix working on its own: as root `io_uring_setup` returns an fd, and under agent-init it returns `ENOSYS`. Our kernel then removes io_uring altogether, so it stays closed even for guest root.

## Measurements

t=0 is the `spawn()` of `berth-vmm` by the benchmark script. "First RPC" is when the `add_note` reply arrives on the host. Each boot is a new VM (2 vCPU, 512 MiB, read-only virtio-fs root, read-only app share) with a new policy compile. The phase marks are host-clock arrival times of guest console lines.

| | First boot | Repeats (n=5) | Median repeat |
|---|---:|---|---:|
| Spawn to first successful RPC | 540 ms | 386, 393, 393, 405, 406 | **393 ms** |
| Same, under the Seatbelt profile | 549 ms | 397, 400, 405, 408, 417 | **405 ms** |
| `berth-vmm` + `/bin/true`, spawn to exit (no app) | 268 ms | 125 to 158 | 136 ms |

Where the ~0.39 s goes (median repeat):

| Phase | ms |
|---|---:|
| Spawn to guest init running (VMM setup, kernel boot, init.krun) | ~110 |
| Policy compile (`node` + 1 MB bundle) | ~140 |
| agent-init (Landlock, caps, seccomp, uid drop) | ~10 |
| SDK runtime start, manifest, app load, `"ready"` | ~130 |
| RPC round trip over vsock | ~5 |

"First boot" is the first VM of a run after the files were written. The host page cache is warm for the rootfs, because this spike cannot flush it without `sudo purge`. So the true cold figure after a host reboot is unmeasured.

Memory, sampled 2.5 s after the first RPC:

| | Value |
|---|---|
| Guest `MemTotal` / used | 479 MiB / ~55 MiB (`MemAvailable` 409 to 439 MiB) |
| `berth-vmm` RSS | 275 to 290 MiB |
| `berth-vmm` physical footprint (`footprint`) | **104 to 107 MiB** |

RSS is misleading here. `vmmap` shows most of it as clean, shared `__TEXT`/`__LINKEDIT` pages of system frameworks and the libkrun, virglrenderer and epoxy dylibs. The dirty footprint is ~105 MiB, and ~87 MiB of that is guest memory the guest has actually touched (`shared memory` region, 512 MiB mapped).

### Compared with the Docker baseline

From `docs/perf/local-boot-baseline.md` on `perf/local-boot-baseline` (same machine, Colima vz, notes app):

| | Docker (warm) | microVM (this spike) |
|---|---:|---:|
| Whole `berth dev` to first RPC | 1.28 s | not comparable (no CLI yet) |
| CLI startup | 0.24 s | not measured (the spike has no CLI) |
| Image build / artifact prep | 0.24 s no-op `docker build` + 0.04 s cache bookkeeping | none per boot |
| Sidecar + container start | 0.17 s | spawn to guest init ~0.11 s (a whole VM and kernel) |
| In sandbox to ready (tini/init, lifecycle flags, context-bus, policy compile, agent-init, runtime) | 0.56 s | ~0.28 s (policy compile + agent-init + runtime; **no context-bus daemon, no lifecycle-flags step, no semantic-fs**) |
| From spawning the sandbox to first RPC | ~0.8 s (sidecar start to first RPC) | **0.39 s** |

In a like-for-like reading, the VM path from "start the sandbox" to "first RPC" is about half the Docker path. Some of that saving comes from work the spike skips (context-bus daemon, lifecycle flags, semantic-fs), and those add maybe 0.1 to 0.2 s back. If the CLI's 0.24 s is added unchanged, a `berth dev` on this path would land at about 0.65 to 0.85 s, against 1.28 s today. That matches the research note's 0.8 to 1.0 s estimate.

Cold: Docker's cold `berth dev` took 254 s, almost all of it compiling daemons in `docker build`. On the VM path the equivalent one-time work is the kernel (~4.5 min in a builder VM; it would be a downloaded, versioned artifact in a release), agent-init (~20 s) and the rootfs (a few seconds after the first `apk` download). Per-app preparation is the esbuild bundle plus a copy, well under a second.

## Stretch goals

**Seatbelt.** `berth-vmm.sb` is `(deny default)`. It allows reads of the system library paths, `/opt/homebrew/opt` and `/opt/homebrew/Cellar` (libkrun and its dylibs), `$ART`, and `packages/vmm`; writes only to `$ART/run` (the vsock sockets); Unix-socket network only, under `$ART/run`; plus `mach-lookup`, `iokit-open`, `sysctl-read` and `ipc-posix-shm`. **HVF needed no extra rule**: VMs boot and pass every check under it, with no measurable overhead (405 ms against 393 ms median). Things we learned:

- dyld aborts (exit 134, no message) unless the profile allows `file-read-data` on the literal path `/`.
- `sandbox-exec` is a platform binary, so dyld strips `DYLD_LIBRARY_PATH` on the way in. The profile allows `/usr/bin/env` so the variable can be set again inside. With `--kernel` (raw Image) no `DYLD_*` is needed at all.
- A virtio-fs share outside the allowed paths (tested with `apps/` in this repo): `berth-vmm: cannot open directory …: Operation not permitted`. The same share without the profile mounts and reads fine in the guest. This is the host-side confinement that libkrun's README says we need, because virtio-fs itself does not confine the guest.
- `sandbox-exec` is deprecated. It still works on macOS 27.

**App directory only, read only.** The app is a separate virtio-fs share mounted read only at `/app`. The root filesystem is also read only (`--root-ro`), and all writable state is guest tmpfs. Guest root writing `/etc/x` gets `EROFS`. Before `--root-ro`, that same probe wrote `/etc/x` straight into the host's rootfs directory.

## Problems and open questions

1. **Kernel selection.** libkrun `dlopen`s `libkrunfw.5.dylib` by bare name, so the dylib route depends on `DYLD_LIBRARY_PATH`, which breaks under hardened runtime and SIP-protected launchers. `krun_set_kernel` with the raw `Image` works and boots just as fast, so ship the Image and pass it explicitly. The command line then becomes ours to maintain; we copied libkrun's default one.
2. **libkrun hangs if a virtio-fs directory can't be opened.** The device opens its directory only when the guest activates it. The failure panics a vCPU thread (`Failed to activate device: BadActivate`) and the process keeps running. `berth-vmm` now checks every share up front, but any later failure (for example a directory removed after the check) would still hang. We should report this upstream.
3. **Ownership on a virtio-fs root.** Host files show up in the guest as uid 501:20 (the host user). The exception is files a guest root wrote, whose ownership libkrun keeps in xattrs. A read-only root makes this mostly harmless, but guest uid 501 owns `/`, `/etc` and `/etc/passwd`. The rootfs should be a built ext4 or erofs image with normalized ownership (research option A), which also avoids APFS case-insensitivity.
4. **The RPC stream shares stdout with the app's console output.** The local context-bus stub prints `[context-bus:local] …` on stdout, in the middle of the JSON framing. The host client skips lines that aren't JSON. This happens in Docker as well; a dedicated fd or socket for RPC would fix it.
5. **One app process per connection.** `socat … fork EXEC:` starts the app when the host connects. That is fine for a spike, but `berth dev` wants the app booted before the first call and then reused. A small relay (or agent-init in "init mode") that owns the app's stdio and bridges it to vsock would do that.
6. **Not yet in the VM:** context-bus-daemon (the runtime falls back to the local no-op, and the bundle also lacks `context_bus.proto`), semantic-fs, the egress broker and its host-side dialer, mesh, multi-app, per-app cgroups, and a writable `/workspace` for `berth dev`. `/workspace` is tmpfs here, so notes don't survive a reboot.
7. **Guest root can still open AF_VSOCK.** That is needed for the daemons. Only the one mapped port (5000, host-initiated) exists today. When more ports are mapped, each one is reachable from anything in the guest running as root, so the host-side end of every port has to authenticate or scope what it accepts.
8. **Builder VMs run with TSI on**, which means direct host networking. They only run our build scripts on Alpine packages, but that is still a host-network-capable VM, so treat it like CI and keep it off in anything that runs user code.
9. **Seatbelt profile scope.** It allows reads of the whole artifacts directory (including other builds) and of all of `/opt/homebrew/opt`. A real profile would allow only this sandbox's rootfs image, app directory and kernel, plus the exact dylibs.
10. **Memory accounting on macOS.** There is no balloon inflate, so the guest keeps whatever it touches up to the configured RAM. Footprint (~105 MiB for notes) is the number to report; RSS is not.
11. **Cold numbers after a host reboot are unmeasured** (that needs `sudo purge`).
12. **agent-init comes from `fix/seccomp-io-uring-vsock`**, not `main`. The spike needs that branch for the vsock refusal. Nothing from it was merged here.

## Recommended next steps

1. Move the kernel build into a pinned builder image (it is already bit-reproducible) and publish `Image` + config + GPL source. Have `berth-vmm` boot it with `krun_set_kernel`; drop the dylib route.
2. Turn the rootfs into a content-addressed ext4 or erofs image, mounted read only, with a per-sandbox overlay disk for `/workspace` state. That fixes the ownership and case-sensitivity problems and gives attestation something to hash.
3. Replace `berth-init.sh` + socat with a small Rust init (or an agent-init init mode) that starts context-bus, creates the per-app cgroups, keeps the app running and relays RPC over vsock.
4. Build the host-side egress dialer behind a vsock port, with the broker's policy enforced on the host too.
5. Generate the Seatbelt profile per sandbox (exact paths). On Linux, do the same with Landlock + seccomp around `berth-vmm`.
6. Add a `local-vm` adapter behind adapter-core that calls `berth-vmm`, and add doctor/attestation fields: `isolation=microvm`, kernel hash, `tsi=false`, `nics=0`.
7. Report the virtio-fs activation hang to libkrun upstream.

## Disk used

About 0.9 GB in `$ART` after cleanup. Of that, 745 MB is the reusable Alpine builder root with gcc and rust, 77 MB is `rootfs-notes`, 46 MB is the kernel and its dylib, and the rest is the app dir and bundles. The build scripts delete the kernel build's ext4 scratch image (2.2 GB at peak) and the agent-init scratch image when they finish. Free space on the data volume stayed between 19 and 23 GB throughout.
