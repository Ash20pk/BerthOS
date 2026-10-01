# microVM runtime: pinned kernel, erofs rootfs, berth-init as PID 1

Date: 2026-10-01. Branch `feat/vm-runtime`: `feat/vm-image` with `feat/vm-guest-init` merged in (29c404a), then the integration commits listed at the end. Machine: Apple M4 (10 cores), 16 GB, macOS 27.0, HVF, libkrun 1.19.6.

This is the consolidated state of Berth's microVM runtime. The three earlier write-ups hold the detail behind each part. Where they disagree with this file, this file is current:

- [`microvm-spike.md`](microvm-spike.md): the libkrun spike. berth-vmm, our kernel, agent-init in a VM, the first enforcement checks.
- [`microvm-image.md`](microvm-image.md): the pinned kernel, the content-addressed erofs rootfs, the state disk, and the libkrun truncation bug.
- [`microvm-guest-init.md`](microvm-guest-init.md): berth-init (PID 1, per-app cgroups, the long-lived relay, the vsock port plan, and the rule for the host side).
- [`microvm-egress.md`](microvm-egress.md): network access (feat/vm-egress): the egress broker in the guest, the host dialer behind vsock 1026, and its threat model.

Artifacts live in `/Users/ash/berth-wt/vm-runtime-artifacts/` (`$ART`, `BERTH_VMM_ARTIFACTS`). The kernel, the download cache, agent-init and the builder roots are APFS clones (`cp -c`) of the image and guest-init branches' artifacts. Nothing big is committed.

## Status

