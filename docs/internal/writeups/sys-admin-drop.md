# Getting CAP_SYS_ADMIN out of the agent's container

*Draft for publication — BUILD_PLAN M1.1.*

---

Every Berth sandbox used to carry `CAP_SYS_ADMIN` — the "basically root"
capability — because one daemon needed one `mount(2)` for the semantic
filesystem at `/context`. The apps never saw it (`agent-init` drops the
bounding set before any app runs), but every pre-enforcement process did,
and "the container has SYS_ADMIN" is the first thing a reviewer finds.

The constraint that shaped the fix: a capability granted at `docker create`
is the *ceiling* for everything inside. If `docker inspect` must show no
SYS_ADMIN, nothing inside the sandbox can ever perform the mount. So the
mount comes from outside:

- A per-sandbox **sidecar container** runs just `semantic-fs-daemon` with
  the capability, and mounts into a host directory bound with `rshared`
  propagation.
- The sandbox receives the live FUSE mount as an ordinary `rslave` bind —
  no capability, no `/dev/fuse`, no `apparmor:unconfined`.

Now `mount(2)` inside the sandbox fails `EPERM` — for the apps, for the
remaining daemons, for root via `docker exec`. The kernel refuses, not
configuration.

## Two things implementation taught us

1. **macOS virtiofs eats your ownership model.** The backing store's whole
   access model is `root:berth` group modes — and `chown` doesn't survive a
   virtiofs share. Only the mountpoint needs a host path (propagation
   requires a bind); the data and control socket moved to named volumes.
2. **Pids don't cross namespaces; uids do.** Write attribution was
   pid-based, which silently assumed daemon and apps share a pid namespace.
   The orchestrator now declares the per-app uid map to the sidecar, and
   attribution falls back from pid to uid.

## Verified

[`sys-admin-drop-milestone.mjs`](https://github.com/Ash20pk/BerthOS/blob/main/packages/docker-orchestrator/test/sys-admin-drop-milestone.mjs):
clean inspect, live writable propagated mount, `mount(2)` EPERM — and the
negative control: a `BERTH_DISABLE_FS_SIDECAR=1` boot shows the capability
back and the same mount succeeding. The full semantic-fs behavior suite
passes unchanged through the sidecar.

## Honest residuals

The sidecar itself still holds SYS_ADMIN — one process, no app code, and
narrowing it post-mount is the next milestone. Hosts without `rshared`
propagation fall back to the old posture *visibly* (the capability is in
`inspect`, and the boot says why). The context-bus and mesh daemons are
still unconfined inside the sandbox — that's M1.2, not a footnote.
