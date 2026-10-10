# semantic-fs in the microVM

Status: steps 1 to 4 done (feat/vm-semantic-fs-build, -init, -cli, test/vm-semantic-fs-e2e); step 5, the release, to go. Closes the semantic-fs part of open problem 4 in [`microvm-runtime.md`](microvm-runtime.md#open-problems) and of open problem 3 in [`microvm-guest-init.md`](microvm-guest-init.md), and the "semantic-fs and `/context`" limit in [`../local-vm.md`](../local-vm.md#limits).

## Context

semantic-fs gives a sandbox's apps a shared `/context` directory whose files are indexed, so apps can tag them and query them by keyword and by meaning. This design brings it into the microVM. It involves the apps that declare a `/context` scope, berth-init, which starts the daemon, the state disk that keeps the data, and the CLI, which refused such apps before.

### The problem

An app that declares `filesystem:read:/context` or `filesystem:write:/context` is refused before a VM boot (`packages/cli/src/vm/support.ts:44`). `apps/filesystem` declares both, so the app most demos and the LangChain e2e scenarios use cannot run with `--runtime vm`.

In the guest today:

- berth-init mounts a plain tmpfs on `/context` (`packages/vmm/init/src/main.rs:369`). Files written there are not indexed and don't survive a reboot.
- No semantic-fs daemon runs, and berth-init sets `BERTH_NO_SEMANTIC_FS=1` for every app (`main.rs:679`). Only `entrypoint.sh` reads that flag. In the guest the SDK sees `BERTH_BOOT_ID`, finds no socket at `/tmp/berth-semantic-fs.sock`, and hands the app a client whose `tag` and `query` throw (`packages/sdk/src/runtime.ts:59-70`).

## Containers

<p align="center"><img src="../images/c4/design-microvm-semantic-fs.svg" alt="semantic-fs containers in the guest: berth-init starts the semantic-fs daemon as root before any app, and starts the embeddings daemon under agent-init when an app declares /context. An app reads and writes files through the FUSE mount at /context and sends tag and query requests over the daemon's Unix socket; its SDK gets embeddings from the embeddings daemon over embed.sock. The daemon keeps its files and SQLite index on the state disk under /state/context, or on a tmpfs under /run/berth/context without one." width="100%"></p>

The daemon is one process that serves the apps two ways, a FUSE mount and a control socket. In the guest, berth-init starts it, and an embeddings daemon runs beside it ([section 7](#7-embeddings)).

### What semantic-fs is today

`packages/semantic-fs-daemon` is a static Go binary (`CGO_ENABLED=0`; `bazil.org/fuse`, `modernc.org/sqlite`, `golang.org/x/sys`; go 1.26). It does two things:

- **A FUSE passthrough** at `BERTH_CONTEXT_MOUNT` (`/context`) over a real directory, `BERTH_CONTEXT_DATA`. Apps read and write file contents through ordinary file calls. Create, write and truncate are recorded in the index with the writing app as `created_by`. New files are `root:berth` with group bits mirroring owner bits; directories are setgid (`internal/fusefs/ownership.go`).
- **A control socket** at `BERTH_SEMANTIC_FS_SOCKET` (`/tmp/berth-semantic-fs.sock`, `root:berth` 0660). Frames are a length prefix plus JSON, and the ops are `register`, `tag` and `query`. The caller is identified by `SO_PEERCRED`: a uid whose user is `berth-<app>` is that app. Tags and optional embeddings live in SQLite at `BERTH_CONTEXT_INDEX_DB`. Search is keyword hits over the tag text, plus cosine similarity when an embedding from the same model is stored.

Embeddings are computed in the app, by the SDK (`@xenova/transformers`, `all-MiniLM-L6-v2`, model files baked into `packages/sdk/models`). When that fails, requests go without an embedding and ranking is keyword-only. The daemon only stores vectors.

In Docker the daemon starts as root from `entrypoint.sh`, outside agent-init, because Landlock forbids `mount(2)`. After mounting it narrows its own capabilities to `CHOWN`, `DAC_OVERRIDE`, `FOWNER` and `FSETID`, sets `no_new_privs`, and logs `post_mount_caps_narrowed`. Its uid stays 0, a residual `internal/privs` already names. Since the sandbox no longer has `CAP_SYS_ADMIN`, the mount happens in a sidecar container by default (`semantic-fs-sidecar.ts`). Data does not outlive the sandbox: the sidecar's volumes are removed on stop, and only `berth snapshot` carries it over.

## Components

The design, section by section: how the daemon starts, how it mounts, where its data lives, how it names callers, how it is built and pinned, what the CLI changes, and where embeddings come from.

### Design

The guest needs none of the Docker workarounds. berth-init is PID 1 and root, the kernel is ours, and no AppArmor profile stands in the way. So the same daemon runs inside the guest, started by berth-init, with no sidecar.

#### 1. The daemon, started by berth-init

A `start_semantic_fs` in berth-init's daemons phase, modelled on `start_context_bus` (`main.rs:737-806`), with these differences:

- **It runs as root, not under agent-init.** It has to mount. This is the same trust as in Docker, and it relies on the daemon's own post-mount narrowing. berth-init puts it in the `/berth/daemons` cgroup like the other daemons, tracks it in `sup.daemons` for reaping and shutdown, and forwards the daemon's `post_mount_caps_narrowed` line as a `daemon_started` event on control. A failed narrowing is reported, not hidden.
- **It starts before the precreate pass and before any app.** It replaces the tmpfs mount at `main.rs:369`. berth-init waits for a `fuse` entry for `/context` in `/proc/mounts`, as `entrypoint.sh` does.
- **A failure to mount is a boot failure** whenever any app declares a `/context` scope. Docker only warns and leaves the app to throw at its first query. The VM is new enough to be strict from the start.
- **`/context` leaves `fresh_mounts`.** The precreate pass must not chown the FUSE root to an app (`plan.rs:178-200`). Ownership under `/context` is the daemon's job (`Normalize` at boot, group `berth` on every create).
- **berth-init stops setting `BERTH_NO_SEMANTIC_FS=1`** in `app_env`. The SDK already finds the socket at its default path, so apps need no new variable.

**Recommendation: start it on every boot where the binary exists,** as context-bus is, rather than only when an app declares `/context`. The `tag` and `query` ops don't need a `/context` capability, and an app shouldn't get a different SDK depending on its neighbours. That holds only if the boot cost is small. Measure it in step 2, and fall back to starting it only when needed if it adds more than about 50 ms.

#### 2. Mounting: fusermount3, without its setuid bit

`bazil.org/fuse`'s `Mount()` always execs `fusermount3`, even as root. The Docker image installs it from Alpine's `fuse3` package (`base.Dockerfile:81-84`).

**Recommendation:** add `fuse3` to `rootfs/packages.txt`, locked in `rootfs/apk.lock` like everything else, and have `build-rootfs.sh` remove the setuid bit (`0755 root:root`). Root doesn't need it. Apps run with `no_new_privs`, so the bit would be inert for them anyway, but a setuid-root binary that no one uses has no place in a measured image.

The alternative is a small change to the daemon: open `/dev/fuse` and call `mount(2)` directly when it is root. That drops the package entirely but forks the Docker and VM paths for the same binary. Keep it in reserve if `fuse3` brings in more than it should.

The kernel side is already there: `CONFIG_FUSE_FS=y` is in `kernel/berth-kernel.config:23`. berth-init mounts devtmpfs (`main.rs:307`), so `/dev/fuse` should appear by itself. That is inferred, not yet seen in a guest; step 2 checks it.

#### 3. Where the data lives: the state disk

The daemon's defaults, `/var/berth/context-data` and `/var/berth/context-index.db`, sit on the read-only erofs root. berth-init overrides them:

- **With a state disk:** `BERTH_CONTEXT_DATA=/state/context/data` and `BERTH_CONTEXT_INDEX_DB=/state/context/index.db`. That is the same ext4 disk that already holds `/workspace` (`main.rs:550-574`).
- **With `state: false`:** a tmpfs under `/run/berth/context`.

**This is a deliberate difference from Docker.** There, `/context` is gone when the sandbox stops unless you snapshot it. In the VM, `/context` persists across boots with the state disk, like `/workspace` already does. Shared context is meant to be cumulative, and keeping it in line with `/workspace` in the same runtime is less surprising than matching Docker's teardown. `docs/local-vm.md` says so. `berth snapshot` for VMs is a separate, later item.

The index uses `journal_mode=TRUNCATE`, one file, which an ext4 journal plus a SIGKILL after the shutdown timeout leaves consistent at worst to the last committed transaction.

#### 4. Identity and access

No change is needed:

- berth-init already writes `berth-<app>` users into `/etc/passwd` (`plan.rs:349`), so `SO_PEERCRED` names the caller.
- The guest has one pid namespace, so the pid-based `created_by` lookup works without `BERTH_APP_UID_MAP`, which only the sidecar needs.
- Apps reach the socket through membership of the `berth` group (9999). Landlock doesn't hook connecting to a pathname socket (`generate-capability-policy.ts:58-74`). Check in step 4 that every VM app carries 9999 as a supplementary gid, as the context-bus socket already requires.
- `/context` scopes already compile in the guest, by both the Node and Python compilers (`capability.ts:53`, `berth_sdk/manifest.py:151`).

#### 5. Building and pinning the binary

No VM builder has Go today. Add `guest/build-semantic-fs-in-vm.sh`, run by the same Alpine builder as `build-berth-init-in-vm.sh`, with these settings:

- `apk add go`, pinned in its own `guest/semantic-fs.apk.lock`. Alpine 3.24's `go` must be at least the `go.mod` version (1.26). Check that first.
- `CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -trimpath -buildvcs=false -ldflags='-s -w -buildid='`. Modules are fetched once and checked against `go.sum`.
- The result is checked against a new `semantic_fs_daemon_sha256` pin in `rootfs/manifest.toml`, then added to `build-rootfs.sh`'s check loop, its `install` list and `build-inputs.json`, and to the vm-artifacts `guest` job.

Fetching modules from the Go proxy is a live dependency, like the apk and crates.io ones open problem 10 already records. `go.sum` makes a drift visible, and vendoring is the same later fix.

#### 6. The CLI

- Delete the `/context` refusal in `support.ts:44` and its test case.
- `docs/local-vm.md`: remove the limit, and add the persistence note from section 3.
- No new flags.

#### 7. Embeddings

Done since (feat/vm-embeddings), and not the way first assumed. Loading the model in each app, as a container does, failed twice over: `@xenova/transformers` needs `__filename` (undefined in an app's ES-module bundle) and the model isn't in an app's share; and once both were fixed, loading it takes about 200 MB per process (measured: 38 MB of node, 245 MB with the model, 265 MB peak), more than a default VM gives its apps together after berth-init's daemon reserve. `notes`, which never queries `/context`, was OOM-killed too, because the SDK warmed the model in every app.

So the sandbox has one model:

- **The kit** is in the rootfs at `/usr/share/berth/embeddings` (`scripts/bundle-embeddings.mjs`, pinned as `embeddings_sha256`): transformers bundled into one ES module whose banner defines `require`, `__filename` and `__dirname`, onnxruntime's single-threaded SIMD WASM, the quantized model, and the daemon.
- **The daemon** (`guest/embeddings-daemon.mjs`) runs as `berth-embeddings` (uid 9004) under agent-init when an app declares `/context`, serves `/run/berth/embeddings-daemon/embed.sock` to the berth group, and loads the model on its first request (463 ms in the guest).
- **Apps** get `BERTH_EMBEDDINGS_SOCKET`, never the kit's path, so a failed daemon means keyword ranking rather than an in-app load. The SDK warms the model on `semanticFs.register()`, which only apps that use it call, instead of in every app.
- **The CLI** no longer bundles transformers into a VM app (it is external, and its absence is caught), and gives a single-app sandbox that declares `/context` 768 MiB.

`scripts/e2e.mjs context` checks a query that shares no word with a file's tag ("authentication credentials timing out" against "login token expiry bug") finds it, and does not return an unrelated file. The rootfs grows by 28 MB, to 107.5 MB.

## Code

The daemon is [`packages/semantic-fs-daemon`](../../packages/semantic-fs-daemon). berth-init's side is `start_semantic_fs` in [`packages/vmm/init/src/main.rs`](../../packages/vmm/init/src/main.rs), and the Go build runs in [`packages/vmm/guest/build-semantic-fs-in-vm.sh`](../../packages/vmm/guest/build-semantic-fs-in-vm.sh). The checks are `packages/vmm/scripts/e2e.mjs context` and `packages/cli/test/vm-e2e.mjs`.

### Release impact

A new binary in the rootfs changes its `image_sha256`, and with it the release tag `vm-artifacts-<kernel8>-<rootfs8>`, `packages/cli/src/vm/pins.ts`, and the manifests compiled into berth-vmm (`microvm-image.md`). The kernel is unchanged. This needs one more vm-artifacts release once it lands, and the `VMM_PINS` entry for that release's berth-vmm.

## Steps

Each step is one branch with its own verification, in order:

1. **Build and pin the binary.** Add the Go builder script, the apk lock, and the `semantic_fs_daemon_sha256` pin, then put the binary into the rootfs, which gives a new rootfs pin. Verify: the build reproduces bit for bit twice on the Mac builder, and in CI's `guest` job.
2. **berth-init starts it.** Add `start_semantic_fs`, the data dirs from section 3, `/context` out of `fresh_mounts`, `BERTH_NO_SEMANTIC_FS` gone, and `daemon_started` with the narrowing result. Verify: a new `context` mode in `packages/vmm/scripts/e2e.mjs` shows the boot event, a fuse entry for `/context`, `/dev/fuse` present, the daemon's effective capabilities matching the narrowed set, and the boot time against today's.
3. **The CLI lets it through.** Remove the refusal and update `local-vm.md`.
4. **End to end.** Add a `/context` block to `packages/cli/test/vm-e2e.mjs`, with `apps/filesystem` and notes in one VM:
   - write, tag, then `query_context` finds the file, with `created_by` set to filesystem;
   - an app without a `/context` scope gets `EACCES` on `/context`;
   - the file and its tags survive `berth vm stop` and a second boot with the same state disk;
   - with `state: false`, nothing survives;
   - after the daemon is killed, a query fails with an error naming the daemon, rather than returning nothing;
   - whether the embedding loaded, and so which ranking was used.
5. **Release.** Run vm-artifacts for the new rootfs pin, then add the `VMM_PINS` line.

## What step 2 found

- **Boot cost: about 10 ms.** That is from spawning the daemon to its `post_mount_caps_narrowed` line, with the FUSE mount and the control socket both up (`daemon_started`'s `waitMs`). It is well under the 50 ms threshold in section 1, so the daemon starts on every boot.
- **Capabilities narrow in the guest** as in a container: `capsNarrowed: true`.
- **`/dev/fuse` appears by itself** from devtmpfs, as section 2 inferred.
- **Embeddings fail in the guest, as section 7 expected,** but not for the reason it guessed: `@xenova/transformers` throws `ReferenceError: __filename is not defined` inside the ESM bundle, before it looks for the model. The SDK falls back to keyword ranking. `scripts/e2e.mjs context` records the lines.
- **Precreate is unchanged.** `/context` simply isn't in `fresh_mounts` once it is a FUSE mount, so the pass leaves its root to the daemon. A declared path under it is created through the mount, as root, which gives it the daemon's `root:berth` ownership, as in a container.
- **The daemon dying while apps run** (step 4, through a `kill_daemon` test-hook op on the control port, like `egress_raw`): berth-init records `daemon_exited`; `query_context` and `tag_context_file` fail with `semantic-fs call "query" cannot be sent: the control socket closed`; a write under `/context` fails with `ENOTCONN`; every app stays ready; shutdown unmounts the dead mount cleanly. Nothing restarts the daemon: until the next boot, `/context` is gone for that sandbox, loudly.
- **Through the CLI** (step 4, `packages/cli/test/vm-e2e.mjs` 3d): a renamed copy of apps/filesystem under `berth dev --runtime vm` writes, tags and finds a context file, attributed to `fs-e2e`, the kernel's name for it, though the app registers as "filesystem"; after `berth dev` restarts, the file and its tag are still there.

## Open questions

- ~~Does Alpine 3.24's `go` meet `go 1.26`?~~ Yes: Alpine ships go 1.26.8 (`guest/semantic-fs.apk.lock`). The daemon builds to `469dce88…` from two fresh builder roots (feat/vm-semantic-fs-build).
- ~~Does `fuse3` pull in anything beyond `fusermount3` and `libfuse3`?~~ Only `fuse-common` besides `fuse3` and `fuse3-libs`. It went in, with the setuid bit removed, and the image build now refuses any setuid or setgid file. rootfs `7f361418…` (79.5 MB, +4.7 MB).
- Should the daemon also put itself under a Landlock ruleset after mounting, limited to its data dir, the index and its socket? Docker doesn't, but in the guest nothing stops us. This would be a separate change to the daemon, worth doing for both paths at once.
