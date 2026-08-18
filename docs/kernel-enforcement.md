# Enforcement: what holds, where, and what doesn't

The claim Berth makes is narrow and testable: a resident app's declared
filesystem and network scope is compiled into a kernel policy applied before the
app's own code runs. This page is where that claim is qualified — which hosts can
enforce it, which capabilities are kernel-enforced versus brokered versus merely
recorded, and which holes are still open.

Run [`berth doctor`](./doctor-reference.md) to find out what *your* host does.
[`examples/kernel-says-no`](../examples/kernel-says-no) is the 30-second
demonstration.

## Kernel enforcement, by platform

Berth's capability scoping is enforced by [Landlock](https://docs.kernel.org/userspace-api/landlock.html), a Linux kernel feature. Whether your kernel provides it decides what you can run locally:

| Host | Landlock | What works |
|------|----------|------------|
| Linux, kernel 5.13+ | Enforced | Everything, with real kernel enforcement |
| Linux, kernel < 5.13 | Unavailable | `berth dev`; agent paths need the relaxed mode below |
| macOS / Windows (Docker Desktop) | Unavailable — the linuxkit VM returns `ENOSYS` for `landlock_create_ruleset` | `berth dev`; agent paths need the relaxed mode below |
| macOS, Docker daemon in Colima | Enforced — Colima's default Ubuntu 24.04 guest has Landlock ABI 4 in its active LSM stack | Everything, with real kernel enforcement — recipe and verification in [docs/mac-enforcement.md](mac-enforcement.md) |

`berth dev` builds the dev image, which never required enforcement, so resident-app development works on any host. `Computer.boot()` builds the production image, which refuses to run its app unrestricted — on a host without Landlock it exits rather than pretending to be sandboxed. To iterate locally there anyway:

```bash
BERTH_ALLOW_UNENFORCED=1 pnpm start        # or, in code:
```
```ts
await Computer.boot({ apps: ["../../../apps/filesystem"], enforcement: "warn" });
```

Either one prints a warning on every boot. It is a local-iteration mode: the app runs with whatever the kernel managed to apply, which on Docker Desktop is nothing. Don't use it where the isolation boundary matters.

On macOS you do not have to settle for that: swapping Docker Desktop for Colima gets you a kernel that really refuses an undeclared write, with no custom kernel build — `./scripts/mac-enforcement.sh` sets it up and `berth doctor` confirms it. See [docs/mac-enforcement.md](mac-enforcement.md), which records the full capability-denial milestone passing on that host.

## Available capabilities

The `namespace:action:scope` grammar is wide open. You can declare a capability in a namespace nobody's used before, and `requestCapability()` will honestly tell you `granted: false`, because nothing actually backs it. The table below is what has real enforcement or brokering behind it today, the full list of permissions a resident app in a Berth OS can actually be given.

