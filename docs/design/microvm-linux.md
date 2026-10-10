# The microVM runtime on Linux (KVM) and x86_64

Status: steps 2 to 6 built and tested in CI (2026-10-10, see [Progress](#progress)); step 1's local
arm64 boot and the first release of both architectures remain. Before this, the VM runtime ran on Apple
silicon Macs only: the kernel, rootfs and guest binaries
are built for aarch64, and berth-vmm is published for darwin-arm64 alone ([`../local-vm.md`](../local-vm.md#limits),
"Architecture"). This is the first item that has to close before the VM can be the default runtime
([`microvm-runtime.md`](microvm-runtime.md)).

The target is four host platforms, each booting a guest of its own architecture:

| Host | Hypervisor | Guest | Status |
|---|---|---|---|
| macOS arm64 | HVF | aarch64 | works |
| Linux arm64 | KVM | aarch64 (the same kernel and rootfs) | to build |
| Linux x86_64 | KVM | x86_64 (new kernel, rootfs, layers) | to build |
| macOS x86_64 | | | out of scope: libkrun has no Intel-Mac backend |

## What already holds

- **berth-vmm compiles on Linux.** The macOS-only parts have stubs: the Seatbelt host sandbox
  (`src/sandbox.rs`) and the clone-based file hashing (`src/sha256.rs`). `run.rs` turns the host sandbox off
  off macOS and says so.
- **agent-init's seccomp filter covers both architectures** (`packages/agent-init/src/seccomp.rs`), as it
  already does for x86_64 containers.
- **The CLI detects KVM.** `checkHost` reads `/dev/kvm` and prints the `kvm` group fix; libkrun is looked up
  in the usual Linux library directories.
- **Pins travel inside berth-vmm.** `kernel/manifest.toml` and `rootfs/manifest.toml` are compiled in, and
  the CLI reads them out of the binary. A berth-vmm built for one architecture carries that architecture's
  pins, so the CLI side mostly follows.
- **The guest software is architecture-neutral.** The Rust (berth-init, agent-init, context-bus-daemon), Go
  (semantic-fs-daemon), Node bundles and Alpine packages all exist for x86_64.

## What is aarch64-only

- **The builds.** `scripts/common.sh` fetches the aarch64 Alpine minirootfs; each `*-in-vm.sh` relies on
  Alpine's native toolchain being aarch64 musl; `kernel/build-in-vm.sh` takes `config-libkrunfw_aarch64`
  and copies `arch/arm64/boot/Image`.
- **One set of pins.** `kernel/manifest.toml` says `arch = "aarch64"`, and `rootfs/manifest.toml` and every
  layer have one sha256 each. The CLI's built-in fallback pins (`KERNEL_SHA256`, `ROOTFS_SHA256`) are
  single values too.
- **The release.** `vm-artifacts.yml` builds the guest on `ubuntu-24.04-arm` and berth-vmm on `macos-15`
  only, and names one release per `<kernel8>-<rootfs8>` pair.
- **The host sandbox.** Seatbelt is macOS; Linux has nothing around berth-vmm (open problem 9). libkrun runs
  the VMM and the guest as one security context, so on Linux berth-vmm is currently unconfined.
- **libkrun on Linux.** Homebrew's tap is macOS. Distributions don't ship 1.19.6 consistently.

## Decisions

1. **Pins per architecture, side by side.** `kernel/manifest-<arch>.toml` and `rootfs/manifest-<arch>.toml`
   (`aarch64`, `x86_64`); `build.rs` picks the target's pair for `include_str!`. Layers stay per rootfs,
   so they follow. The aarch64 files are today's, renamed, so the existing pins don't move. The Alpine
   package records follow the same rule (`kernel/<arch>.apk.lock`, `guest/<name>.<arch>.apk.lock`,
   `rootfs/<arch>.apk.lock`, `rootfs/builder.<arch>.apk.lock`, `rootfs/layers/<name>/<arch>.apk.lock`),
   and the scripts take the host's architecture and refuse any other (`BERTH_GUEST_ARCH` may only
   name the host's).
2. **x86_64 kernel as an ELF `vmlinux`.** libkrun's x86_64 loader takes ELF (`image_format = "elf"`, which
   `pins.rs` already knows); step 3 confirms it before anything is pinned. Same Linux 6.12.109, libkrunfw's `config-libkrunfw_x86_64` plus the same
   `berth-kernel.config` delta (Landlock, yama, WireGuard; io_uring off), so the kernel is the same kernel.
3. **Build natively, never emulated.** x86_64 artifacts are built in an x86_64 Alpine container on
   `ubuntu-24.04` (as aarch64 ones are on `ubuntu-24.04-arm`), and checked against the pins the same way.
   A Mac can't build them at a usable speed; a developer on a Mac reproduces the aarch64 set as now.
4. **libkrun ships with berth-vmm on Linux.** Built from the 1.19.6 tag in CI, pinned by sha256, published
   next to berth-vmm, and found through `RUNPATH=$ORIGIN` (installed to `~/.berth/vm/bin/libkrun.so.1`).
   No system package needed, and the version the doctor checks is the one we tested. libkrunfw isn't needed:
   berth-vmm boots its own kernel through `krun_set_kernel`.
5. **berth-vmm confines itself on Linux with Landlock and seccomp**, the equivalent of the Seatbelt profile:
   read the kernel, rootfs, layers, app shares and secrets disk; read and write the state disk and the run
   directory; TCP connect only with the egress dialer. It goes on just before `krun_start_enter`, fails
   closed, and is reported as `hostSandbox: { kind: "landlock" }`. Needs a host kernel with Landlock
   (5.13+; ABI 4, Linux 6.7, for the TCP rule); with less it says so, as `--no-host-sandbox` does.
6. **No KVM means no VM, said plainly.** The CLI keeps refusing with the `/dev/kvm` reason and pointing at
   `--runtime docker`; there's no namespaces-only VM mode. Attestation already records which one ran.
7. **One release per architecture.** `vm-artifacts-<kernel8>-<rootfs8>` names each architecture's
   own pair: the aarch64 release holds the aarch64 kernel, rootfs and layers and the `darwin-arm64` and
   `linux-arm64` berth-vmm builds; the x86_64 release holds x86_64's and `linux-x64`. The CLI already
   derives the tag from the pins it boots, so a host finds its own release with no special case, and
   every existing install keeps its URL. (The plan first had one release with the x86_64 files as extra
   assets; that needs the CLI to know the other architecture's pins to find the tag, for no gain.) Each
   berth-vmm asset is `berth-vmm-<os>-<arch>-<sha>`; `VMM_PINS` gains `linux-arm64` and `linux-x64`.

## Steps

Each is its own branch, tested before the next.

1. **Linux arm64 boots today's artifacts.** Build libkrun 1.19.6 and berth-vmm on Linux arm64, and run
   `scripts/e2e.mjs all` against the existing kernel and rootfs under KVM. Proves libkrun's KVM path with our
   kernel, cmdline, virtio-fs shares, vsock ports, state disk and egress dialer before anything is rebuilt.
   Tested locally in a Lima VM with nested virtualization (M3 or later, macOS 15+), and in CI if
   GitHub's arm64 runners expose `/dev/kvm`.
2. **Per-architecture pins.** The manifest split and `build.rs` selection (decision 1), with no change to
   any aarch64 pin. The CLI's fallback pins become per-arch too. *Done* (`feat/vm-pins-per-arch`):
   `GUEST_PINS` in `packages/cli/src/vm/pins.ts`, checked against each `manifest-<arch>.toml` present.
3. **x86_64 guest.** The build scripts take `ARCH` (minirootfs, toolchain checks, kernel config and output);
   kernel, berth-init, agent-init, context-bus-daemon, semantic-fs, rootfs, embeddings kit and browser layer
   built and pinned for x86_64, each reproduced twice. `e2e.mjs all` on an x86_64 Linux host with KVM
   (GitHub's `ubuntu-24.04` runners have it).
4. **libkrun bundled on Linux** (decision 4), and `berth doctor` checking the bundled copy.
5. **Linux host sandbox for berth-vmm** (decision 5), with `e2e.mjs host` run on Linux.
6. **Release and CLI.** `vm-artifacts.yml` builds and publishes both architectures and three berth-vmm
   builds; `VMM_PINS` for Linux; `packages/cli/test/vm-e2e.mjs` on both Linux runners; a clean
   `berth vm install` from a fresh HOME on each. `docs/local-vm.md`'s Architecture limit goes.

## Progress

2026-10-10, branches stacked on `ci/vm-linux-probe`: `feat/vm-pins-per-arch` (step 2),
`feat/vm-x86_64-guest` (3), `feat/vm-linux-host-sandbox` (5), `feat/vm-linux-release` (4, 6, and the pins).

- **x86_64 guest, pinned.** `vm-artifacts` with `update_pins` (run 38027242417) built and pinned it on
  `ubuntu-24.04`: kernel `10d4b54c…` (ELF vmlinux, 27.9 MB), rootfs `11696a0f…` (110.5 MB), both layers.
  The same run booted it under KVM with the linux-x64 berth-vmm: `e2e.mjs` single 18/18, multi 17/17,
  enforce 12/12, stdio 3/3, exits 3/3, context 23/23, github 10/10, terminal 12/12, browser 10/10, and
  guest Landlock ABI 6 FullyEnforced. What it found:
  - **Power-off doesn't end an x86_64 VM.** libkrunfw's x86_64 kernel has no ACPI, so
    `reboot(RB_POWER_OFF)` halts and berth-vmm never exits. berth-init now resets on x86_64 (`reboot=k`
    makes that the keyboard controller's reset, which libkrun turns into the VM's end); aarch64 keeps PSCI
    power-off, and its berth-init binary is unchanged.
  - **A refused egress request lost its ERR line.** The host dialer closed both ways right after writing
    it, and libkrun on Linux drops undelivered bytes on a host-side close. It now half-closes and waits up to
    5 s for the guest to hang up.
- **Host sandbox on Linux** (step 5): on the runner (Linux 6.17), Landlock ABI 7 with TCP rules and
  scoping, 39 syscalls refused by seccomp, `exec` answered EPERM, the user's files EACCES, and the VM working
  under it. Landlock and seccomp bind the calling thread and its later threads only, so berth-vmm confines
  itself while single-threaded (checked) and the egress dialer's threads start after.
- **aarch64 re-pinned.** Alpine stopped serving tzdata 2026d, so rootfs `c2dd5975…` no longer rebuilds bit
  for bit; it is now `62f96e1b…` (run 38027691295), with the layers over it. Kernel and guest binaries
  reproduced unchanged. The published `darwin-arm64` berth-vmm (`VMM_PINS`) still carries `c2dd5975`, and
  installs keep using that release until the next one is published and pinned.
- **Both architectures from the committed pins** (run 38029430998, an ordinary build): kernel, guest
  binaries, rootfs and layers bit for bit for aarch64 and x86_64 (x86_64's second build), the three berth-vmm
  builds, and the x86_64 guest under KVM: every `e2e.mjs` mode, 151/151, host 8/8 and egress 28/28
  included. Run 38029510496 adds `packages/cli/test/vm-e2e.mjs` on the same runner: 42/42 (`berth vm
  install --from`, a local berth-vmm with its libkrun beside it, doctor, dev, mcp, secrets, python,
  `/context`, the terminal, attest). The re-pinned aarch64 rootfs boots on macOS (single, multi, enforce,
  stdio, exits, context, host, egress, terminal all passing).
- **Not verified:** a Linux arm64 boot (no KVM on GitHub's arm64 runners, and no disk left on the
  development Mac for a nested-KVM Lima VM; the linux-arm64 berth-vmm is built and loads its libkrun, no
  more), and a clean `berth vm install` that downloads (needs both releases published and `VMM_PINS` /
  `LIBKRUN_PINS` set from that run's notices).

## What it doesn't cover

- Notarizing the macOS berth-vmm, and making the VM the default. Both come after this.
- Intel Macs (no libkrun backend), Windows, and Linux without KVM.

## Risks to check first

- **Nested KVM on GitHub's runners.** Probed (`.github/workflows/vm-linux-probe.yml`, 2026-10-06): the
  x86_64 runners (`ubuntu-24.04`, AMD, Linux 6.17, Landlock in the LSM list) have `/dev/kvm`, usable by the
  runner user once a udev rule opens it (`udevadm settle`, or a `chmod` fallback). The arm64 runners
  (`ubuntu-24.04-arm`) have no `/dev/kvm` at all. So CI can boot x86_64 guests only: Linux arm64 is tested
  on a local Lima VM with nested virtualization, or another arm64 host with KVM, and step 1's CI half moves
  to x86_64, after step 3.
- **libkrun on x86_64 with our own kernel and no libkrunfw** is a less trodden path than on macOS; the
  virtio-fs and vsock devices are the same code, the boot path isn't.
- **Disk.** The x86_64 builds add a second set of every artifact (about 600 MB with the browser layer) to
  `vm-runtime-artifacts`; builds of it happen in CI, not on the Mac.