**Since feat/local-vm-runtime, the berth CLI runs this.** `berth vm install`, `berth dev --runtime vm`, `berth mcp --runtime vm`, `berth rpc --runtime vm`, `berth doctor --sandbox vm` and `berth attest` on a VM session. The user-facing page is [`docs/local-vm.md`](../local-vm.md), and the CLI side is described under [The CLI's local-vm runtime](#the-clis-local-vm-runtime) below. Docker is still the default.

| Goal | Result | Evidence |
|---|---|---|
| 1. Rootfs built with the Rust berth-init and context-bus-daemon, no socat, no shell init, reproducible | **Pass** | berth-init `f00ebfc2…` and context-bus-daemon `1138c359…` were rebuilt in the builder VM from this tree, twice, with the same hashes. Rootfs **`57e7ef8b…`** (46,678,016 bytes) came out identical on two builds. It is pinned in `rootfs/manifest.toml`, and the inputs are recorded below |
| 2. Overlaps reconciled | **Pass** | Boot mode, cmdline, cgroup2, state disk and port plan are covered under "Decisions". We also found and fixed a cmdline injection through `--env` |
| 3. End to end | **Pass, 51/51** | `node scripts/e2e.mjs all`: single 18/18, multi 15/15, enforce 12/12, stdio 3/3, exits 3/3 |
| 3. Boot timing | Measured | Two interleaved benchmark runs. The host was at load 4 to 6 throughout (other work, not ours). Single app: median **367 / 372 ms** to the first RPC. Multi: **422 / 441 ms**. The spike's layout in the same rounds: 431 / 434 ms |
| 4. One host command | **Done** | `berth-vmm run --app DIR [--app DIR…] [--state DISK]`, plus `scripts/vm.mjs` (status, call, logs, stop) |
| 5. This document | Done | |
| Egress (feat/vm-egress) | **Pass, 28/28** | `node scripts/e2e.mjs egress`: an app with `network:host:example.com` fetches https://example.com through the in-guest broker and the host dialer; undeclared hosts and internal addresses are refused by the host even with the broker bypassed by guest root. Rootfs **`5f80e448…`** with berth-init **`c82613e7…`** and the broker, reproduced twice; `e2e.mjs all` still 51/51 on it. Details in [`microvm-egress.md`](microvm-egress.md) |

## What boots

```
host: berth-vmm run --app apps/notes --state notes.img
  │  hashes the pinned kernel (8f79e8da…) and rootfs (57e7ef8b…), refusing any mismatch;
  │  restores and digests the state disk; prints the endpoints and measurements lines
  ▼
libkrun 1.19.6 (HVF): 2 vCPU, 512 MiB, no NIC, TSI off,
  vda = rootfs (ro), vdb = state (rw), virtio-fs "app" (ro), vsock 1024/1025/5000+i → Unix sockets
  ▼
kernel 6.12.109 (pinned cmdline: root=/dev/vda rootfstype=erofs ro … init=/sbin/berth-init)
  ▼
/sbin/berth-init, PID 1, from the erofs image
  ├─ mounts, cgroup2 (nsdelegate,favordynmods), state disk → /workspace
  ├─ policy compile (node + the sdk-node bundle in the image), identities, declared paths
  ├─ /berth/daemons: berth-init, context-bus-daemon (agent-init, uid 9001, FullyEnforced)
  └─ /berth/apps/<app>: agent-init → node runtime.mjs, uid 10000+i, own cgroup
```

Everything the guest executes comes from the pinned kernel or the hashed rootfs. The exception is app code on the `/app` share, which is unmeasured (open problem 7).

## Decisions (goal 2)

### Boot berth-init directly, not through init.krun

The pinned command line is now

```
reboot=k panic=-1 panic_print=0 nomodule console=hvc0 root=/dev/vda rootfstype=erofs ro rootwait quiet no-kvmapf rcupdate.rcu_expedited=1 init=/sbin/berth-init
```

and berth-vmm no longer calls `krun_set_root_disk_remount` when it boots the pinned kernel. Reasons:

1. **init.krun forks berth-init over a disk root.** Booted the image branch's way (init.krun, `krun_set_root_disk_remount`), berth-init came up as **pid 209**, logged `running as pid 209, not 1: acting as child subreaper`, and init.krun stayed PID 1. That breaks the PID-1 contract that feat/vm-guest-init was written to: orphans reparent to init.krun, and the guest's signals reach init.krun. Booted directly, `boot_start` reports `"pid":1`.
2. **Measured boot.** init.krun is code inside the host's libkrun dylib, served from a dummy virtio-fs root. It is not in the kernel or rootfs hashes. With direct boot, the measurement line covers everything up to app code.
3. **It is faster.** berth-init's first event is at **43 to 44 ms** of guest uptime when booted directly, against ~70 ms through init.krun (in a single comparison boot).
4. **Nothing is lost.** berth-init already did all of init.krun's work that we use (proc/sys/dev/cgroup2 mounts, reaping, power off), and the guest-init branch had tested it as `init=` over virtio-fs. libkrun's `KRUN_*` variables and `--rlimit`/`--workdir` only mean something to init.krun, so a sandbox does not use them.

init.krun remains for the two other root kinds: builder VMs (libkrunfw's kernel, virtio-fs root, TSI) and the spike's layout, which we keep as a benchmark control. That layout has its own manifest key, `cmdline_virtiofs_root`. berth-vmm picks the key from the root kind, and **both come from the manifest**. A `--rootfs` that is not erofs is refused with the pinned kernel. A guest command other than `/sbin/berth-init` is also refused there, because the kernel would ignore it silently.

### The kernel command line, and what berth-init needs from it

berth-init is configured through its environment, and libkrun appends berth-vmm's `--env` entries to the kernel command line as `K="V"`. The pinned part comes only from the manifest. The guest's needs fit in that space: `BERTH_VM_APPS`, `BERTH_STATE_DEV`, `PATH`, and optional `BERTH_VM_RPC` and friends. A single-app boot uses 301 to 324 bytes of `/proc/cmdline`, now reported as `cmdlineBytes` in `boot_start`.

**A hole, fixed (776641e).** A `"` inside a value ends libkrun's quoting. `--env 'X=1" lsm="yama'` booted with `lsm=capability,yama`, which is Landlock off. agent-init then refused to start the apps (`NotEnforced`, fail-closed), but `init=` could have been replaced the same way. So the pinned command line was only pinned against `--cmdline`, not against `--env`. berth-vmm now requires identifier names, and values with no whitespace, quotes, backslashes or control characters. It also caps the count at 20 (the kernel panics past 31 boot environment words) and refuses a line over `COMMAND_LINE_SIZE` (2048). With short tags, that last check is what limits the app count (about 50; open problem 6).

### cgroup2 remount

When berth-init boots directly, nothing has mounted cgroup2 yet, so berth-init mounts it fresh with `nsdelegate,favordynmods` (falling back to `nsdelegate` alone). The init.krun path remounts with the same options. A failed remount is now logged rather than ignored. `boot_start` carries the resulting options (`"cgroup2":"rw,nsdelegate,favordynmods"`), and the e2e asserts them.

### The state disk contract

berth-vmm's restore of the truncated tail (the libkrun 1.19.6 discard bug, `microvm-image.md`) is in the merged berth-vmm (`pins::open_state`). The e2e's second boot shows `restoredBytes: 65536` after mkfs on the first boot, and the disk mounts. berth-init formats a blank disk `-E nodiscard`, mounts it at `/state`, and binds `/state/workspace` onto `/workspace`. The ownership pass then makes `/workspace` the app's (one app) or `root:berth 2775` (several apps).

The measurement line now **measures the disk too**: `chunkedSha256` is SHA-256 over per-MiB chunk hashes. A chunk with no data extent (`SEEK_DATA`/`SEEK_HOLE`) is known to be zeros and is not read. The digest depends only on the bytes, not on how the file happens to be allocated, and costs what the data costs: 38.8 MB read and 15 to 20 ms for a 256 MiB disk with notes on it, against 0 ms for a new disk. It is taken after the restore and before the guest can write.

### Port plan

1024 control, 1025 logs, 5000+i RPC for app i, all in listen mode. berth-init serves this plan. **1026 egress** (feat/vm-egress) is the one port where the guest connects out: berth-vmm's egress dialer listens on `<run-dir>/egress.sock`, and the port is mapped only when `run` is given `--egress-allow` ([`microvm-egress.md`](microvm-egress.md)). `berth-vmm run` maps it to `control.sock`, `logs.sock` and `rpc-<i>.sock`, and the shell init's 5001 stop port is gone with the shell init. The e2e and `scripts/vm.mjs` follow the host-side rule from `microvm-guest-init.md`: every line is bounded, parsed as a JSON object and shape-checked, and nothing from the guest picks an action.

## How to build

Nothing is installed on the host. Every compiler runs in a builder VM (libkrunfw's kernel, TSI on, its own Alpine root under `$ART/builders/`).

```sh
cd packages/vmm
export BERTH_VMM_ARTIFACTS=/Users/ash/berth-wt/vm-runtime-artifacts   # the default, next to the worktree
./scripts/build-kernel.sh       # only if kernel/ changes: 5 to 9 min, ~2.2 GB scratch (deleted after)
./scripts/build-agent-init.sh   # agent-init + berth-probe
./scripts/build-berth-init.sh   # cargo test (19), static berth-init + context-bus-daemon, ~60 s warm
./scripts/build-rootfs.sh       # erofs image → $ART/rootfs/rootfs-<sha256>.erofs (+ .inputs.json, .tree.txt)
./scripts/build-apps.sh         # app shares → $ART/apps/{notes,notes-plain,filesystem,probe}
```

After a rootfs change, put the new hash in `rootfs/manifest.toml` (`image_sha256`, `image_size`, and the berth-init and context-bus-daemon hashes) and rebuild berth-vmm. It compiles both manifests in.

### Pinned artifacts and inputs

| | sha256 | Inputs |
|---|---|---|
| kernel `Image` | `8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8` | unchanged: linux 6.12.109 + libkrunfw 5.6.2 + `berth-kernel.config` (`kernel/manifest.toml`) |
| rootfs (current, feat/vm-artifacts-release) | `47e1ea51bb54411e8a5ff9ec37296f254cd84d3c12ad7d0d12c0d9c2b6fe7e23` (46,723,072 B) | `5f80e448…` below with the sdk-node bundles made independent of the build machine's paths, and Alpine's `nghttp2-libs` 1.70.0-r0 (was 1.69.0-r0). Reproduced from fresh builder roots and rebuilt in CI ([`microvm-image.md`](microvm-image.md#distribution)) |
| rootfs (feat/vm-egress) | `5f80e448b6658cb14612dcc5534fcf495c6dd31a687822f9234859b1643c9579` (46,727,168 B) | `57e7ef8b…` below plus `/usr/local/bin/berth-egress-broker.cjs` (`4ff162e8…`), with berth-init `c82613e7…` ([`microvm-egress.md`](microvm-egress.md)). Not reproducible elsewhere: see `microvm-image.md` |
| rootfs (feat/vm-runtime) | `57e7ef8b56a30280beeb2f96eb77c35b0e2fcd0c585e9259e2899d47e565bf0d` (46,678,016 B, erofs lz4hc, 82.8 MB tree) | Alpine 3.24.2 minirootfs `9bf70a7f…`; `nodejs` 24.18.1-r0, `e2fsprogs` 1.47.4-r0 (+ deps; `inputs.json` has the resolved list); agent-init `9ec8b25e…` (fix/seccomp-io-uring-vsock @ c558ef8); berth-probe `6ec735d8…`; sdk-node bundles from feat/per-app-cgroups @ 28b0999 (`generate-capability-policy.mjs` `17618463…`); epoch 1790812800, fixed UUID |
| `/sbin/berth-init` (current) | `c82613e72a1bc0445a18cd2b63822a7aab0f482dbf7ceb574ef0fa0fddf1b572` | feat/vm-egress: the egress broker and the relay to vsock 1026 |
| `/sbin/berth-init` (feat/vm-runtime) | `f00ebfc2bec72c6693f76cbc54a111e4c709cc1afd49a80f4164708707ea50a9` | `packages/vmm/init` at this branch, Alpine's rust, static musl, `Cargo.lock` committed |
| `/usr/local/bin/context-bus-daemon` | `1138c3595142a3235145b530d0cf1157b0971aa2230d417befe0a6e783477544` | `packages/context-bus-daemon` at this branch's HEAD |

Before the rootfs, we rebuilt berth-init from the merge commit's source. It came out bit-identical to feat/vm-guest-init's binary (`50940a85…`), so the merge changed nothing in it. The two later commits to `init/` (the boot report and the remount warning) gave `f00ebfc2…`, reproduced twice.

## How to run

```sh
cd packages/vmm
export BERTH_VMM_ARTIFACTS=/Users/ash/berth-wt/vm-runtime-artifacts
A=$BERTH_VMM_ARTIFACTS
./target/release/berth-vmm run --app $A/apps/notes --state $A/state/notes.img --run-dir $A/run/notes &
node scripts/vm.mjs call   $A/run/notes notes add_note '{"text":"hello"}'
node scripts/vm.mjs call   $A/run/notes 0 list_notes
node scripts/vm.mjs status $A/run/notes        # apps, pids, uids, cgroups and limits
node scripts/vm.mjs logs   $A/run/notes        # follow the log port
node scripts/vm.mjs stop   $A/run/notes        # stop apps, sync, unmount, power off; berth-vmm exits 0

./target/release/berth-vmm run --app $A/apps/notes --app $A/apps/filesystem   # multi: tags notes, filesystem
./target/release/berth-vmm run --help
```

`berth-vmm run` takes care of:

- **Artifacts.** It takes the kernel at `<artifacts>/kernel/sha256/<pin>/Image` and the rootfs at `<artifacts>/rootfs/rootfs-<pin>.erofs`, with both pins compiled in. `<artifacts>` is `--artifacts`, else `$BERTH_VMM_ARTIFACTS`, else `~/.berth/vm`, the planned download cache. `--rootfs` boots another content-addressed image, which the measurement line then reports as `"pinned": false`.
- **Apps.** Each `--app` directory is shared read-only. A single app gets tag `app` at `/app`. Several apps get their directory names as tags, at `/app/<tag>`. Order fixes uid 10000+i and port 5000+i. Every directory must hold `berth.yml`.
- **The run directory** (`--run-dir`, default `$TMPDIR/berth-vmm-<pid>`, mode 0700) holds `control.sock`, `logs.sock`, `rpc-<i>.sock` and `console.log`. Socket paths are checked against macOS's 104-byte limit, and stale sockets are removed before boot.
- **Defaults:** 2 vCPUs, 512 MiB (1024 for several apps), and a 1 GiB state disk created sparse if missing.
- **Before the VM starts**, it prints one `endpoints` line on stderr. This is what the CLI's local-vm adapter reads:

```json
{"source":"berth-vmm","event":"endpoints","runDir":"…/run/notes","control":"…/control.sock","logs":"…/logs.sock",
 "rpc":[{"index":0,"tag":"app","app":"…/apps/notes","port":5000,"socket":"…/rpc-0.sock"}],"console":"…/console.log"}
```

…followed by `vm_config` and the measurement line (a boot on an existing state disk):

```json
{"source":"berth-vmm","event":"measurements",
 "kernel":{"sha256":"8f79e8da…0ec8","pinned":true,"linux":"6.12.109","configSha256":"e3f33c2b…","cmdline":"… root=/dev/vda rootfstype=erofs ro … init=/sbin/berth-init","hashMs":16},
 "rootfs":{"sha256":"57e7ef8b…bf0d","pinned":true,"fstype":"erofs","readOnly":true,"hashMs":24},
 "state":{"chunkedSha256":"d9200eb6…6a9c","chunkBytes":1048576,"path":"…/single-state.img","sizeBytes":268435456,"created":false,"restoredBytes":65536,"hashMs":20,"hashedBytes":38797312}}
```

The low-level form (`berth-vmm --kernel … --rootfs … --share … --vsock …`) is still there. It is what `run` expands to, and what builder VMs use.

### Tests

```sh
node scripts/e2e.mjs all            # single, multi, enforce, stdio, exits (51 checks)
ROUNDS=6 node scripts/e2e.mjs bench # interleaved: single, single+state, multi, spike layout
```

The `probe` app (`guest/probe-app`, test-only, never in `apps/`) runs `berth-probe` as its own child, so the enforcement probe sees exactly what an app's process tree gets. It also reports ids, cgroup, mounts, ownership and the context-bus events delivered to it.

## End to end (goal 3)

All on kernel `8f79e8da…`, rootfs `57e7ef8b…`, berth-init `f00ebfc2…`, through `berth-vmm run`. Results are in `$ART/run/e2e-*.json`.

**Single (notes, new 256 MiB state disk), 18/18.**
- Boot 1 formats the disk. `add_note`, then four more on one connection, then a second concurrent connection: 7 notes, and the app pid is the same throughout (233 → 233).
- The RPC streams carry only RPC (0 stray lines). The app's stderr arrives on the log port. Landlock is `ruleset=FullyEnforced`.
- berth-init is pid 1. cgroup2 is mounted `rw,nsdelegate,favordynmods`.
- The measurement line has all three hashes.
- `{"op":"shutdown"}` on control: berth-vmm exits 0 after 36 to 46 ms, with `unmountFailed: []`.
- Boot 2 on the same disk: no format, `restoredBytes: 65536`, `list_notes` returns all 7 notes including "survives a reboot". The state digest changed between boots (`a8a56a25…` for the new disk, then `ac522b10…`).

**Multi (notes + filesystem + probe), 15/15.**
- uids 10000, 10001 and 10002, three processes. Each app is in `/berth/apps/<name>` with its limits read back: notes `cpu.max 50000 100000, memory.max 167772160, pids.max 256`; filesystem `cpu.max 100000 100000, memory.max 201326592`; probe gets the defaults (`pids.max 1024`).
- Inside probe: `/proc/self/cgroup` = `0::/berth/apps/probe`, uid 10002, groups [9999, 10002]. passwd has `berth-notes`, `berth-filesystem`, `berth-probe` and `berth-context-bus`, written at boot.
- context-bus-daemon runs as uid 9001, `FullyEnforced`, in `/berth/daemons` with berth-init. It registered each app by its peer identity.
- **It works:** filesystem's `write_file` published `fs.file_created`, and probe, subscribed through the daemon, received `{"path":"hello.txt","createdBy":"filesystem"}`.

**Enforce (probe app, as uid 10000 under agent-init), 12/12.**

| Check | Result |
|---|---|
| Landlock ABI | 6 |
| write to declared `/workspace` (state disk) | ok |
| write to `/tmp/probe-ok` (`/tmp` is `0:0 1777`, so DAC allows it and only Landlock can refuse) | **EACCES** |
| write to `/dev/shm/probe-ok` (also 1777) | **EACCES** |
| write `/etc/x` | EROFS (the read-only image answers first) |
| `connect(1.1.1.1:443)` | **EACCES** |
| `io_uring_setup` | **ENOSYS** |
| `socket(AF_VSOCK)` | **EPERM** |
| `socket(AF_INET, SOCK_DGRAM)` | **EPERM** |

**stdio 3/3** (`BERTH_VM_RPC=stdio`: two connections multiplexed onto one app process). **exits 3/3**: an app that throws at load powers the VM off by itself (`every app has exited`, exitCode 1). A refused configuration is reported as `boot_failed` on control, and then the VM powers off.

## Measurements

t=0 is `spawn(berth-vmm run)`. The figure is when every app's first RPC answer reaches the host. 2 vCPUs, 512 MiB (1024 for multi), a new VM and a new policy compile each boot. Each run is 6 interleaved rounds of the four configurations. The first round is a warm-up, and the median is over the other 5. **The host was loaded:** the 1-minute load average was 5.3 to 5.9 during run 1 and 4.1 to 4.4 during run 2, on 10 cores, from work outside this branch. So the absolute numbers are high, and the spike layout row, measured in the same rounds, is the control.

| Configuration | Run 1 repeats (ms) | median | Run 2 repeats (ms) | median |
|---|---|---:|---|---:|
| single: notes-plain, tmpfs `/workspace` | 372 374 365 413 360 | **372** | 391 356 370 364 367 | **367** |
| single + state disk (existing, 256 MiB) | 390 387 385 477 380 | **387** | 417 378 407 447 388 | **407** |
| multi: notes-plain + filesystem | 419 399 513 528 441 | **441** | 422 403 416 431 434 | **422** |
| spike layout: virtio-fs root, init.krun + shell init + socat, same pinned kernel | 421 434 546 526 434 | 434 | 433 422 431 417 455 | 431 |

Relative to the control in the same rounds, the single-app boot is **0.85×** the spike's layout. It does more than the spike did: a confined context-bus-daemon the app connects to, per-app cgroups, identities, and the kernel, rootfs and state hashes. The spike measured 393 ms on a quiet host. Scaled by this control, today's single-app boot would be about 0.33 s on a quiet host. That is an estimate, not a measurement. Multi costs about 50 to 70 ms over single: a second policy compile in parallel, and a second node start.

Where the time goes (guest uptime, median runs from run 1):

| Phase | single | single + state | multi |
|---|---:|---:|---:|
| berth-init's first event (`boot_start`) | 44 | 52 | 65 |
| mounts (state disk: +5) / cgroups | 44 / 44 | 57 / 58 | 66 / 76 |
| policies compiled | 149 | 144 | 191 |
| identities, context-bus-daemon up | 150 / 156 | 144 / 150 | 191 / 197 |
| apps ready | 285 | 282 | filesystem 339, notes 352 |

Host side before boot: kernel hash 8 to 16 ms, rootfs hash 17 to 24 ms, state digest 15 to 20 ms (0 for a new disk). Shutdown on request takes 35 to 46 ms to berth-vmm's exit.

## The CLI's local-vm runtime

Branch feat/local-vm-runtime. The code is in `packages/cli/src/vm/`. berth-vmm and berth-init are unchanged: the CLI reads and drives what they already print and serve.

**Where it lives, and why not adapter-core.** `DeployAdapter` (`packages/adapters/adapter-core`) takes a Docker image reference (`upload(imageRef)`, `start(remoteImageRef)`) and is used only by `berth deploy`, for remote providers. `berth dev` and `berth mcp` don't go through it: they drive docker-orchestrator directly (`bootDevContainer`, `createStdioRpcClient`, `gatherBootEvidence`). A local VM consumes no image and needs dev's and mcp's hooks (hot reload, ready waiting, RPC, boot evidence), so it is a runtime alongside docker-orchestrator, selected by `--runtime vm`. `berth mcp` reuses its background-sandbox state machine (`util/mcp-sandbox.ts`) unchanged, with VM steps behind `SandboxSteps`. The RPC framing is docker-orchestrator's, split out as `createLineRpcClient`.

| Open problem (below) | What the CLI does now | Still open |
|---|---|---|
| 1. Artifacts | `berth vm install` copies from a build directory or downloads from a sha256-keyed URL template, hashes each file against its pin before renaming it into berth-vmm's layout, and runs automatically on the first VM boot. The pins are read out of the berth-vmm binary's compiled-in manifests, so the CLI installs what berth-vmm will accept even when the two were built apart. `berth doctor` checks the hypervisor, berth-vmm's entitlement (and prints the `codesign` fix), the pins, and libkrun's version | Done since: the default URL is the GitHub release `vm-artifacts.yml` publishes, and berth-vmm is downloaded when the CLI pins it. Open: notarizing berth-vmm; libkrun still comes from the Homebrew tap |
| 2. Bundling | esbuild bundles the app and the SDK runtime into the share layout. esbuild and the SDK come from the project, or from the CLI's own dependencies, so a `berth init` project outside the repo works without `npm install`. Cached by content (the files esbuild read, `berth.yml`, and the source listing): 9 ms on a hit, 125 to 180 ms on a miss | Native addons can't work (refused with a clear error); files the app reads from its own directory at run time aren't in the share |
| 3. Lifecycle | `berth-vmm run` is spawned detached, with its run dir under `~/.berth/run/vm/<name>/` (pid file, `vm.json`, `vmm.log`). Ready means every app's `app_ready` on control, with greeting-or-retry. A boot that fails (berth-vmm refusing, `boot_failed`, an app exiting) is reported with berth-vmm's own words. Stop is `{"op":"shutdown"}`, then SIGKILL after a timeout, and the sockets are cleaned up. Reattach goes by the pid file and record: a run dir whose pid is dead, or whose pid is no longer that run dir's berth-vmm (checked with `ps`), is stale and cleaned. The process that started a VM pumps `logs.sock` (one reader at a time) into `guest.log` for everyone else | A VM orphaned by a CLI that was SIGKILLed keeps running until the next `berth dev` or `berth vm stop` |

**Hot reload is a VM reboot.** The guest would see a new bundle on the virtio-fs share, but berth-init's control port has no restart op, and adding one means a new berth-init, rootfs and pin. A reboot costs 366 to 405 ms here, and it also recompiles the policy, which matters for a `berth.yml` change. A save that leaves the bundle unchanged doesn't reboot at all.

**Attestation.** The evidence sources are listed in [`attestation-reference.md`](../attestation-reference.md#a-microvm-boot). The record gains `boot.isolation`, an extension field, so existing records and verifiers are unaffected. `policies` is empty until berth-init reports the compiled policy's sha256.

**Egress.** When berth-vmm's `run --help` offers `--egress-allow` (feat/vm-egress), the CLI passes the apps' `network:host:` and `browser:navigate:` scopes verbatim, allows `network:host` and `network:connect` apps (at most one per sandbox), and prints the dialer's `egress` lines in `berth dev`. Without it, network apps are refused before boot.

Measured with `packages/cli/test/vm-e2e.mjs` (17/17) on the M4 at load 5 to 8, each over 3 runs:

| | |
|---|---|
| `berth dev --runtime vm`, first boot (bundle miss + boot) | 581 to 603 ms; boot alone 401 to 425 ms |
| reload after a real edit (bundle + stop + boot) | median 537 to 558 ms (bundle 124 to 171, stop 35 to 39, boot 366 to 405) |
| `berth mcp --runtime vm`, spawn → first `tools/call` answered, booting its own VM | 625 to 851 ms (median 658 and 788 in two runs); `initialize` alone about 300 ms |
| the same, attaching to a running `berth dev` VM | 256 ms |
| Docker path, same span, warm image | about 1.6 s (not re-measured here) |

## Open problems

Ordered by how much each one blocks a `local-vm` adapter in the berth CLI. Problems 1 to 3 are now handled by the CLI. What is left of them is in the table under [The CLI's local-vm runtime](#the-clis-local-vm-runtime).

1. **Artifacts have to reach the user.** Done: `.github/workflows/vm-artifacts.yml` rebuilds the kernel and rootfs from source, checks them against the pins and publishes them with berth-vmm as a GitHub release, and `berth vm install` downloads and verifies them (`microvm-image.md`, "Distribution"; [`../local-vm.md`](../local-vm.md#install)). Still open: berth-vmm is ad hoc signed, not notarized, and it links Homebrew's `/opt/homebrew/opt/libkrun` at exactly 1.19.6, which the user installs.
2. **Apps have to be bundled.** An app share is `berth.yml` + `dist/index.mjs` (the app with the SDK and zod inlined) + `runtime.mjs` + `proto/context_bus.proto`. `build-apps.sh` makes these with esbuild from another checkout's `node_modules`. The CLI needs that step for `berth dev`: either bundle at run time, or ship the runtime bundle and bundle only the app.
3. **Lifecycle and readiness are the adapter's job.** `berth-vmm run` stays in the foreground and gives no ready signal of its own. Readiness is `app_ready` / `boot_complete` on control. libkrun accepts a connection before the guest listens, so every client must use greeting-or-retry (as `vm.mjs` and `e2e.mjs` do). A stop needs the guest to cooperate, with SIGKILL after a timeout (only the ext4 journal protects state then). There is no reattach, pid file or `ps` for a running sandbox, and the sockets stay in the run directory after exit.
4. **Missing parts of entrypoint.sh** (`microvm-guest-init.md`, open problem 3). The egress broker and the host-side dialer are done (feat/vm-egress, [`microvm-egress.md`](microvm-egress.md)); the GitHub API broker, upstream proxy chaining and the mesh are not. Also missing: secrets, governance gate, semantic-fs (`BERTH_NO_SEMANTIC_FS=1`), browser display, and python apps (and python3 is not in the image). An app needing any of these cannot run in a VM yet.
5. **The guest environment is world-readable inside the guest.** It travels on the kernel command line, and the probe app (uid 10002, Landlock read on `/proc`) could read `/proc/cmdline`. Never pass a secret with `--env`. Secrets need their own channel, such as a vsock port or a file on a disk.
6. **Command-line budget.** At most 20 `--env` entries and 2048 bytes in all. `BERTH_VM_APPS` grows with the tags, so the practical app limit is about 50 with short names (berth-init's own limit is 64). Passing configuration on a small config disk or a vsock handshake would remove both limits.
7. **`/app` is unmeasured** and shows host uid 501 inside the guest (virtio-fs, no idmap). That is fine for `berth dev`. Attested and deployed runs want a hashed per-app erofs layer, measured like the rootfs.
8. **The measurement line is unsigned**, and nothing consumes it. The state digest is taken at boot only. A shutdown digest would let the next boot prove continuity.
9. **The Seatbelt profile (`berth-vmm.sb`) is not applied** by `run`. It should allow exactly this sandbox's kernel, image, app dirs, state disk and run directory.
10. **Rebuilds depend on live repositories.** The rootfs takes the newest Alpine v3.24 packages (open problem 3 in `microvm-image.md`), and berth-init takes Alpine's current rust plus crates.io. Content addressing makes a drift visible, but an exact old rebuild needs a pinned apk cache and vendored crates. Builder VMs still run with TSI on libkrunfw's unpinned kernel.
11. **libkrun truncates the state disk on a tail discard** (worked around, `microvm-image.md` problem 1). Report it upstream.
12. **Timing on a quiet host** is still unmeasured: load was 4 to 6 in every round. With `--console-stderr`, libkrun prefixes every console line with a log header (`ERROR init_or_kernel`), so `run` writes the console to `console.log` by default.

## Commits

On top of the merge (29c404a):

```
build(vmm): build berth-init in the shared artifacts layout
feat(vmm): boot berth-init as PID 1 straight from the kernel
feat(init): report the cgroup2 options and command line size at boot
fix(vmm): refuse a guest environment that escapes the kernel command line
feat(vmm): measure the state disk by content and pin the base rootfs
feat(vmm): add berth-vmm run, one command for a sandbox from the pinned artifacts
build(vmm): put the Rust berth-init and context-bus-daemon in the rootfs
test(vmm): app directories for the image, and a probe app
test(vmm): end-to-end checks on the pinned kernel, erofs rootfs and berth-init
build(vmm): pin rootfs 57e7ef8b with berth-init f00ebfc2 and context-bus-daemon
feat(vmm): a small client for a berth-vmm run sandbox
docs: consolidate the microVM runtime write-up
```

The fix commit (776641e) also carries the deletion of `guest/berth-init.sh`. It was staged early, and we did not rewrite the commit to move it.

## Disk

`$ART` is 1.0 GB by `du`, but most of it is APFS clones of the image and guest-init branches' artifacts: builder roots 795 MB, download cache 147 MB, kernel 23 MB. Space that is really new: the rootfs and its records (45 MB), app shares (19 MB), the berth-init build outputs (2 MB), and the e2e run directory. The scratch build disks (4 GB sparse each) were deleted after every build. Free space on the data volume stayed at 19 to 20 GB from start to finish.
