# Confining the daemons the sandbox trusted

*Draft for publication — BUILD_PLAN M1.2.*

---

The last milestone got `CAP_SYS_ADMIN` off the agent's container by moving
the FUSE mount into a sidecar. Its honest residual was written down at the
time: the container still runs three daemons that start *before*
`agent-init` — context-bus, semantic-fs, mesh — and each was root, with no
Landlock domain at all. The carefully sandboxed app could talk to three
unsandboxed root processes sharing its namespace. That's threat model row
B4, and closing it is M1.2.

The interesting part is that the three daemons need three different answers,
because "just run it under `agent-init` like an app" only works for one of
them.

## context-bus: run it like an app

context-bus-daemon serves one Unix socket. It needs no capabilities, no
outbound network, no mount. So it gets exactly what an app gets: its own uid
(9001), and the same `agent-init` binary applies a Landlock domain, seccomp
filters, and a capability drop before `exec`ing it. The only new part is
that the *policy* is written by `entrypoint.sh` rather than compiled from a
`berth.yml` — a tiny JSON granting write access to one directory (the
socket's) and nothing else. No outbound TCP, no UDP, no namespace creation.
A compromise of the bus is now a process that can write one socket.

## semantic-fs: narrow yourself, after the mount

semantic-fs-daemon can't run under `agent-init`, and the reason is exact: a
Landlock domain refuses `mount(2)` outright, even for root — and the mount
is the daemon's whole reason to exist. It needs `CAP_SYS_ADMIN`... for
about one syscall, once, at boot.

So it narrows itself *in-process*, the instant `fuse.Mount` returns. A new
`internal/privs` package empties the entire capability bounding set and
reduces the effective set to the four file-ownership caps the daemon
actually uses afterwards (it chgrps and chmods backing files to the shared
`berth` group). `no_new_privs` makes the empty bounding set permanent across
any `exec`. After boot, `SYS_ADMIN` is gone and unrecoverable — the daemon
can serve FUSE requests but can never mount again.

One Go-specific trap worth naming: Linux capability sets are *per-thread*,
and Go's runtime has already spawned threads by the time `main` runs. The
ordinary `syscall.Syscall(SYS_CAPSET, ...)` would narrow one thread and
leave the rest holding SYS_ADMIN. `syscall.AllThreadsSyscall` is the only
coherent way to do it — and it only works because this daemon is pure Go
(no cgo threads outside the runtime's control).

## mesh: Landlock in-process, keep the network cap

mesh-daemon can't run under `agent-init` either, for the opposite reason to
semantic-fs: it holds `CAP_NET_ADMIN` for the *entire life* of the wg0
interface — every reconcile tick, every route change — and `agent-init`'s
capability drop is exactly what would take it away. It also can't drop to a
non-root uid without ambient-capability plumbing that's real scope for
another day.

What it *can* do is give up the filesystem. It applies its own Landlock
write domain — the same `from_write` rights `agent-init` uses — scoped to
the WireGuard config, its key/token directory, its control socket, and
`/dev/net/tun`. Reads stay open (it's trusted with "the network," just not
"the disk"). This has to happen in `main()` *before* the tokio runtime
builds, because `restrict_self()` binds the calling thread and is inherited
only by threads created afterwards — apply it inside the async runtime and
every already-spawned worker escapes it silently.

## The test is the argument

The done-criterion for B4 is a compromised-daemon simulation. So
[`daemon-confinement-milestone.mjs`](https://github.com/Ash20pk/BerthOS/blob/main/packages/docker-orchestrator/test/daemon-confinement-milestone.mjs)
starts a process with the daemon's *own* policy, uid, and groups, and has it
attempt a write DAC would happily allow (`/context` is group-writable to a
group the simulation holds) and a TCP connect it never declared. The kernel
refuses both. mesh-daemon ships a `--confinement-probe` subcommand that
applies its real ruleset and reports what the kernel said — denied outside
its domain, allowed inside it (the positive control). The sidecar's pid-1
`CapBnd` is checked empty, `CapEff` stripped of SYS_ADMIN, while `/context`
still round-trips a write.

And the negative control, the part that makes the rest mean something: a
`BERTH_DISABLE_DAEMON_CONFINEMENT=1` boot shows context-bus as root again,
the same out-of-domain write *succeeding*, and SYS_ADMIN back in the
sidecar's bounding set. Every check that passes above can be made to fail.

## Honest residuals

mesh-daemon keeps uid 0 and `CAP_NET_ADMIN` — netlink isn't scoped by
Landlock, so interface-level network control is the brokers' tier, not the
kernel's. semantic-fs-daemon keeps uid 0 because the `root:berth`
backing-store ownership model is built around it. The mesh control socket
still trusts request-body identity (the context-bus and semantic-fs sockets
moved to `SO_PEERCRED` earlier; mesh hasn't yet). All three are named in the
threat model's B4 row rather than left for a reader to discover.
