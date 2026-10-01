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
- **libkrun 1.19.6**. On macOS: `brew tap libkrun/krun && brew install libkrun`.
- **berth-vmm**, the small launcher that runs one VM per process. Build it from `packages/vmm` (`cargo build --release`). On macOS it has to be signed with the hypervisor entitlement (the build scripts do this). `berth doctor` prints the `codesign` command if it isn't.
- **The pinned kernel and rootfs**, about 70 MB, installed with `berth vm install`.

## Install

```bash
berth vm install --from <artifacts-dir> --vmm packages/vmm/target/release/berth-vmm
berth doctor --sandbox vm
```

`berth vm install` copies the kernel and rootfs into `~/.berth/vm`, where berth-vmm looks for them. Each file is hashed against its pin before it's put in place, and a file that doesn't match is refused. On APFS the copy is a clone, so it takes no extra disk space. The pins are the ones berth-vmm was built with: the CLI reads them out of the binary, because berth-vmm refuses to boot anything else.

Sources, in order:

1. **A local build directory**: `--from <dir>`, or `BERTH_VMM_ARTIFACTS`. This is the `$BERTH_VMM_ARTIFACTS` directory `packages/vmm`'s build scripts write (`kernel/sha256/<sha>/Image`, `rootfs/rootfs-<sha>.erofs`). A flat directory or one subdirectory per sha256 also works.
2. **A download**, for anything the directory doesn't have. The URL is a template keyed by sha256: `{kind}` is `kernel` or `rootfs`, `{sha256}` is the pin, and `{file}` is the file name. The default is `https://artifacts.berth.dev/{kind}/sha256/{sha256}/{file}`, which **is not published yet**. Set your own with `--url`, `BERTH_VM_ARTIFACTS_URL`, or `vm.artifactsUrl` in `~/.berth/config.json`. A download is checked against the pinned size as it streams, and against the sha256 before it's kept.

`--vmm <path>` also copies berth-vmm to `~/.berth/vm/bin/berth-vmm`. The signature is part of the binary, so it carries over. Without it, the CLI looks for berth-vmm in `BERTH_VMM`, then `~/.berth/vm/bin`, then `PATH`, then the checkout's `packages/vmm/target/release`.

If the artifacts aren't installed, `berth dev --runtime vm` installs them the first time it runs, from the same sources.

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
- **Architecture.** The pinned kernel and rootfs are built for arm64.
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
