# Local microVM runtime

`berth dev --runtime vm` and `berth mcp --runtime vm` run your app in a small virtual machine instead of a Docker container. The VM boots Berth's own pinned Linux kernel and a read-only base image, so the kernel that enforces your app's capabilities is the same on every machine, with Landlock always built in. No Docker daemon is involved, and no image is built.

Docker is still the default. The VM runtime runs filesystem-only Node apps today. See [Limits](#limits) for what it doesn't cover yet.

| | `--runtime docker` (default) | `--runtime vm` |
|---|---|---|
| Kernel that enforces the policy | the Docker host's (Docker Desktop: no Landlock; Colima: yes) | Berth's pinned kernel 6.12.109, Landlock built in |
| What runs your app | an image built from your project | your bundled app on a read-only share, in a pinned erofs rootfs |
| Network | the egress broker | the egress broker in the guest, plus a host-side dialer that enforces the `network:host:` allowlist again on the host. The VM itself has no network device |
| First `tools/call` after `berth mcp` starts | about 1.6 s with a warm image | about 0.7 s |
| Reload after a code change | container restart | VM reboot, about 0.55 s |

## Requirements

- **macOS on Apple silicon** (Hypervisor.framework), or **Linux with KVM** (`/dev/kvm` readable and writable).
- **libkrun 1.19.6**. On macOS: `brew tap libkrun/krun && brew install libkrun`. Newer Homebrew asks you to trust a third-party tap's formulae first: `brew trust --formula libkrun/krun/libkrun libkrun/krun/libkrunfw libkrun/krun/virglrenderer-krun`.
- **berth-vmm**, the small launcher that runs one VM per process. `berth vm install` downloads it on macOS arm64 once a published build is pinned in the CLI (see below). Otherwise build it from `packages/vmm` with `cargo build --release`. On macOS it has to be signed with the hypervisor entitlement. The published build is, and the build scripts sign a local one. `berth doctor` prints the `codesign` command if it isn't.
- **The pinned kernel and rootfs**, about 70 MB, installed with `berth vm install`.

## Install

```bash
berth vm install
berth doctor --sandbox vm
```

`berth vm install` puts the kernel and rootfs in `~/.berth/vm`, where berth-vmm looks for them. If no berth-vmm is found, it also puts berth-vmm in `~/.berth/vm/bin`. Each file is checked against its sha256 pin before it is put in place, and a file that doesn't match is refused. The kernel and rootfs pins are the ones berth-vmm was built with. The CLI reads them out of the binary, because berth-vmm refuses to boot anything else. If there is no berth-vmm yet, it uses its own copy of the same pins.

### What is downloaded, and from where

By default, from the GitHub release that [`.github/workflows/vm-artifacts.yml`](../.github/workflows/vm-artifacts.yml) publishes for the kernel and rootfs pair, `vm-artifacts-<first 8 hex of the kernel pin>-<first 8 of the rootfs pin>`:

| File | Asset | sha256 (this CLI) | Size |
|---|---|---|---|
| `~/.berth/vm/kernel/sha256/<sha>/Image` | `Image-<sha>` | `8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8` | 23,668,744 B |
| `~/.berth/vm/rootfs/rootfs-<sha>.erofs` | `rootfs-<sha>.erofs` | `47e1ea51bb54411e8a5ff9ec37296f254cd84d3c12ad7d0d12c0d9c2b6fe7e23` | 46,723,072 B |
| `~/.berth/vm/bin/berth-vmm` | `berth-vmm-darwin-arm64-<sha>` | `VMM_PINS` in `packages/cli/src/vm/pins.ts` | about 600 KB |

That is `https://github.com/Ash20pk/BerthOS/releases/download/vm-artifacts-8f79e8da-47e1ea51/`. CI rebuilt the kernel and rootfs there from source on GitHub's arm64 Linux runners, and they matched the pins bit for bit before the release was published. The release also carries `SHA256SUMS`, each rootfs's input record, berth-vmm's build record, and the kernel's GPL sources (the exact linux and libkrunfw tarballs, the config delta, the resolved config and the build script; see `SOURCES.md` there).

berth-vmm is downloaded only when the CLI pins its sha256 for your platform (macOS arm64 is the only published one). A build from CI can't be pinned until CI has built it, so a CLI released before the first artifacts release has no pin, and says so. Then build berth-vmm and pass `--vmm`, or download it by hand (below).

A download is checked against the pinned size as it streams, and against the sha256 before it's renamed into place, so nothing unverified is ever at the final path.

### Sources, in order

1. **A local directory**: `--from <dir>`, or `BERTH_VMM_ARTIFACTS`. It can be the `$BERTH_VMM_ARTIFACTS` directory that `packages/vmm`'s build scripts write (`kernel/sha256/<sha>/Image`, `rootfs/rootfs-<sha>.erofs`), a flat directory, one subdirectory per sha256, or a directory of downloaded release assets. On APFS the copy is a clone, so it takes no extra space.
2. **A download**, for anything the directory doesn't have. The URL is a template:

   | Placeholder | |
   |---|---|
   | `{asset}` | the release asset name: `Image-<sha>`, `rootfs-<sha>.erofs`, `berth-vmm-darwin-arm64-<sha>` |
   | `{kernel8}`, `{rootfs8}` | the first 8 hex digits of the kernel and rootfs pins (the release tag); `{kernel}` and `{rootfs}` are the full pins |
   | `{kind}`, `{sha256}`, `{file}` | `kernel`, `rootfs` or `vmm`; the artifact's own pin; its file name in `~/.berth/vm` (`Image`, `rootfs-<sha>.erofs`, `berth-vmm`) |

   The default is `https://github.com/Ash20pk/BerthOS/releases/download/vm-artifacts-{kernel8}-{rootfs8}/{asset}`. Set a mirror with `--url`, `BERTH_VM_ARTIFACTS_URL`, or `vm.artifactsUrl` in `~/.berth/config.json`. `file://` works too, for example `--url 'file:///Volumes/usb/vm-artifacts/{asset}'`. A mirror needs no trust, because every file is checked against the pin.

`--no-download` copies from `--from` only. `--vmm <path>` copies that berth-vmm to `~/.berth/vm/bin/berth-vmm` instead of downloading one. The signature is part of the binary, so it carries over. Otherwise the CLI looks for berth-vmm in `BERTH_VMM`, then `~/.berth/vm/bin`, then `PATH`, then the checkout's `packages/vmm/target/release`.

If the kernel and rootfs aren't installed, `berth dev --runtime vm` installs them the first time it runs, from the same sources.

### Verifying by hand

```bash
tag=vm-artifacts-8f79e8da-47e1ea51
gh release download "$tag" -R Ash20pk/BerthOS -p 'Image-*' -p 'rootfs-*.erofs' -p 'berth-vmm-darwin-arm64-*' -p SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS     # each asset against the list
shasum -a 256 Image-* rootfs-*.erofs              # and against the pins above, which are also in
                                                  # packages/vmm/{kernel,rootfs}/manifest.toml
berth vm install --from .                         # installs from this directory, checked again
```

`SHA256SUMS` comes from the same release, so it only catches a damaged download. The pins are what you trust: the table above, the manifests in the repository, and the copy compiled into berth-vmm (`berth doctor --sandbox vm` shows them).

berth-vmm is ad hoc signed, not notarized. A copy you download with a browser is quarantined, and macOS won't run it until you clear that, after checking its sha256:

```bash
shasum -a 256 berth-vmm-darwin-arm64-*            # must equal the name's hash and the CLI's pin
xattr -d com.apple.quarantine berth-vmm-darwin-arm64-*
```

`berth vm install` doesn't need this. A file it downloads isn't quarantined, and it clears the attribute only on a file whose sha256 matched the pin.

### Building from source

The same scripts CI runs, from `packages/vmm` (a libkrun builder VM on macOS, a container on Linux):

```bash
cd packages/vmm
./scripts/build-kernel.sh       # checks the Image against kernel/manifest.toml
./scripts/build-agent-init.sh   # agent-init + probe, checked against rootfs/manifest.toml
./scripts/build-berth-init.sh   # berth-init + context-bus-daemon, checked likewise
./scripts/build-rootfs.sh       # the erofs image, checked likewise
cargo build --release           # berth-vmm (the scripts also sign it)
berth vm install --from "$BERTH_VMM_ARTIFACTS" --vmm target/release/berth-vmm
```

Each script fails on a hash that isn't its pin and prints both. The builds are reproducible while Alpine 3.24 still serves the package versions in `kernel/apk.lock`, `guest/*.apk.lock` and `rootfs/apk.lock`, which is how long the pins can be rebuilt bit for bit. See [Distribution](design/microvm-image.md#distribution).

## Run an app

```bash
cd apps/notes
berth dev --runtime vm
```

```
VM ready in 416 ms (bundle 9 ms, cached, boot 407 ms). boot 353f3798-…, berth-vmm pid 28633
[berth:dev] run dir ~/.berth/run/vm/berth-dev-notes; call it with `berth rpc notes --runtime vm --export <name>` …
```

From another terminal:

```bash
berth rpc notes --runtime vm --export add_note --input '{"text":"hello"}'
berth rpc notes --runtime vm --export list_notes
berth vm status                 # running VMs, their apps, pids, uids and cgroup limits
berth vm logs berth-dev-notes   # the guest's log: apps, berth-init, context-bus
berth vm stop berth-dev-notes
```

What happens:

- **Bundling.** The guest has Node but no `node_modules`, so the app is bundled with esbuild: `dist/index.mjs` (your app with `@berthos/sdk`, zod and your other dependencies inlined), `runtime.mjs` (the SDK's runtime), `proto/context_bus.proto`, and your `berth.yml`. esbuild and the SDK come from your project if it has them installed, or from the CLI's own dependencies if it doesn't. A `berth init` project works before `npm install`. Bundles are cached by content under `~/.berth/vm/apps`.
- **The VM.** One `berth-vmm` process with 2 vCPUs and 512 MiB, no network device, and TSI off. Its run directory, `~/.berth/run/vm/<name>/`, holds the sockets for the control, log and RPC ports, plus `berth-vmm.pid`, `vm.json`, `vmm.log` and `console.log`. berth-vmm runs detached, so `berth mcp`, `berth rpc` and `berth vm` commands find it again by its run directory. If its process is gone or no longer belongs to that run directory, the run directory is treated as stale and cleaned up.
- **Inside.** `berth-init` is PID 1. It compiles your capability policy, runs your app as its own uid in its own cgroup under agent-init (Landlock, seccomp), and starts the context bus. See [the design notes](design/microvm-runtime.md).
- **`/workspace`** is on a per-app state disk, `~/.berth/vm/state/<app>.img`. It is created sparse at 1 GiB and kept across reloads and sessions, like the Docker path's named volume.

### Reloading

Saving a file in `src/` or `berth.yml` rebundles. If the bundle comes out the same (you changed only a comment, say), the VM keeps running. Otherwise the VM is stopped and a fresh one boots on the new bundle:

```
Change detected, rebooting the VM with the new bundle...
Reloaded in 537 ms (bundle 127 ms, stop 36 ms, boot 374 ms). boot 0820e707-…
```

The CLI reboots the whole VM rather than restarting only the app. The app share is read-only, and berth-init has no way to restart a single app yet. A boot also recompiles the capability policy, so a `berth.yml` change takes effect, which an app restart wouldn't do. Your notes stay on the state disk.

### MCP

```bash
berth mcp --runtime vm --app notes --app-dir apps/notes
```

The bridge works as it does with Docker (see the [MCP bridge reference](mcp-bridge-reference.md)). If `berth dev --runtime vm` is already running the app, the bridge attaches to that VM and leaves it running when the client goes. Otherwise it boots its own VM and stops it at the end of the session. Tool calls are audited the same way, and the session records the VM's boot evidence. `berth attest <runId>` then reports the session with `boot.isolation` (see the [attestation reference](attestation-reference.md#a-microvm-boot)).

Time from spawning `berth mcp` to the first answered `tools/call`, measured by `packages/cli/test/vm-e2e.mjs` on an Apple M4 under load: 625 to 851 ms when the bridge boots its own VM (about 300 ms of that is the CLI starting), and about 260 ms when it attaches to a running one. The Docker path takes about 1.6 s with a warm image.

## Choosing the runtime

| | |
|---|---|
| per command | `--runtime vm` on `berth dev`, `berth mcp`, `berth rpc` |
| per shell | `export BERTH_SANDBOX=vm` |
| per user | `{"sandbox": "vm"}` in `~/.berth/config.json` |

The variable is `BERTH_SANDBOX`, not `BERTH_RUNTIME`. `BERTH_RUNTIME` already selects the container runtime Docker uses, such as `runsc` for gVisor.

`~/.berth/config.json` also takes `vm.artifactsUrl`, `vm.artifactsDir` and `vm.vmm`.

## Limits

An app whose `berth.yml` needs something the VM doesn't have yet is refused before boot, with the reason and a pointer back to `--runtime docker`:

- **Network.** The VM has no network device, and TSI is off. An app that declares `network:host:` or `browser:navigate:` reaches those hosts through the egress broker inside the guest, which dials out over vsock to a dialer in berth-vmm. The CLI passes your apps' scopes to berth-vmm as `--egress-allow`, and the dialer enforces that allowlist again on the host: it resolves names itself and refuses private, loopback, link-local and metadata addresses. One app per sandbox may declare egress, as with containers. See [the egress design](./design/microvm-egress.md).
- **Secrets.** There is no secrets channel yet. The guest's environment is passed on the kernel command line, which every process in the guest can read.
- **semantic-fs and `/context`.** Not in the VM yet (`BERTH_NO_SEMANTIC_FS=1`).
- **Python apps.** The image has no `python3` or `berthos-sdk` yet.
- **Browser and terminal capabilities.** Not in the image.
- **Other `<service>:*` capabilities**, such as `github:*`, go through the egress broker or a host service, so they wait for egress.
- **Native addons** (`.node` files) can't run in the guest, because they were built for your host, not for Linux on arm64. Bundling stops with that error.
- **Files your app reads from its own directory** at run time, beyond `berth.yml`, aren't in the share. Only the bundle is.
- **Architecture.** The pinned kernel and rootfs are built for arm64, and berth-vmm is published for macOS arm64 only.
- **`/app` is unmeasured.** The kernel, rootfs and state disk are hashed at every boot. Your bundle isn't yet.
- **Policy digests.** `berth attest` records a VM boot with an empty `policies` list, because berth-init doesn't report the sha256 of the policy it compiled yet.

## Troubleshooting

`berth doctor --sandbox vm` checks everything the VM runtime needs, without contacting Docker, and prints a fix for each failure:

```
  ✔ Hypervisor (HVF)
  ✔ berth-vmm                          ~/.berth/vm/bin/berth-vmm
  ✔ berth-vmm hypervisor entitlement   signed with com.apple.security.hypervisor
  ✔ berth-vmm's pinned kernel and rootfs
  ✔ libkrun                            1.19.6
  ✔ Pinned kernel and rootfs in ~/.berth/vm
```

- **`berth-vmm hypervisor entitlement` fails**: run the `codesign --sign - --force --entitlements ~/.berth/vm/berth-vmm.entitlements <berth-vmm>` command doctor prints. `berth vm install` writes the entitlements file.
- **The boot fails**: the error includes berth-vmm's last lines. `~/.berth/run/vm/<name>/console.log` has the guest console, and `vmm.log` has berth-vmm's own output, including the measurement line.
- **`"<name>" is already running`**: another `berth dev` owns that VM. Stop it there, or run `berth vm stop <name>`.
