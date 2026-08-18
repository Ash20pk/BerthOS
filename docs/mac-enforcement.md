# Real kernel enforcement on macOS

Berth's capability scoping is enforced by [Landlock](https://docs.kernel.org/userspace-api/landlock.html),
which is a Linux kernel feature. On macOS your apps do not run on your laptop's
kernel — they run on the kernel inside whatever Linux VM your Docker daemon
lives in. So the question "can Berth enforce anything on my Mac?" is entirely a
question about that VM's kernel, and the two common answers differ completely:

| Docker runtime | Kernel | `berth doctor` |
|---|---|---|
| Docker Desktop | `6.10.14-linuxkit` — no Landlock at all; `landlock_create_ruleset` returns `ENOSYS` | `enforcement: NOT ACTIVE` |
| Colima (default VM) | `6.8.0-117-generic`, Ubuntu 24.04 — Landlock ABI 4, active in the LSM stack | `enforcement: ACTIVE` |

This page is the second row: one recipe, run start to finish on an Apple-silicon
Mac, that ends in a kernel that really refuses an undeclared write. Everything
below was observed, not inferred — the verdicts and error strings are copied
from the run recorded at the bottom.

**No custom kernel is needed.** Earlier notes in this repo assumed a Mac
enforcement path would mean building or fetching a Landlock-enabled kernel
image. It doesn't: Colima's default Ubuntu 24.04 guest already ships `landlock`
in its active LSM stack, which is the part Docker Desktop's linuxkit kernel is
missing. The recipe is therefore an install and four flags.

## The recipe

### 1. Install Colima

```bash
brew install colima docker
```

`docker` is the CLI only (Colima provides the daemon). If you already have
Docker Desktop installed, leave it — Colima registers a separate daemon and a
separate `docker` context, and step 5 shows how to go back.

### 2. Start the VM

```bash
colima start \
  --cpu 4 --memory 8 --disk 60 \
  --vm-type vz --mount-type virtiofs \
  --mount "$HOME:w"
```

Each flag is load-bearing:

- **`--cpu 4 --memory 8 --disk 60`** — Berth's app images build a Rust
  `context-bus` binary and a Go/Rust `agent-init`; Colima's 2 CPU / 2 GB default
  makes a first build slow enough to look hung. 60 GB of disk is for the layer
  cache across several app images.
- **`--vm-type vz`** — Apple's Virtualization framework rather than QEMU. On
  Apple silicon this is the difference between a native-speed VM and an emulated
  one.
- **`--mount-type virtiofs`** — required by `vz`, and much faster than sshfs for
  the repo bind mount that `berth dev` puts at `/workspace`.
- **`--mount "$HOME:w"`** — Colima mounts your home directory **read-only** by
  default. Berth bind-mounts your checkout into the container read-write, so
  without `:w` every app write fails with `EROFS` and you will misread it as an
  enforcement denial.

### 3. Point Berth at the Colima daemon

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
```

**`docker context use colima` is not enough**, and this is the one step that
will silently waste your afternoon. `colima start` switches the *Docker CLI's*
context for you, so `docker info` immediately reports the Ubuntu kernel — but
Berth talks to the daemon through dockerode, which reads `DOCKER_HOST` and does
not read Docker CLI contexts. Skip the export and `berth doctor` cheerfully
probes Docker Desktop's linuxkit kernel and reports `NOT ACTIVE` while
`docker info` two lines earlier said Ubuntu. Verified the hard way.

Put it in your shell profile, or use the script:

```bash
./scripts/mac-enforcement.sh          # install + start + export + berth doctor
```

### 4. Check

```bash
berth doctor
```

On a correct setup, all four checks pass and the command exits 0:

```
Kernel that runs Berth's apps: 6.8.0-117-generic (Ubuntu 24.04.4 LTS)
Probed in: python:3.12-slim

  ✔ Docker daemon reachable
      Ubuntu 24.04.4 LTS (29.5.2), kernel 6.8.0-117-generic on aarch64
  ✔ Docker's default seccomp profile
      profile=builtin
  ✔ Landlock enforcement in the container kernel
      a ruleset granting nothing denied a write (ABI 4) — write refused with Permission denied
  ✔ /dev/fuse available to a sandbox
      present when requested as a device

