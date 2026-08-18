# `berth doctor`

Answers one question, loudly: **can the kernel that will run your apps actually enforce the capabilities in your `berth.yml`?**

```
berth doctor
berth doctor --json
berth doctor --image berth/filesystem:dev
berth doctor --no-probe
```

Exit code is `0` only when enforcement is active. Anything else — off, or not established — exits `1`, so this works as a CI gate or a preflight in a script.

## Why this is not a check on your laptop

The kernel that matters is almost never the one the CLI runs on. On macOS and Windows your apps run inside Docker's Linux VM, so the honest question is about *that* kernel. Reading the host's `/sys/kernel/security/lsm` would answer a question nobody asked — on macOS the file doesn't exist, and its absence says nothing at all about whether Berth can enforce.

So every kernel-level check runs **inside a container**, against the daemon's kernel. `berth doctor` prints which kernel that was, first, because it's the single most misread thing here.

## What it checks

| Check | `id` | What it means |
|---|---|---|
| Docker daemon reachable | `docker` | `ping()` plus version, kernel and arch. Gating: every kernel fact below comes from a container. |
| Landlock enforcement | `landlock` | The verdict-deciding check. See below. |
| Docker's default seccomp profile | `seccomp` | Read from the daemon. A `warn` here is not fatal — `agent-init` installs its own two filters regardless — but Docker's defence-in-depth is absent. |
| `/dev/fuse` available | `fuse` | Probed with the same `Devices` and `CapAdd` a real boot uses, because `/dev/fuse` is never present in a default container. Semantic FS mounts `/context` over FUSE. |

### The Landlock check is behavioural, and that's the point

Landlock can be missing in two ways that look identical from the outside:

1. **The syscalls aren't there.** `landlock_create_ruleset` returns `ENOSYS`. This is Docker Desktop for Mac's linuxkit kernel.
2. **The syscalls are there but `landlock` isn't in the kernel's active LSM stack.** Every call succeeds, `restrict_self()` returns 0, and *nothing is ever denied*.

(2) is the dangerous one — the sandbox is decorative and every code path reports success. So the probe doesn't ask the kernel what it supports; it **builds a ruleset that grants nothing and then tries to open a file for writing.** An enforcing kernel refuses it. That answer can't be faked by a kernel with the ABI present and the LSM absent.

Reading `/sys/kernel/security/lsm` would also distinguish them, but securityfs isn't mounted in an unprivileged container, so it costs a `--privileged` container. A diagnostic shouldn't need that. This probe needs no privilege at all — Landlock is unprivileged by design.

The probe tests the *kernel*, not Berth's policy. It deliberately does not rebuild what `agent-init` composes from a manifest; that would be a second implementation to drift.

## `--json`

Schema version `1`. Additive changes (new checks, new optional fields) keep `schemaVersion: 1`; anything that breaks a reader bumps it.

```jsonc
{
  "schemaVersion": 1,
  "enforcementActive": false,     // true only when the kernel can enforce
  "enforcementDetermined": true,  // whether the question was answered at all
  "verdict": "enforcement: NOT ACTIVE (…)",
  "reasons": ["the Landlock syscalls are not available in this kernel (Function not implemented)"],
  "checks": [
    {
      "id": "landlock",                   // "docker" | "landlock" | "seccomp" | "fuse" — stable
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
  "probeImage": "berth/filesystem:dev"    // omitted when the probe didn't run
}
```

Three contract details worth relying on:

- **`unknown` never means "probably fine".** A check that didn't run has not passed. `--no-probe`, an unreachable daemon, and a probe that failed to start all report `unknown`.
- **`enforcementActive: false` is not by itself a finding.** Pair it with `enforcementDetermined`: `false`/`true` means enforcement is off; `false`/`false` means the check failed and nothing was established. The `verdict` string says `NOT ACTIVE` vs `UNKNOWN` for the same reason.
- **A `warn` never decides the verdict.** Only the `landlock` check does. `seccomp` and `fuse` warnings describe real losses (Docker's default profile, Semantic FS) that are not the capability boundary.

## The probe image

The probe needs a container with `python3`, which every Berth app image has. It prefers an image already present locally, because a diagnostic that silently pulls hundreds of megabytes before answering is one people stop running. Order: a `berth/*` image, then a `python*` image, then `unknown` with a remedy — never a pull you didn't ask for. `--image` overrides.

## The boot banner

The same check runs at every `Computer.boot()`, `berth dev` and `berth os up` — they all funnel through `startContainer()` — and prints an unmissable banner **before** the container starts when enforcement is positively determined to be off:

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

Three deliberate choices:

- **Cached per kernel**, in `~/.berth/enforcement-cache.json`, keyed by kernel version and architecture. This is a property of a kernel, not of a boot, so re-probing on every `berth dev` would put a container start in the primary workflow for no new information. A kernel upgrade re-keys and re-probes on its own. A probe that *failed* is never cached, since it established nothing.
- **Silent on `unknown`.** A preflight that cries wolf whenever it couldn't reach something gets configured away, and then the real banner goes unread too. `berth doctor` is where `unknown` is reported as `unknown`, because someone running it is asking directly.
- **Once per process.** A banner repeated per app in a multi-app boot is one people learn to skip. `BERTH_NO_ENFORCEMENT_BANNER=1` suppresses it.

### The `agent-init` line this replaced

On a kernel without Landlock, and when enforcement is not *required* — which is every `berth dev`, the primary workflow — `agent-init` used to print:

```
[agent-init] restricted "filesystem" — write access allowed only under: /workspace (…)
```

That sentence was false: nothing had been restricted. It was also the only thing the boot said about enforcement. It now follows the ruleset status, and says `NOT RESTRICTED … recorded but NOT enforced` when that's what happened.

## What a passing verdict does and doesn't tell you

`enforcement: ACTIVE` means a Landlock ruleset **binds** on this kernel. It does not mean any particular app's policy is correct, that the brokers are scoped as intended, or that the boundaries hold under attack — those are separate claims with their own tests ([the threat model](./threat-model.md), and the milestone suite). It is a floor, not a proof.

## Verdicts observed, and on what

Both halves of the verdict table have now been seen on real hardware, which
matters because until 2026-08-18 only the failing half had:

| Host | Kernel | Verdict | Exit |
|---|---|---|---|
| Docker Desktop for Mac 28.0.1 | `6.10.14-linuxkit` | `NOT ACTIVE (the Landlock syscalls are not available in this kernel (Function not implemented))` | 1 |
| Colima 0.10.3, default VM | `6.8.0-117-generic` (Ubuntu 24.04) | `ACTIVE` — "a ruleset granting nothing denied a write (ABI 4)" | 0 |

The second row is the recipe in [mac-enforcement.md](./mac-enforcement.md), and
running it found a bug in this command. The probe resolved its scratch path with
`tempfile.gettempdir()` *after* calling `restrict_self()` on a ruleset that
grants nothing — and `gettempdir()` finds a writable directory by creating a
file in each candidate, so on a genuinely enforcing kernel it raised instead of
returning a path. The probe died with a traceback and the report said `UNKNOWN`.
The one class of host where the answer was `ACTIVE` was the one class that could
not report it, and every unit test passed throughout, because the tests inject a
fake probe rather than running the Python. Fixed by resolving the path first;
recorded here because "the failing path is well tested and the passing path has
never run" is the shape of the next bug too.
