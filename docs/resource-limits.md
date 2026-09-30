# Resource limits

Every app in a sandbox runs in a cgroup of its own, with the limits its `berth.yml` declares under [`resources`](./manifest-reference.md#resources-default-). The Berth daemons and brokers run in a sibling cgroup the apps can't starve. One app that fork-bombs, leaks memory or spins on the CPU hits its own limits. Its neighbours and the daemons keep answering.

This page covers the local Docker sandbox (`berth dev`, `berth test`, `berth os up`, Computers). Other targets are in the [manifest reference](./manifest-reference.md#resources-default-).

## What each key becomes

For one app:

| `resources:` key | cgroup v2 file | Value |
|---|---|---|
| `cpu: 0.5` | `cpu.max` | `50000 100000`: half a core over each 100ms period |
| `memory_mb: 256` | `memory.max` | 256 MiB. Past this, the kernel OOM-kills in this app's cgroup |
| | `memory.swap.max` | `0`, so the limit can't be paged around |
| `pids: 64` | `pids.max` | 64 tasks. That counts threads as well as processes. `fork()` and `clone()` past it fail with `EAGAIN` |
| `gpu` | none | A device request on the container, shared by every app in it. No cgroup divides a GPU |

An app that declares nothing still gets limits:

- `cpu.weight` 100, the same as every other app, so apps split contended CPU evenly.
- `pids.max` 1024. That's high enough for Chromium under Playwright, which uses several hundred threads, and it still stops a fork bomb.
- No `memory.max` of its own. It shares the apps' memory budget (below).

There is no `memory.high`, deliberately. Past `memory.high` the kernel throttles an app and tries to reclaim its memory instead of killing it. A sandbox has no swap, so there's nowhere to reclaim anonymous memory to: an app that leaks past `memory.high` slows to a crawl and can stay there indefinitely without ever reaching `memory.max`. A leak then looks like a hang. With `memory.max` alone, the process that goes past the limit is OOM-killed straight away, in the app's own cgroup, and `memory.events` counts it (`oom_kill`). The app's supervisor, and anyone reading the boot log, can see that.

The files come from each app's capability policy (`cgroupLimits` in `.berth/capability-policy.json`), which the policy compiler writes from `berth.yml`. The TypeScript and Python compilers produce identical output, and a parity test checks that.

### Why the default task limit is 1024

`pids.max` counts tasks, and a thread is a task. So the number that matters is threads, not processes. A Node runtime is about a dozen tasks before the app does anything. Chromium under Playwright is several hundred across its browser, GPU, network and renderer processes, and grows with each page. A default in the tens or low hundreds would make a browser app fail with `EAGAIN` in ordinary use, which looks like a crash with no obvious cause. 1024 leaves room for that, and it still stops a fork bomb well short of the sandbox's own limit (the apps' sum plus the daemons' 1024), so the daemons and the other apps keep running. An app that needs less, or more, declares `pids`.

## The sandbox around them

```
/sys/fs/cgroup                the sandbox (Docker's container cgroup)
└── berth/
    ├── daemons/              tini, the entrypoint, context-bus, semantic-fs,
    │                         the egress and GitHub brokers, mesh, and every
    │                         `docker exec` (including the RPC relay)
    └── apps/                 all the apps together: the sandbox's memory
        ├── <app>/            minus the daemon reserve
        └── ...
```

- **Daemon reserve.** `daemons/` has 10 times the CPU weight of `apps/`. When both want the CPU, a spinning app gets about 10% of what the daemons ask for. Memory is reserved by subtraction: `apps/` gets `memory.max` equal to the sandbox's memory minus 256 MiB. Every app together can exhaust its budget and the daemons still have theirs.
- **Container caps.** Docker's limits on the container are the sum of the apps' limits plus the reserve (0.5 CPU, 256 MiB, 1024 tasks). They used to be the largest value across the apps. `PidsLimit` is always set, because every app has a task limit. CPU and memory are capped at the container only when every app declares them. If one app declares nothing, there is no number to add. The container is then bounded by the host for that resource, and inside it `apps/` still leaves the daemons their reserve (worked out from the host's total memory). The CPU sum is clamped to the host's CPU count, because Docker refuses a larger value.

## How the sandbox gets a writable cgroup

Docker mounts `/sys/fs/cgroup` read-only in an unprivileged container. The usual ways around that are `--privileged` or `CAP_SYS_ADMIN` to remount it, and the sandbox is designed to have neither. Berth instead passes Docker's `--security-opt writable-cgroups=true` (Docker 28 and later). With the default private cgroup namespace, that option makes the container's own cgroup subtree writable by root in the container, and nothing else. The container can't see any cgroup above its own, and its capability set is unchanged.

That's only safe with one host setting: the cgroup2 hierarchy has to be mounted with `nsdelegate`. With it, the kernel refuses (`EPERM`) any write from inside a cgroup namespace to the namespace root's own limit files, which are the files Docker's `--memory` and `--pids-limit` live in. Without it, root in the sandbox could raise the caps that bound the sandbox. So Berth requests the option only when the kernel probe (the one behind `berth doctor`) saw cgroup v2 with `nsdelegate`. systemd hosts, Colima and Lima all mount it that way. Anywhere else, the sandbox boots with the container-level caps alone and says why.

Inside the sandbox, `entrypoint.sh` sets everything up as root, before any daemon starts:

1. It moves tini (PID 1) and itself into `berth/daemons`. The kernel's "no internal processes" rule means a cgroup that has processes can't turn on controllers for its children.
2. It enables `cpu`, `memory` and `pids` down to `berth/apps`, and writes the daemon reserve.
3. For each app, just before that app's shell execs `agent-init`, it creates `berth/apps/<app>`, writes the limits and moves the shell in. Everything the app starts inherits the cgroup.

Nothing in these steps goes through Docker's API. The same files exist in a microVM guest kernel, so the in-sandbox half carries over unchanged.

An app can't move itself out of its cgroup or loosen its limits. The cgroup files belong to root, mode 0644, in root's 0755 directories. The app runs as its own uid with no capabilities. `agent-init` never grants a Landlock write under `/sys`, whatever the policy says. Each of these is tested: a unit test on `agent-init`'s allowlist, one on the policy compiler, and the milestone below, which tries every cgroup file from inside the app and from its bare uid.

## Checking it

`berth doctor` has a `cgroups` check. `ok` means sandboxes on this host get per-app cgroups. `warn` names what's missing. It doesn't affect the enforcement verdict, which is about Landlock.

The boot log says what happened:

```
[berth:entrypoint] per-app cgroups active (controllers: cpu memory pids): daemons in /berth/daemons (cpu.weight 1000, 256 MiB held back from the apps), apps under /berth/apps (memory.max 1786396672)
[berth:entrypoint] cgroup-neighbour runs in cgroup /berth/apps/cgroup-neighbour: cpu.max=max/100000 cpu.weight=100 memory.max=max memory.swap.max=max pids.max=1024
[berth:entrypoint] cgroup-hog runs in cgroup /berth/apps/cgroup-hog: cpu.max=50000/100000 cpu.weight=100 memory.max=100663296 memory.swap.max=0 pids.max=64
```

or `per-app cgroups inactive: <reason>`. The same facts are logged as JSON events (`cgroup_delegation`, `cgroup_limits_applied`), with each app's limits read back from the kernel. `berth attest` collects them into the boot evidence as `resourceLimits`; see the [attestation reference](./attestation-reference.md).

`packages/docker-orchestrator/test/resource-limits-milestone.mjs` checks all of this end to end. A two-app sandbox runs one app that fork-bombs, allocates past its memory limit (and has to be OOM-killed for it, not stalled) and spins eight busy loops, while a neighbour app that declares nothing, and a context-bus round trip, keep answering. A control boot with per-app cgroups turned off shows the same fork bomb isn't stopped at the app's limit.

## Turning it off

`BERTH_DISABLE_APP_CGROUPS=1` on the host (or in the sandbox's environment) skips per-app cgroups. The container-level caps still apply.

## Limits

- **The OOM killer picks a process, not the app.** Past `memory.max` the kernel kills the largest process in the app's cgroup. That's usually the one that allocated, but for a single-process app it's the app itself, which then exits like any other crash.
- **No I/O limits.** `io.max` needs a block device's major:minor, which a portable manifest can't name, and `io.weight` only works with the BFQ scheduler.
- **The semantic-fs sidecar is a separate container** with its own limits, outside the sandbox's.
- **Everything shares one GPU request.** `gpu` stays the largest count any app asks for.