Looking to control what happens *after* a call is allowed, not just whether it's allowed at all? That's a different layer — see [Governance and scoping](./berth-agents-guide.md#governance-and-scoping).

| Capability | Enforced by | Notes |
|---|---|---|
| `filesystem:write:<path>` (say, `filesystem:write:/workspace`) | Kernel (Landlock), always on | Restricts write, create, delete, rename, and truncate to the paths you declared, plus a `/tmp` baseline. Declare nothing and your app can still only write to `/tmp`. The path you declare must be under `/workspace`, `/context`, `/tmp`, or `/app` — it's created as root before enforcement starts, so it isn't a free-form string; `filesystem:write:/` is refused. |
| `filesystem:read:<path>` (say, `filesystem:read:/context`) | Kernel (Landlock), opt in | Declare at least one and read scoping turns on: a fixed baseline (`/usr`, `/lib`, `/etc`, `/proc`, `/dev`, `/tmp`, your app's own working directory) plus whatever you added. Declare none and reads stay fully open, same as always. Same four allowed prefixes as writes; a declared read path that doesn't exist at boot is warned about, not created. |
| `network:connect:<port>` or `network:connect:*` | Kernel (Landlock for TCP, seccomp for UDP/raw), denied by default | Declare no capability at all and you get no outbound network: zero TCP (Landlock), and no UDP, ICMP, or raw sockets either — Landlock has no access right for those, so `agent-init` drops `CAP_NET_RAW` and installs a seccomp filter that refuses to hand those apps a datagram or packet socket at all. Declare even one port and UDP comes back, because you need DNS to use that port by name; that's the current limit, and the fix is to route those apps' DNS through the egress broker. Scoping is by port only, not domain. `*` is an explicit, audited escape hatch for apps that genuinely need to reach arbitrary ports; every first-party app avoids it, scoping instead to a single broker port (`browser-native` and `github-assistant` both do this, see below). |
| `network:peer:<name>` or `network:peer:*` | `mesh-coordinator` (mutual consent) plus a real WireGuard mesh | Joins the mesh with any other app whose own `network:peer:<pattern>` names this app back. A one-sided declaration never gets introduced to its target. See the [mesh reference](./mesh-reference.md). |
| `browser:navigate:<pattern>` (say, `browser:navigate:*.github.com`) or `network:host:<pattern>` | The egress broker, at the host level rather than the kernel | Same mechanism, two names — `network:host:*` is the generic form any resident app can declare, not just one that also drives a browser (see `examples/resident-apps/http-fetch`, or `examples/resident-apps/generic-connector`/`@berth/sdk`'s `defineConnectorApp()` for a whole declarative-REST-integration pattern built on it); call `@berth/sdk`'s `configureEgressProxy()` once to route your own `fetch()` traffic through it. The broker reads the CONNECT target's hostname straight off the (cleartext) proxy handshake and checks it against your pattern. You'll also need `network:connect:<broker's port>` declared (`8090` by default), since Landlock only sees ports. See the [egress broker reference](./egress-broker-reference.md). |
| `browser:screenshot:*` | Recorded and reported only | Nothing kernel- or broker-enforced here on its own. Declaring any `browser:*` capability is what makes `berth dev` publish the noVNC/VNC ports — loopback-bound, VNC-password-gated. (Chromium's CDP port stays on the container's own loopback and is never published.) Opt out with `expose: { browser: false }`. |
| `terminal:attach:*` | Pty device access, kernel-enforced | Declaring it grants Landlock write access to `/dev/pts` and `/dev/ptmx` — a shell can't allocate a pty without it. It does *not* scope what the shell may then do; that comes from the app's `filesystem:`/`network:` capabilities, inherited by every process it spawns. It's also what makes `berth dev` publish the ttyd port — loopback-bound, gated by HTTP basic auth with a per-boot credential. Opt out with `expose: { terminal: false }`. |
| `github:read:<scope>` / `github:write:<scope>` (say, `github:read:repos`, `github:write:issues`) | A real TLS-terminating GitHub API broker, verb-and-path level | GET and HEAD map to `read`, everything else maps to `write`. The path is normalized and matched against an explicit route table that denies anything it doesn't cover — `/repos/<owner>/<repo>` is `repos`, the segment after it is its own scope (`issues`, `pulls`), `/user/emails` is `user:emails`, and so on. You'll also need `network:connect:<broker's port>` declared (`8092` by default). See the [GitHub API scoping reference](./github-api-scoping-reference.md). |

Granting a capability and exposing its session to a human watcher are two separate decisions either way, see `expose:` above.

## What isn't enforced yet

Three enforcement tiers run through that table, and the difference matters more than any single row. If you're evaluating Berth as a security boundary rather than a convenience, read [docs/threat-model.md](./threat-model.md) — it names the adversaries, the trust boundaries, and what holds each one.

| Tier | Mechanism | What it means for you |
|---|---|---|
| **Kernel** | Landlock (filesystem writes and reads, outbound TCP by port), seccomp-bpf (UDP/ICMP/raw sockets, and namespace creation), capability dropping | Irrevocable, inherited across `execve()`, applied before your app's first line runs. Nothing in the container can widen it. Needs a kernel that provides Landlock — see [Kernel enforcement, by platform](./kernel-enforcement.md#kernel-enforcement-by-platform). |
| **Broker** | The egress broker, the GitHub API broker | A real process in the request path that can be bypassed only by reaching the network some other way — which is what the kernel tier is there to prevent. Host- and verb/path-level, so more expressive than the kernel tier, and softer. |
| **Recorded** | `browser:screenshot:*`, any namespace nobody's implemented | Reported honestly by `requestCapability()` and used for `expose:` decisions. Not a control. Don't build a security argument on one. |

And the parts that aren't closed yet. These are tracked with evidence, fixes, and verification steps in [REMEDIATION.md](./internal/REMEDIATION.md), and they're listed here rather than there-only because they change what you should be willing to run:

- **Cross-app calls are authorized at connect, not per export.** An app reaches a sibling's exports only by declaring `app:invoke:<name>`, which gets it a socket of its own that no other uid can traverse — so the target knows which app is calling, and an app that declared nothing gets `EACCES` from the kernel ([1.4](./internal/REMEDIATION.md#14--app-rpc-sockets-in-world-writable-tmp-unauthenticated), closed). But the kernel's part is a *connect-time* gate: once a caller is authorized, DAC lets it reach the target's whole export surface. Per-export policy is now expressible above it — a loaded governance app sees every one of those calls, with the caller's name, and can refuse individual exports ([1.13](./internal/REMEDIATION.md#113--governance-gate-bypasses), closed).
- **A manifest is still code you run, just at build time now.** `on_install` no longer executes at container boot as unsandboxed root (that was [1.5](./internal/REMEDIATION.md#15--on_install-is-unsandboxed-root-shell-run-before-enforcement), now closed) — it's a Docker build layer. That removes it from the running sandbox entirely, but installing a third-party app still means executing its shell on your machine, with your build daemon's authority, when you build the image.
- **The governance gate is not a sandbox.** It now fails *closed* by default ([1.11](./internal/REMEDIATION.md#111--signals-unrestricted-any-app-can-kill-the-governor)) and sits on the Computer's dispatch rather than one tool array, so it covers every resident-app call through a Computer, MCP tools, and `Agent.asTool()` delegation ([1.13](./internal/REMEDIATION.md#113--governance-gate-bypasses)). A second gate in `@berth/sdk` now covers the transports that never touch a Computer — `berth rpc`, `berth mcp`, the HTTP RPC bridge, the TCP listener and a sibling's direct socket call — so a denial holds whichever way the container is entered. It remains a policy layer, not a kernel mechanism, and root on the host is outside it. See [Governance and scoping](./berth-agents-guide.md#governance-and-scoping).

The short version: **kernel-enforced filesystem and network scoping is real and testable today; cross-app and in-container privilege isolation is in progress.** Berth is a strong boundary around what an agent's *code* can touch, and not yet a boundary you should trust against a determined attacker who already has code execution inside the container.

The full version — assets, adversaries, trust boundaries, and what's out of scope permanently versus not yet — is [docs/threat-model.md](./threat-model.md).

Full manifest schema lives in [docs/manifest-reference.md](./manifest-reference.md). Full SDK surface (`defineApp`, `ContextBusClient`, `SemanticFsClient`, `requestCapability`) lives in [docs/sdk-reference.md](./sdk-reference.md). Building in Python instead of TypeScript? See [docs/sdk-python-reference.md](./sdk-python-reference.md) for resident apps, or [docs/agents-python-reference.md](./agents-python-reference.md) for a Python `Agent`/`Crew` core (six of `Crew`'s seven composition shapes — all but `networked` — checkpointing, streaming, structured-output repair, and `Computer.connect()` for a real sandbox's tools over `berth os up --http-rpc` — see that doc's scope notes).
