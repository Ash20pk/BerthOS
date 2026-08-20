# Design: dropping container-wide `CAP_SYS_ADMIN` (BUILD_PLAN M1.1)

Status: **proposed** — written 2026-08-20, before implementation, because
this touches every boot path. REMEDIATION 1.3's remainder; threat model B4
adjacent.

## The problem

`container.ts:329` adds `CAP_SYS_ADMIN` to every sandbox unconditionally,
because `semantic-fs-daemon` calls `mount(2)` (via bazil.org/fuse's
`fuse.Mount`, `main.go:98`) to put the semantic filesystem at `/context`.
`agent-init` drops the whole bounding set before any *app* process runs, so
apps never see the cap — but every pre-`agent-init` process does (threat
model B4), and the done-criterion for M1.1 is stronger than "apps can't use
it": **`docker inspect` on a booted sandbox shows no `SYS_ADMIN` at all.**

That criterion kills the easy designs, and it's worth writing down why.

## The constraint that shapes everything

`mount(2)` requires `CAP_SYS_ADMIN` **in the mount namespace's owning user
namespace**. Capabilities granted at `docker create` are the ceiling for
everything inside the container — a setuid `fusermount3` cannot grant a cap
that isn't in the container's bounding set. So if the inspect output must not
show `SYS_ADMIN`, *nothing that lives inside the sandbox container can ever
perform the mount*. The mount must come from outside. Two real ways exist.

## Option A — privileged one-shot `docker exec`

`ExecCreate` accepts `Privileged: true`, which grants full capabilities
inside the container's namespaces regardless of the container's own `CapAdd`.
The orchestrator could, post-start, run a privileged exec that performs the
mount and hands the `/dev/fuse` fd to the unprivileged daemon (the
`_FUSE_COMMFD` handoff fusermount uses).

Rejected, for three reasons:

1. **bazil.org/fuse doesn't accept an injected fd** — `fuse.Mount` owns the
   mount path. We'd be reimplementing the fusermount fd-passing protocol on
   both sides, across a `docker exec` boundary that doesn't inherit fds, so
   the handoff needs a Unix socket rendezvous inside the container. That's a
   custom privileged protocol in the most security-sensitive spot we have.
2. **The privileged window is code we choreograph from the host** on every
   boot, forever — a standing invitation for a race (an app process must
   provably not exist yet, on every path: single-app, multi-app, snapshot
   restore, `berth os up` reconnect).
3. It leaves the daemon *inside* the sandbox, which M1.2 then has to confine
   anyway.

## Option B — sidecar mount container (recommended)

Move the FUSE mount out of the sandbox entirely: a per-sandbox
**semantic-fs sidecar container** runs `semantic-fs-daemon` and mounts
`/context` into a host directory that the sandbox receives as an ordinary
bind mount.

Mechanics (all standard Docker, no privileged exec, no custom protocol):

- Orchestrator creates a per-sandbox host dir, e.g.
  `$BERTH_RUN_DIR/context/<sandbox>/` with a `mnt/` mountpoint inside it.
- Sidecar container `berth-fs-<sandbox>`: image is the existing base image
  (it already contains the daemon binary), `CapAdd: [SYS_ADMIN]`,
  `Devices: /dev/fuse`, `SecurityOpt: apparmor:unconfined`, and a bind of
  the host dir with **`rshared` propagation** (`Binds:
  ["<hostdir>:/context-export:rshared"]`). It runs only the daemon; the
  daemon mounts at `/context-export/mnt`. Shared propagation makes the FUSE
  mount visible on the host side of the bind.
- Sandbox container: `Binds: ["<hostdir>/mnt:/context:rslave"]`, **no
  `CapAdd`, no `/dev/fuse`, no apparmor exception** (the apparmor:unconfined
  and device grant move to the sidecar — two more standing exceptions leave
  the sandbox).
