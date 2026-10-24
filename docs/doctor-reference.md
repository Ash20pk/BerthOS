# `berth doctor`

`berth doctor` answers one question: **can the kernel that runs your apps enforce the capabilities in your `berth.yml`?** Run it before trusting any enforcement claim on a new machine, and in CI as a preflight.

## Context

You run `berth doctor` on a machine (yours, or a CI runner) before you trust Berth to enforce there. What it asks about is not your laptop's kernel but the one your apps would run on: the Docker daemon's, which on macOS and Windows lives in a Linux VM. For the [local microVM runtime](local-vm.md) it asks instead whether this host can boot Berth's own kernel. On macOS, `--fix` also reaches out to Homebrew and Colima to set up a VM that enforces.

## Containers

The CLI runs on the host and does no kernel checks there. It asks the Docker daemon for its version and kernel, then runs a short-lived probe container on that daemon, so the answer comes from the kernel your apps would get. With `--sandbox vm` it skips Docker and looks for a hypervisor, `berth-vmm` and the pinned kernel and rootfs on the host ([The microVM section](#the-microvm-section)).

### Which kernel it checks

On macOS and Windows your apps run inside Docker's Linux VM, so the kernel that matters is the VM's, not your laptop's. Every kernel check runs **inside a container**, against the Docker daemon's kernel, and the output starts by naming that kernel:

```
Kernel that runs Berth's apps: 6.10.14-linuxkit (Docker Desktop)
Probed in: berth/filesystem:dev-1a2b3c4d

  ✔ Docker daemon reachable
      Docker Desktop (28.0.1), kernel 6.10.14-linuxkit on aarch64
  ...
  ✘ Landlock enforcement in the container kernel
      the Landlock syscalls are not available in this kernel (Function not implemented)
      → Berth's filesystem and network capabilities cannot be enforced here. ...

enforcement: NOT ACTIVE (the Landlock syscalls are not available in this kernel (Function not implemented))
```

Each check prints `✔` ok, `!` warn, `✘` fail or `?` unknown, with what was observed and, on a line starting `→`, what to do about it. The last line is the verdict: `enforcement: ACTIVE`, `enforcement: NOT ACTIVE (…)`, or `enforcement: UNKNOWN (…)` when the check couldn't be run.

## Components

The checks, the Landlock probe that decides the verdict, the image the probe runs in, and the microVM checks:

### What it checks

| Check | `id` | What it means |
|---|---|---|
| Docker daemon reachable | `docker` | The daemon answers, with its version, kernel and architecture. Every check below runs in a container, so they depend on this one |
| Memory for image builds | `memory` | The Docker VM's memory. A `warn` below 4 GB: the first image build compiles Berth's helpers and installs Chromium, and runs out of memory with Colima's default 2 GB. Never affects the verdict |
| Landlock enforcement | `landlock` | The check that decides the verdict. See below |
| Docker's default seccomp profile | `seccomp` | A `warn` isn't fatal: `agent-init` installs its own seccomp filters regardless. You lose Docker's extra layer |
| Container runtime for sandboxes | `runtime` | Which runtime sandboxes boot with (`--runtime` or `BERTH_RUNTIME`, else the daemon default) and whether the daemon has it. A requested runtime the daemon lacks is a `fail`, and the kernel probe is skipped |
| `/dev/fuse` available | `fuse` | Probed with the same device and capability settings a real boot uses. Semantic FS needs it to mount `/context` |
| Per-app resource limits | `cgroups` | Whether the container's cgroup2 mount has `nsdelegate`, which is what makes it safe to give each sandbox a writable cgroup namespace. `ok` means each app gets its own cgroup and limits. `warn` means only the sandbox's container-level caps apply. See [resource limits](./resource-limits.md) |

#### How the Landlock check works

Landlock can fall short in three ways:

1. **The syscalls aren't there.** They return `ENOSYS`. Docker Desktop for Mac's kernel is like this.
2. **The syscalls are there but Landlock isn't active in the kernel.** Every call succeeds and nothing is ever denied.
3. **Landlock works, but it's too old.** Berth's policy needs Landlock ABI 4 (Linux 6.7+), which adds network rules. On Linux 5.13 to 6.6 file rules are enforced but network rules aren't, and a production image refuses to start. `doctor` reports this as `NOT ACTIVE`, naming the kernel's ABI.

The second is the dangerous one, because everything looks fine. So the probe doesn't ask the kernel what it supports. It builds a Landlock ruleset that grants nothing and tries to write a file. An enforcing kernel refuses the write. The probe then checks the ABI the kernel reported. It needs no special privileges.

The probe tests the kernel, not your app's policy.

#### Under a hardened runtime

With `--runtime runsc`, the probe runs under gVisor, so the kernel being tested is gVisor's, not the host's, and the answers can differ. See [Optional hardened runtime](./kernel-enforcement.md#optional-hardened-runtime-gvisor--berth_runtime).

### The probe image

The probe needs an image with `python3`, which every Berth app image has. It uses, in order: `--image` if given, a local `berth/*` or `berth-agent/*` image, a local `python*` image, and otherwise it pulls `python:3.13-alpine`. `--image` or `--no-probe` avoid the pull.

### The microVM section

The [local microVM runtime](local-vm.md) brings its own kernel, so the question is different: not whether this host's kernel enforces, but whether this host can boot Berth's. `berth doctor` checks:

| `id` | Check | Fails when |
|---|---|---|
| `hypervisor` | HVF (`kern.hv_support`) on macOS, `/dev/kvm` on Linux | no hypervisor is available to this user |
| `berth-vmm` | the launcher, from `BERTH_VMM`, `~/.berth/vm/bin`, `PATH` or the checkout | it isn't found |
| `codesign` | macOS: berth-vmm carries `com.apple.security.hypervisor` | unsigned, or signed without it; the remedy is the `codesign` command |
| `pins` | the kernel and rootfs pins compiled into berth-vmm | they can't be read. It warns if they differ from the CLI's built-in copy, and uses berth-vmm's |
| `libkrun` | the libkrun berth-vmm links, and its version | missing, or not 1.19.6 |
| `artifacts` | the pinned kernel and rootfs in `~/.berth/vm`, hashed | missing, or not matching the pin; the remedy is `berth vm install` |

It also says whether this berth-vmm has the host egress dialer (`--egress-allow`). In `--json` the section is an extra `vm` key, `{ "ready": bool, "checks": [...], "vmm": path, "features": { "egress": bool } }`, alongside the container report. With `--sandbox vm` it is `{ "schemaVersion": 1, "sandbox": "vm", "vm": { ... } }`.

## Code

```bash
berth doctor
berth doctor --json
berth doctor --fix
berth doctor --runtime runsc
berth doctor --image berth/filesystem:dev-1a2b3c4d
berth doctor --no-probe
berth doctor --sandbox vm
```

### Flags

| Flag | What it does |
|---|---|
| `--json` | Print the report as JSON only, so `berth doctor --json \| jq` works. Schema below |
| `--fix` | On macOS, set up a Colima VM that enforces, then check again against it. See [`--fix`](#--fix) |
| `--runtime=<name>` | Check a container runtime, e.g. `runsc` for gVisor, and run the kernel probe under it. Defaults to `BERTH_RUNTIME` |
| `--image=<image>` | Image to run the kernel probe in. Defaults to a local Berth image |
| `--no-probe` | Skip the container probe. The kernel checks then report `unknown` |
| `--sandbox=<docker\|vm>` | Which sandbox to check for. `docker` (the default, or `BERTH_SANDBOX`, or `"sandbox"` in `~/.berth/config.json`) runs the container checks and adds the microVM section for information. `vm` checks only the [local microVM runtime](local-vm.md), never contacts Docker, and exits with the VM's verdict. See [The microVM section](#the-microvm-section) |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Enforcement is active |
| `1` | Enforcement is off, or couldn't be established. `unknown` fails too: a check that didn't run hasn't passed |

With `--fix`, the exit code reflects the re-check against the new VM. With `--sandbox vm`, `0` means every microVM check passed and `1` means at least one failed.

### `--fix`

On macOS, when enforcement isn't active, `--fix`:

1. Installs Colima and the Docker CLI with Homebrew, if Colima is missing.
2. Starts the Colima VM with the settings from [mac-enforcement.md](./mac-enforcement.md): `--vm-type vz --mount-type virtiofs --mount "$HOME:w"`, plus 4 CPUs, 8 GB memory and a 60 GB disk.
3. Runs the same checks again against the Colima socket, and reports success only if that second run observes enforcement.

It then tells you how to keep Berth on Colima: `docker context use colima` once (Berth follows the current Docker context), or `export DOCKER_HOST=...` per shell.

| Variable | Default | What it sets |
|---|---|---|
| `COLIMA_PROFILE` | `default` | The Colima profile to use. A non-default profile's context is `colima-<profile>` |
| `BERTH_COLIMA_CPU` | `4` | VM CPUs |
| `BERTH_COLIMA_MEMORY` | `8` | VM memory, in GB |
| `BERTH_COLIMA_DISK` | `60` | VM disk, in GB |

On Linux, `--fix` refuses and explains why: enforcement there depends on the running kernel, not on a VM.

### `--json`

Schema version `1`. New checks and new optional fields keep version `1`; anything that breaks a reader bumps it.

```jsonc
{
  "schemaVersion": 1,
  "enforcementActive": false,     // true only when the kernel can enforce
  "enforcementDetermined": true,  // whether the question was answered at all
  "verdict": "enforcement: NOT ACTIVE (…)",
  "reasons": ["the Landlock syscalls are not available in this kernel (Function not implemented)"],
  "checks": [
    {
      "id": "landlock",                   // "docker" | "memory" | "landlock" | "seccomp" | "fuse" | "runtime" | "cgroups" — stable; readers must tolerate new ids
      "title": "Landlock enforcement in the container kernel",
      "status": "fail",                   // "ok" | "warn" | "fail" | "unknown"
      "detail": "…what was observed…",
      "remedy": "…what to do about it…"   // omitted when there's nothing to do
    }
  ],
  "daemon": {                             // omitted when the daemon is unreachable
    "kernelVersion": "6.10.14-linuxkit",  // the kernel that runs your apps
    "operatingSystem": "Docker Desktop",
    "serverVersion": "28.0.1",
    "arch": "aarch64",
    "securityOptions": ["name=seccomp,profile=unconfined", "name=cgroupns"]
  },
  "probeImage": "berth/filesystem:dev-1a2b3c4d"    // omitted when the probe didn't run
}
```

How to read it:

- **`unknown` never means "probably fine".** `--no-probe`, an unreachable daemon, and a probe that failed to start all report `unknown`.
- **Read `enforcementActive` with `enforcementDetermined`.** `false`/`true` means enforcement is off. `false`/`false` means the check couldn't be completed. The verdict says `NOT ACTIVE` or `UNKNOWN` to match.
- **Only the `landlock` check decides the verdict.** `seccomp`, `fuse` and `cgroups` warnings are real losses but not the capability boundary. A `runtime` fail stops the probe, so `landlock` is `unknown`, the verdict is `UNKNOWN`, and the runtime failure appears in `reasons`.

### The boot banner

`Computer.boot()`, `berth dev` and `berth os up` run the same kernel check before starting a container. When enforcement is known to be off, they print this before the container starts:

```
────────────────────────────────────────────────────────────────────────
  ENFORCEMENT IS NOT ACTIVE ON THIS HOST

  This kernel has no Landlock support (Function not implemented). On macOS
  that is Docker Desktop's linuxkit kernel.

  Capabilities in berth.yml are still compiled and still recorded, but the
  kernel is not refusing anything: an undeclared write or connection will
  succeed. This host is not a security boundary. Run `berth doctor` for the
  details, and see docs/mac-enforcement.md for a host where it is real.
────────────────────────────────────────────────────────────────────────
```

- **Cached per kernel**, in `~/.berth/enforcement-cache.json` (under `BERTH_HOME` if set), keyed by kernel version, architecture and runtime. A kernel upgrade re-probes on its own. A probe that failed to run isn't cached.
- **Silent when the answer is `unknown`.** Run `berth doctor` to see an `unknown`.
- **Printed once per process**, even in a multi-app boot. `BERTH_NO_ENFORCEMENT_BANNER=1` turns it off.

Inside the container, `agent-init` also logs what it did. On a kernel that didn't apply the ruleset, that line starts `[agent-init] NOT RESTRICTED` and says the capabilities are recorded but not enforced.

When Berth can't enforce, it runs apps unrestricted with this warning. Set `BERTH_REQUIRE_ENFORCEMENT=1` to refuse to start an app it can't lock down instead. `Computer.boot()` sets it by default.

The checks are [`packages/docker-orchestrator/src/doctor.ts`](../packages/docker-orchestrator/src/doctor.ts); the command, `--fix` and the microVM checks are in [`packages/cli/src/commands/doctor.ts`](../packages/cli/src/commands/doctor.ts), [`packages/cli/src/util/doctor-fix.ts`](../packages/cli/src/util/doctor-fix.ts) and [`packages/cli/src/vm/doctor.ts`](../packages/cli/src/vm/doctor.ts).

## What a passing verdict tells you

`enforcement: ACTIVE` means a Landlock ruleset binds on this kernel. It doesn't mean a given app's policy is right or that the brokers are scoped as intended. It's a floor, not a proof. What Berth does and doesn't protect against is in [the threat model](./threat-model.md).