enforcement: ACTIVE
```

If the kernel line still says `linuxkit`, `DOCKER_HOST` is not set — go back to
step 3. `berth doctor` needs one local image containing `python3` to probe in;
any Berth app image qualifies, and before you have built one,
`berth doctor --image python:3.12-slim` (after `docker pull python:3.12-slim`)
works. See [doctor-reference.md](./doctor-reference.md) for the `--json`
contract and the full verdict table.

### 5. Going back to Docker Desktop

```bash
unset DOCKER_HOST
docker context use desktop-linux
colima stop                 # or `colima delete` to reclaim the disk
```

Nothing Berth writes is Colima-specific, so you can move back and forth; you
will just be back to `enforcement: NOT ACTIVE` when you do.

## What was actually verified here

`berth doctor` reporting `ACTIVE` is a claim about the kernel, not about Berth's
policy. So the recipe was also checked against the capability-denial milestone,
which boots a real app from a real manifest and tries to escape it:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
node packages/docker-orchestrator/test/capability-enforcement.mjs
```

It exits 0, and `agent-init` reports the ruleset it managed to install:

```
[agent-init] landlock restrict_self() status: ruleset=FullyEnforced no_new_privs=true
```

That line is what makes the run meaningful. The milestone's assertions are
conditional on it: on a non-enforcing kernel the script degrades to warnings, so
a green run on Docker Desktop proves very little. `FullyEnforced` means every
assertion below ran as a hard assertion, and the denials are the kernel's:

- an undeclared write outside the declared `filesystem:write:/workspace` scope:
  `EACCES: permission denied, open '/etc/berth-should-not-exist.txt'`
- an undeclared read: `EACCES ... open '/opt/berth-should-not-be-readable.txt'`
- an app declaring no `network:connect`: `connect EACCES 1.1.1.1:80`; UDP
  `bind EPERM`; raw socket refused
- a symlink planted *inside* the granted path, pointing out of it — denied at
  the resolved target, not the link
- 20 concurrent out-of-scope writes: 20/20 denied
- `truncate(2)` outside the scope, which is the write path that does not go
  through `open(O_WRONLY)`: denied
- `unshare(CLONE_NEWUSER)`, which would undo the capability bounding-set drop:
  `Operation not permitted`
- cross-app: app A reaching app B's directory and RPC socket in the same
  container — `EACCES`, and app C, which declared `app:invoke:boundary-app-b`,
  reaching only the peer socket declared for it

This is the first time in this repo's history that the enforcing half of that
matrix has been *observed* rather than reasoned about, and it immediately found
a bug in `berth doctor` itself: the kernel probe resolved its scratch path with
`tempfile.gettempdir()` *after* binding a ruleset that grants nothing, and
`gettempdir()` looks for a writable directory by creating a file in it. On every
kernel that genuinely enforced the ruleset, the probe therefore died with a
traceback and the report said `UNKNOWN` — the one host class where the answer
was `ACTIVE` was the one class it could not report. Fixed by resolving the path
before `restrict_self()`. The lesson is the same one this doc exists to serve: a
verdict table exercised only in its failing half is not tested.

## Lima, and other routes

Colima is a thin wrapper over [Lima](https://lima-vm.io) — `colima start`
provisions a Lima VM from an Ubuntu image and wires up the Docker socket.
Plain Lima with `template://docker` reaches the same kernel and will work on the
same principle, and so will any Linux VM running a distro that keeps `landlock`
in `CONFIG_LSM` (Ubuntu 22.04+, Fedora, recent Debian). Neither was run here, so
this doc documents the one that was. If you verify another, check
`cat /sys/kernel/security/lsm` inside the guest — the string must contain
`landlock` — and then run the two commands above.

## What this does not fix

An enforcing kernel closes the gap between what Berth's manifests declare and
what the kernel refuses. It does not close the rest:

- The in-container and cross-app gaps still open in
  [internal/REMEDIATION.md](./internal/REMEDIATION.md) are unaffected by which
  VM you run. Berth is not yet a boundary to trust against an attacker who
  already has code execution inside the container.
- Colima's daemon reports `seccomp profile=builtin` (Docker Desktop reports
  `unconfined`), which is a genuine improvement, but Berth's own seccomp filters
  never depended on it.
- macOS-side isolation is unchanged: the VM boundary is Docker's, and your
  bind-mounted home directory is inside it, writable, by construction of step 2.

---

*Recorded 2026-08-18 on macOS (Darwin 25.6.0, Apple silicon) with Colima 0.10.3,
Lima 2.2.0, guest Docker 29.5.2, guest kernel 6.8.0-117-generic, Landlock ABI 4.*
