# Enforcement

Every capability a resident app declares in `berth.yml` is enforced somewhere: by the Linux kernel, by a proxy in the app's traffic path, or not at all (recorded only). This page lists which is which, and which hosts can enforce anything.

Run [`berth doctor`](./doctor-reference.md) to see what your machine supports. [`examples/kernel-says-no`](../examples/kernel-says-no) shows a denial in 30 seconds. How the kernel rules get applied is on [How enforcement works](./capability-tokens-reference.md).

## Kernel enforcement, by platform

Kernel enforcement uses [Landlock](https://docs.kernel.org/userspace-api/landlock.html), a Linux kernel feature. On macOS and Windows your apps run on the kernel of the Linux VM your Docker daemon lives in, so that VM's kernel is what counts.

| Host | Landlock | What works |
|---|---|---|
| Linux 6.7+ | Yes | Everything, enforced by the kernel |
| Linux 5.13 to 6.6 | Partly | `berth dev` runs with part of the policy applied (network rules need 6.7). Production images refuse to start, because the policy isn't fully applied |
| Linux older than 5.13 | No | `berth dev`; `Computer.boot()` needs the relaxed mode below |
| macOS / Windows, Docker Desktop | No (`landlock_create_ruleset` returns `ENOSYS`) | `berth dev`; `Computer.boot()` needs the relaxed mode below |
| macOS, Colima | Yes | Everything, enforced by the kernel. Setup: [Enforcement on macOS](./mac-enforcement.md), or `berth doctor --fix` |

`berth dev` uses the dev image, which runs apps even when the kernel can't enforce, so you can build resident apps on any host. When it can't enforce, each app's boot log says `NOT RESTRICTED` and an undeclared write succeeds.

Production images, which `Computer.boot()` builds, set `BERTH_REQUIRE_ENFORCEMENT=1`: an app whose policy the kernel didn't fully apply exits instead of running unrestricted. To iterate on a host without Landlock anyway:

```bash
BERTH_ALLOW_UNENFORCED=1 pnpm start
```

```ts
await Computer.boot({ apps: ["../../../apps/filesystem"], enforcement: "warn" });
```

Either prints a warning on every boot, and the app runs with whatever the kernel applied, which on Docker Desktop is nothing. An explicit `enforcement` option wins over the env var. Don't use this where isolation matters.

## Available capabilities

A capability is a `namespace:action:scope` string. You can declare any namespace, but only the ones below have something behind them. For anything else, `requestCapability()` reports `granted` if it matches your manifest and nothing enforces it.

To control which calls are allowed after a tool is reachable, see [Governance and scoping](./berth-agents-guide.md#governance-and-scoping).

| Capability | Enforced by | What it does |
|---|---|---|
| `filesystem:write:<path>` (e.g. `filesystem:write:/workspace`) | Kernel (Landlock), always on | Allows write, create, delete, rename and truncate under the declared paths only. Every app can also write its own `/tmp/<app>` scratch directory and `/dev/null`. The path must be `/workspace`, `/context`, `/tmp`, `/app` or beneath one of them; `filesystem:write:/` is refused. A missing directory is created before the rules apply. |
| `filesystem:read:<path>` (e.g. `filesystem:read:/context`) | Kernel (Landlock), always on | Reads are limited to a baseline the runtime needs (`/usr`, `/bin`, `/sbin`, `/lib`, `/etc`, `/proc`, `/dev`, `/tmp`, `/run/berth/<app>`, the app's working directory), what the app may write, the real locations of its dependencies, and what you declare. Another app's directory is in that set only when a path the app may write or declares contains it. One case to know: under `berth dev`, `/workspace` is the whole checkout (read-only), so an app that may write `/workspace` can read every app's directory in it. A booted image (`berth os up`, `Computer.boot`) has no checkout at `/workspace`. Same allowed prefixes as writes. A read path that doesn't exist at boot is not created; it's warned about and stays unreadable for that boot. |
| `network:connect:<port>` or `network:connect:*` | Kernel (Landlock for TCP, seccomp for everything else), denied by default | Declare no network capability and the app gets no outbound TCP, and no socket other than TCP, Unix or netlink: no UDP, ICMP, raw, SCTP or vsock. Declare a port and outbound TCP is allowed to that port only, and UDP is allowed so DNS works. Scoping is by port, not hostname. `*` turns outbound port scoping off; it doesn't allow listening. |
| `network:bind:<port>` | Kernel (Landlock), denied by default | Allows `bind(2)`/`listen(2)` on that port. `*` is not accepted; name the port. Separate from `network:connect:` so serving on a port doesn't widen outbound access. |
| `network:peer:<name>` or `network:peer:*` | `mesh-coordinator` (mutual consent) and a WireGuard mesh | Joins the mesh with any app whose own `network:peer:` names this app back. A one-sided declaration connects nothing. See the [mesh reference](./mesh-reference.md). |
| `browser:navigate:<pattern>` (e.g. `browser:navigate:*.github.com`) or `network:host:<pattern>` | Egress proxy | Allows outbound connections to matching hostnames only. `network:host:` is the general form for any app; call `configureEgressProxy()` from `@berthos/sdk` to route your `fetch()` through the proxy. Also declare `network:connect:8090` (the proxy's default port). See the [egress broker reference](./egress-broker-reference.md). |
| `github:read:<scope>` / `github:write:<scope>` (e.g. `github:read:repos`, `github:write:issues`) | GitHub API proxy, by method and path | `GET` and `HEAD` are `read`; every other method is `write`. Paths are matched against a route table, and anything it doesn't cover is denied. Also declare `network:connect:8092` (the proxy's default port). See the [GitHub API scoping reference](./github-api-scoping-reference.md). |
| `app:invoke:<name>` | Kernel (file permissions on a per-caller socket) | Lets this app call another app's exports in the same sandbox. The target sees which app is calling. An app that didn't declare it gets `EACCES`. The check is per app, not per export; use a governance app to allow or refuse single exports. |
| `terminal:attach:*` | Kernel (Landlock), for pty devices | Grants write access to `/dev/pts` and `/dev/ptmx`, so the app can open a shell, and lets it listen on the ttyd port. It doesn't limit what the shell does; that comes from the app's `filesystem:` and `network:` capabilities. Also makes `berth dev` publish the terminal view on `127.0.0.1`, behind a per-boot password. Opt out with `expose: { terminal: false }`. |
| `browser:screenshot:*` | Recorded only | Nothing enforces it. Any `browser:*` capability makes `berth dev` publish the noVNC/VNC view on `127.0.0.1`, behind a VNC password. Chromium's debugging port is never published. Opt out with `expose: { browser: false }`. |

Granting a capability and letting a human watch its session are separate choices; see `expose:` in the [manifest reference](./manifest-reference.md).

## Enforcement levels

| Level | Mechanism | What it means |
|---|---|---|
| **Kernel** | Landlock, seccomp, dropped Linux capabilities, a separate uid per app | Applied before the app's first line runs and inherited by every process it starts. Nothing inside the sandbox can loosen it. |
| **Proxy** | The egress proxy and the GitHub API proxy | A process in the traffic path. It can only be bypassed by reaching the network some other way, which the kernel level blocks. Finer-grained than the kernel (hostnames, API paths). |
| **Recorded** | `browser:screenshot:*` and any namespace nothing implements | Reported by `requestCapability()` and used for `expose:` decisions. Not a control. |

Who each level protects against is in the [threat model](./threat-model.md).

## Optional hardened runtime (gVisor / `BERTH_RUNTIME`)

Set `BERTH_RUNTIME=runsc` (or pass `runtime` to `startContainer()`) to run sandboxes under [gVisor](https://gvisor.dev), which puts its own userspace kernel between the sandbox and your host kernel. That protects against a container-escape exploit.

gVisor doesn't implement Landlock, so under `runsc` you lose the kernel level entirely: agent-init reports `ruleset=NotEnforced` and a production image refuses to boot. Today you choose between escape protection and capability enforcement. `berth doctor --runtime runsc` checks the daemon has the runtime and runs the kernel probe under it, so run it again if you switch to a runtime whose kernel has Landlock (such as Kata).

## Limits

- Full enforcement needs Linux 6.7+ (Landlock ABI 4, which adds network rules). On 5.13 to 6.6 the policy is only partly applied, and a production image refuses to start. `berth doctor` reports `NOT ACTIVE` there, naming the kernel's ABI, and `berth dev` prints a partial-enforcement banner.
- An app that declares any `network:connect:` port can use UDP to any destination, because it needs DNS. The same goes for other non-TCP protocols such as SCTP; only vsock stays refused.
- No app can use io_uring: it returns `ENOSYS`, because io_uring can open sockets without the `socket(2)` call the rules above check. Node falls back to its ordinary I/O paths; a program that requires io_uring won't run.
- `docker exec` or root on the host bypasses all of this.

Manifest fields are in the [manifest reference](./manifest-reference.md); `requestCapability()` and the rest of the SDK are in the [SDK reference](./sdk-reference.md).