- `allow_other` + `default_permissions` (already set, `main.go:80`) is what
  makes the mount usable across the container boundary: the sandbox's uids
  are judged by the kernel against the `root:berth`-owned backing metadata
  exactly as today.
- Control socket: today apps reach the daemon at `/tmp/berth-semantic-fs.sock`
  (group `berth`). The socket moves into the shared host dir
  (`<hostdir>/ctl.sock`) and is bind-mounted to the same in-sandbox path, so
  the SDK client doesn't change.

Ordering: the sidecar starts first; the orchestrator waits for
`<hostdir>/mnt` to report `fuse` in the *sidecar's* `/proc/mounts` (or
simply for a sentinel file the daemon writes post-mount) before creating the
sandbox. The sandbox's entrypoint loses its semantic-fs start/wait block
entirely — one less root daemon inside the boundary, which is a down payment
on M1.2.

### What this does and doesn't fix

- **Fixes:** no `SYS_ADMIN`, no `/dev/fuse`, no `apparmor:unconfined` on the
  sandbox; `mount(2)` from *any* process in the sandbox — root daemon
  included — fails `EPERM`; semantic-fs-daemon compromise is contained to a
  container holding only `/context` data (still `SYS_ADMIN`-privileged in
  its own container — M1.2 narrows that next, e.g. dropping post-mount via
  Go's `AllThreadsSyscall(SYS_CAPSET)` once the mount is up).
- **Doesn't fix:** context-bus and mesh daemons still run in-sandbox as root
  (M1.2); the mesh path still adds `NET_ADMIN`+`/dev/net/tun` when
  `network:peer:*` is declared — out of scope here, same treatment possible
  later.

### Host-support risk (must be probed, not assumed)

`rshared` bind propagation requires the daemon's host to support it.
Linux/Colima: yes. Docker Desktop for Mac (VirtioFS): unverified — but
Docker Desktop can't enforce Landlock anyway, so the fallback is acceptable:
**if the sidecar mount fails to propagate, fall back to today's in-sandbox
mount and say so** (doctor check + boot banner), exactly the honesty pattern
`berth doctor` already uses. The fallback keeps `CapAdd: [SYS_ADMIN]`, so
`docker inspect` tells the truth in both modes.

## Migration and blast radius

Every boot path constructs containers through
`packages/docker-orchestrator/src/container.ts` — single-app, multi-app,
snapshot restore, `berth os up`, the k8s/E2B/Daytona adapters (which don't
use the Docker path and are unaffected in this change; k8s needs its own
design later). Work items:

1. `container.ts`: sidecar lifecycle (create/start/wait/stop with the
   sandbox; `AutoRemove` tied together), bind rewiring, cap removal behind a
   probe-once host-capability check.
2. `entrypoint.sh`: delete both semantic-fs start blocks (single- and
   multi-app paths); keep the SDK's stub-fallback warning pointed at the new
   arrangement.
3. Snapshot/restore: `/context` data lives in the same backing dir as today
   (`BERTH_CONTEXT_DATA`), now owned by the sidecar — snapshot code must
   snapshot the sidecar's volume, not the sandbox's.
4. `berth doctor`: new check — sidecar mode active vs fallback.
5. Threat model: B4 row narrowed (semantic-fs out of the sandbox), 1.3
   remainder closed for the sandbox container; residual named (sidecar still
   privileged; context-bus/mesh still in-sandbox).

## Verification (the row's own bar)

- `docker inspect` on a booted sandbox: `CapAdd` contains no `SYS_ADMIN`
  (asserted in a new milestone test).
- `semantic-fs-milestone.mjs` passes unchanged (tag/query through `/context`).
- **Negative control:** `docker exec` into the sandbox, attempt
  `mount -t tmpfs none /mnt` → `EPERM`, asserted in the milestone test —
  and proven able to fail by running it against a pre-change container where
  the same mount succeeds.
- Fallback path: the same test on a host without propagation support
  asserts the honest degradation (caps present, banner says so).
