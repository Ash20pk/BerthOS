# Threat model

Berth's pitch is that an agent's permissions are enforced by the kernel rather than by the model's good behaviour. That claim is only meaningful against a stated adversary, so this page states them: what Berth protects, who it protects it from, where the trust boundaries actually sit, which mechanism holds each one, and — at equal length — what it does not protect against today.

Last reviewed **2026-08-08**, against the audit recorded in [REMEDIATION.md](../REMEDIATION.md). Where a gap is open, it's named here with its remediation ID (e.g. *1.4*) rather than softened. If this page and a feature reference disagree, this page is the one that was written to be adversarial; open an issue.

This is the consolidation point for the "what's deliberately out of scope" notes scattered across `docs/` — the [map at the end](#where-each-scope-note-lives) says which section of this page covers each one.

---

## Assets

What an attacker would actually be after, roughly in order of how bad it is to lose.

| # | Asset | Where it lives |
|---|---|---|
| A1 | **The developer's host machine** | Anything reachable through a bind mount, a published port, or a git hook — `berth dev` mounts the workspace root read-only, with writable paths mounted back over it (*1.6*, closed) |
| A2 | **Credentials** | LLM API keys and `GITHUB_TOKEN` in the container environment (visible in `docker inspect`, *5.5*), fleet credentials in `~/.berthrc`, the grants-server operator token, registry per-name owner tokens, mesh peer tokens, and `BERTH_TOKEN_SECRET` |
| A3 | **Agent state and conversation data** | `/context/agent-runs/*.json` (checkpoints, full message history) and `/context/agent-sessions/*.json`, mode 0644, unencrypted (*5.4*), plus everything under the semantic-FS data dir and any snapshot tarball |
| A4 | **Outbound network reach** | What the container can connect to — including networks it can reach that you can't, i.e. SSRF into a corporate VPN, cloud instance metadata, or `host.docker.internal` (*1.8*) |
| A5 | **The capability boundary between apps** | One app's declared capabilities being usable by another app in the same container (*1.4*, *1.11*) |
| A6 | **Integrity of the capability policy itself** | `.berth/capability-policy.json` and the `berth.yml` it's compiled from — if either is writable by the thing being constrained, nothing below it matters. `berth.yml` is read-only inside the container since *1.6*; the policy lives in a volume the app can still write, which matters only because it is regenerated from the manifest on every boot |
| A7 | **Availability of the enforcement path** | The governance app, the brokers, and the semantic-FS daemon, all killable by any app in the container (*1.11*, *1.14*) |

## Adversaries

The order matters: T1 is the one Berth exists for, and T2/T3 are the ones its current architecture is weakest against.

**T1 — A prompt-injected agent.** The model reads attacker-controlled text (a web page, a repo file, a tool result) and starts choosing tool calls on the attacker's behalf. It can call any tool it's been given, with arbitrary arguments, in any order, and can retry indefinitely. Where the computer includes `code-interpreter` or `terminal`, this escalates directly to arbitrary code execution inside the container — T1 becomes T2. **This is the adversary the kernel enforcement layer is designed for, and the one it holds up best against.**

**T2 — A malicious or compromised resident app.** Third-party code from the registry, a PR, or a dependency. Since the per-app uid work it runs as its own unprivileged uid (`10000 + index`) with a private `/tmp/<app>` and its own RPC socket directory, so the flat "every app is uid 0 sharing a world-writable `/tmp`" posture is gone. What remains is that it still shares one PID namespace with every other app (*1.11*), and that its own Landlock domain does not stop it talking to the root daemons, which have no domain at all (B4). **Berth is a partial boundary against T2** — see [Not protected against](#not-protected-against-today).

**T3 — A malicious manifest.** A `berth.yml` from the registry, a PR, or any repo you cloned. `on_install` used to be an unvalidated shell array executed as root inside the sandbox, before the capability policy was applied; since *1.5* it runs as a Docker build layer instead, so it is no longer a boot-time escape from the sandbox. The trust question moves rather than disappearing: building a third-party app still executes its shell, with the build daemon's authority, on the machine doing the build. Treat installing a third-party app as running its code — at build time, on your host, not at runtime in the container.

**T4 — A network attacker on the same LAN as the developer.** Closed by *1.7*: every port `berth dev` publishes binds `127.0.0.1`, ttyd requires a per-boot HTTP basic credential, VNC requires a per-boot password, and Chromium's CDP port is no longer published at all. Widening the binding takes an explicit `BERTH_PUBLISH_HOST`, which warns. What's left is what a *host-local* process can reach, which is T5.

**T5 — An unprivileged local user on the host or CI runner.** Reads `~/.berthrc` (0644), `~/.berth/os/<name>.json` (0644, holds the RPC bearer token), snapshot `env.json`, and `/context/*.json` — all world-readable (*5.4*, *5.5*).

**T6 — A malicious remote endpoint.** A site the browser navigates to, or an API that responds. Chromium still runs `--no-sandbox`, and the per-app uid work did not change that: its namespace sandbox calls `clone(CLONE_NEWUSER|CLONE_NEWPID)`, which *1.3*'s seccomp filter refuses for every app deliberately. So a renderer exploit lands with the browser app's own uid and capabilities, at which point T6 becomes T2. Giving browser apps a real renderer sandbox is its own item with its own threat analysis — see [per-app uid design § Blocker 5](./per-app-uid-design.md#blocker-5--chromiums-own-sandbox-wants-the-thing-13-just-took-away).

**Explicitly out of the model.** The host kernel, the Docker daemon, the hypervisor, and the base image's package sources are trusted. So is the LLM provider (it sees every prompt and every tool result — routing an agent's data to a third-party API is an inherent property of the design, not a defect). A host root user is game over by construction. Berth is not a defence against a compromised Docker daemon or a container-escape 0-day.

## Trust boundaries

| # | Boundary | Held by | Strength today |
|---|---|---|---|
| B1 | Model output → tool invocation | The governance gate (`evaluate_action`) and human approval | **Advisory, but no longer selective.** Governance fails *closed* by default (*1.11*) and now sits on the Computer's dispatch rather than one tool array, so every resident-app call through it is gated, as are MCP tools (`mcp:<server>`) and delegation (`agent:<name>`) (*1.13*). Still not on the path of `berth rpc`, `berth mcp`, the HTTP RPC bridge, or direct `invokeAppExport()` (*1.13*). Human approval is fail-closed by design but is swallowed by the tool-error handler (*3.4*) |
| B2 | App process → kernel | Landlock (filesystem + TCP-connect/bind by port), seccomp-bpf (UDP/ICMP/raw sockets, namespace creation), capability bounding-set drop | **Real, and the strongest thing here.** Applied by `agent-init` before `execve()`, inherited across it, irrevocable. Conditional on the host kernel — see [Platform dependency](#platform-dependency) |
| B3 | App process → sibling app process | Distinct uids; an app's own RPC socket is `0600`, and a caller declaring `app:invoke:<name>` gets its own socket in a directory only it can traverse — so the target both authorizes and identifies it | The grant is per-app, not per-export (*1.13*); one shared PID namespace (*1.11*) |
| B4 | App process → the daemons (context-bus, semantic-FS, mesh) | *Nothing* | Daemons run as root **outside any Landlock domain** — they start before `agent-init`. Identity is self-asserted from the request body in both (*1.14*) |
| B5 | Container → internet | The egress broker and the GitHub API broker | **Partial.** Port is never checked, `*` reaches loopback/RFC1918/IMDS, DNS isn't pinned (*1.8*); the GitHub scope heuristic defaults to *allow* (*1.9*) |
| B6 | Container → host filesystem | The image, plus whatever is bind-mounted | `Computer.boot()` and deployed targets mount nothing. `berth dev` mounts the workspace root **read-only** and mounts writable paths back over it — a shared `.berth/dev-workspace` for app data and a per-app volume for `.berth` (*1.6*, closed). Read-only is a VFS property, so this holds on kernels without Landlock too. `dev-workspace-mount-milestone.mjs` |
| B7 | Host network → published ports | Loopback-only binding plus a per-boot credential on each | **Real for the LAN case** (*1.7*, closed): ttyd basic auth, VNC password, no published CDP. Still reachable by any host-local process, and a printed credential is only as private as the terminal it was printed to |
| B8 | Manifest → enforced policy | `@berth/manifest-schema` validation and the filesystem path allowlist | Path scopes are constrained to `/workspace`, `/context`, `/tmp`, `/app` and checked three times, including in `agent-init` itself (*1.12*, closed). `on_install` is unconstrained shell, but runs at image build rather than inside the sandbox (*1.5*, closed) |
| B9 | Operator → grants / registry / mesh servers | Shared bearer tokens | Plain HTTP, no TLS option, no user/tenant/role model, no audit trail with a verifiable actor (*5.1*, *5.2*, *5.3*) |

The pattern worth internalising: **B2 is genuinely strong and everything adjacent to it is weak.** Landlock is correctly implemented and correctly inherited; the bypasses are all *around* it — unsandboxed root daemons sharing a namespace and a writable `/tmp` with the app that was carefully sandboxed.

## What is enforced, and by what

Three tiers. Treat the tier, not the capability name, as the security claim.

| Tier | Mechanism | Covers | Verification artifact |
|---|---|---|---|
| **Kernel** | Landlock ABI v3+ (`AccessFs::from_write`) | write / create / delete / rename / **truncate**, under declared paths plus a `/tmp` baseline | `capability-enforcement.mjs` Tests 1–2, 10; `agent-init` Rust unit tests |
| **Kernel** | Landlock ABI v3+ read rights, opt-in | reads, once at least one `filesystem:read:` is declared | `capability-enforcement.mjs` Tests 3–4; symlink escape (6) and concurrent access (7) cover both directions |
| **Kernel** | Landlock ABI v4+ `AccessNet` | outbound TCP `connect`, and `bind` — **by port, never by domain** | `capability-enforcement.mjs` Test 5; `http-rpc-bridge-milestone.mjs` |
| **Kernel** | seccomp-bpf (`packages/agent-init/src/seccomp.rs`) | `socket(AF_INET/AF_INET6, SOCK_DGRAM/SOCK_RAW)` and all `AF_PACKET`, **only for apps declaring no network capability at all** | `capability-enforcement.mjs` Test 5b (asserted unconditionally); Rust unit test |
| **Kernel** | Capability bounding-set drop, paired with the seccomp filter below | `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, `CAP_NET_RAW` | `capabilities_dropped` audit event |
| **Kernel** | seccomp-bpf (`packages/agent-init/src/seccomp.rs`) | `unshare`/`clone` with any `CLONE_NEW*` flag, `setns`, `clone3`, for **every** app — without this the bounding-set drop above is reversible, since a new user namespace comes with a fresh `CAP_FULL_SET` | `capability-enforcement.mjs` Test 11 (asserted unconditionally); Rust unit test |
| **Broker** | Egress broker (CONNECT gate on the hostname) | `browser:navigate:<pattern>`, `network:host:<pattern>` | `egress-broker-milestone.mjs` |
| **Broker** | GitHub API broker (TLS-terminating, verb + path) | `github:read:<scope>`, `github:write:<scope>` | `github-assistant-milestone.mjs` |
| **Host** | Loopback-only port publishing, per-boot ttyd/VNC credentials | who can reach a sandbox's human-facing ports from outside it | `published-port-security-milestone.mjs` |
| **Kernel** | Landlock write rules on the pty devices | `terminal:*` — grants `/dev/pts` and `/dev/ptmx`, without which a tmux server cannot allocate a pty at all under enforcement (*1.15*) | `published-port-security-milestone.mjs`; Rust unit tests |
| **Recorded** | Nothing — reported by `requestCapability()`, used for `expose:` | `browser:screenshot:*`, any unimplemented namespace | — |

Full mechanics in [capability tokens reference](./capability-tokens-reference.md); the per-capability table is in the [README](../README.md#available-capabilities).

### Platform dependency

`agent-init` **fails open by default**: if the ruleset can't be verified as `FullyEnforced`, it logs a warning and execs the app unrestricted. That exists so a Docker Desktop for Mac linuxkit kernel (no Landlock) doesn't block local development, and for no other reason.

**A production deployment must set `BERTH_REQUIRE_ENFORCEMENT=1`**, which turns that into a refusal to exec with a `capability_enforcement_refused` audit event. `Computer.boot()` sets it by default; relaxing it requires an explicit `enforcement: "warn"` or `BERTH_ALLOW_UNENFORCED=1` and prints a per-boot warning. Nothing on this page is true on a kernel without Landlock — see the README's [Kernel enforcement, by platform](../README.md#kernel-enforcement-by-platform) matrix.

## Not protected against, today

### Open gaps

Each is tracked with evidence, a fix, and a verification step in [REMEDIATION.md](../REMEDIATION.md). These change what you should be willing to run.

- **The container still holds `CAP_SYS_ADMIN`, and the daemons still run outside every filter (*1.3*, partially).** The reversibility of the capability drop is closed — `agent-init` refuses namespace creation outright — but that is a filter on the *app*, not a removal of the grant. `CAP_SYS_ADMIN` is added container-wide for the semantic-FS FUSE mount, and the context-bus, semantic-FS, and mesh daemons start before `agent-init` and so carry it with no seccomp filter and no Landlock domain. Mounting `/context` from a separate init step and dropping the cap before any app process exists is the real fix.
- **Cross-app capability borrowing (*1.4*, closed).** An app's RPC socket is `0600` in a directory it owns; a sibling reaches it only by declaring `app:invoke:<name>`, which gets it a socket of its own that no other uid can traverse to — so the target knows which app called. Enforced by DAC, since Landlock does not gate `connect()` to a pathname Unix socket (see [per-app uid design](./per-app-uid-design.md)). What remains is that the grant is connect-time, so an authorized caller reaches the target's *whole* export surface (*1.13*). The context-bus, semantic-FS, and mesh control sockets stay reachable by every app by design, and are still served by root daemons outside any Landlock domain (B4) — though the first two now identify their callers by `SO_PEERCRED` rather than by what the caller says (*1.14*).
- **Broker gaps (*1.8*, *1.9*).** No port allowlist; `*` reaches IMDS, loopback, and `host.docker.internal`; DNS re-resolved after the check; GitHub scope classification defaults to `repos` rather than deny. An app declaring both `github:*` and `network:host:*` gets a raw CONNECT tunnel with no path inspection.
- ~~**Capability tokens are never verified (*1.10*).**~~ **Closed by deletion.** The API is gone, as is `BERTH_TOKEN_SECRET`. It could not have been fixed in place: the signing key lived in the environment of the app the tokens constrained, so any app could mint any token, and each app in a multi-app container held a different secret. Cross-app identity comes from the kernel at `connect(2)` instead (*1.4*), which a caller cannot forge.
- ~~**Signals are unrestricted (*1.11*).**~~ **Closed.** Apps run as distinct uids, so `kill(2)` between them is refused by the kernel's ordinary permission check — asserted by `capability-enforcement.mjs` Test 12, with a `docker exec` root process as the negative control. The governance gate also now defaults to fail-**closed**, so an unreachable governor refuses calls rather than waving them through; killing a broker still forces its own failure mode.
- **Governance gate coverage (*1.13*, partially closed).** MCP tools and `Agent.asTool()` are now gated, under `mcp:<server>` and `agent:<name>`, and the gate moved onto the Computer's dispatch so it can't miss a tool that wasn't in one array. `berth rpc`, `berth mcp`, the HTTP RPC bridge and direct socket calls remain ungated — separate transports with no governance app on their path.
- **Daemon robustness and identity (*1.14*).** A 4-byte length header allocates that many bytes in both the context-bus and semantic-FS daemons. App identity is taken from the request body. Killing semantic-FS makes retrieval silently return empty results rather than error.
- **`berth mcp` has no authentication.** `--only` narrows what a bridge reaches; it does not verify who is calling. See [MCP bridge reference](./mcp-bridge-reference.md#whats-real-vs-deliberately-deferred).
- **Enterprise-grade operational security is absent** (*Phase 5*): no audit trail with a verifiable actor, no identity/tenancy/RBAC, no TLS on any server, nothing encrypted at rest, secrets in `docker inspect` and 0644 files, no rate limiting, and a registry whose first publish of a name needs no auth against a 100 MB body limit.

### Deliberately out of scope, permanently or by design

Not gaps to be closed — decisions, with the reason.

- **Per-syscall denial audit logging.** Landlock has no deny-notification hook. Real per-event auditing needs `auditd` or privileged eBPF LSM hooks, neither available in an unprivileged container. `agent-init` logs the *policy it applied* at boot instead. ([capability tokens reference](./capability-tokens-reference.md#whats-still-deliberately-deferred-by-explicit-decision-not-oversight))
- **Domain-scoped network capabilities at the kernel layer.** Landlock scopes by port. Domain-level control is the brokers' job, one tier softer, by construction.
- **A general path/verb grammar for arbitrary third-party APIs.** Only `github:*` gets verb-and-path brokering, via a GitHub-specific path shape. ([GitHub API scoping](./github-api-scoping-reference.md#whats-deliberately-out-of-scope))
- **The GitHub broker in multi-app containers.** Wired into the single-app path only — a `github:*` companion app in an `--apps` sandbox gets no broker, and therefore no scoping.
- **One egress broker per container, not per app.** A shared pattern list across apps in an `--apps` sandbox; the CLI enforces at most one broker-declaring app pre-boot rather than isolating them.
- **`docker exec` bypasses `agent-init` entirely.** Anything started that way gets zero enforcement. `--apps` exists precisely so multi-app setups don't need it, but the escape hatch is inherent to Docker. ([multi-app reference](./multi-app-reference.md))
- **Snapshots capture no per-boot secret.** There is no longer one to capture: `BERTH_TOKEN_SECRET` is gone with capability tokens (*1.10*). The principle it stood for — restoring a stale secret is a regression, not a feature — still applies to anything similar added later. They *do* capture the container environment to an unmodded `env.json` (*5.5*), which is a gap, not a decision. ([snapshots reference](./computer-snapshots-reference.md#whats-explicitly-deferred-named-here-not-silently-promised))
- **Kubernetes needs `SYS_ADMIN` and a `/dev/fuse` hostPath** for the semantic-FS mount, so Berth Pods will be rejected by a cluster enforcing the `restricted` Pod Security Admission level. Named rather than papered over with `privileged: true`. ([k8s adapter](./k8s-adapter-reference.md#whats-deliberately-out-of-scope))
- **The app registry is single-node with no user/org model.** Fine for a local or trusted-internal registry; not a public multi-tenant service. ([app registry](./app-registry-reference.md#scope))
- **The context bus has no identity, persistence, or replay**, and no wildcard subscribe. ([context bus](./context-bus-reference.md#known-limitations-phase-2-scope))
- **The mesh requires mutual consent** (a one-sided `network:peer:` never gets an introduction) and covers local `berth dev` only. Host-side `Crew.networked()` peers deliberately don't use it. ([mesh reference](./mesh-reference.md#whats-deferred))
- **The governance gate is not, and cannot be, a kernel gate.** Landlock applies a static ruleset once at boot with no per-syscall callback, so there is nothing at that layer to consult an external verdict-provider from. It is a `Computer`-level choke point. ([governance reference](./governance-reference.md#why-this-lives-in-berthagents-not-the-kernel))

## What this means in practice

**Reasonable today.** Running first-party or reviewed apps on your own machine or in CI, with an agent driving untrusted *content* — a web page, a repo, a document. That is T1, and B2 holds: an undeclared write or an undeclared outbound connection dies in the kernel, before any application code can catch it.

**Not reasonable yet.** Installing a resident app or a `berth.yml` you haven't read (T3 has no boundary at all). Running mutually-distrusting apps in one container and expecting the per-app rulesets to keep them apart (B3, B4). Publishing a sandbox's ports beyond loopback with `BERTH_PUBLISH_HOST` on an untrusted network — the credentials are real, but they're the only thing there (T4). Putting PHI, PII, or regulated data through it (*5.4* — nothing is encrypted at rest, and conversation history is persisted 0644). Multi-tenant use of the grants server or registry (*5.2*).

**If you're evaluating Berth as a security boundary**, the honest one-line summary: *kernel-enforced filesystem and network scoping is real and testable today; cross-app and in-container privilege isolation is in progress.* Berth is a strong boundary around what an agent's code can touch, and not yet a boundary to trust against an attacker who already has code execution inside the container.

## Reporting

Found something not on this page? [SECURITY.md](../SECURITY.md) has the private disclosure path. A bypass of anything in the **Kernel** or **Broker** tier above is a vulnerability. A gap in something this page already names as unenforced is expected — but a *worse-than-documented* version of one is still worth reporting.

## Where each scope note lives

Every "what's deferred / out of scope" section in `docs/` maps to a section above. Nothing security-relevant should exist only in a feature reference.

| Source | Covered by |
|---|---|
| [capability-tokens-reference.md](./capability-tokens-reference.md) — deferred + verification status | [What is enforced](#what-is-enforced-and-by-what), [Platform dependency](#platform-dependency), per-syscall auditing |
| [multi-app-reference.md](./multi-app-reference.md) — reaching another app's exports | B3/B4, *1.4*, `docker exec` bypass |
| [governance-reference.md](./governance-reference.md) — fail-closed default, what is and isn't gated, why not the kernel | B1, *1.13*, out-of-scope list |
| [egress-broker-reference.md](./egress-broker-reference.md) / [github-api-scoping-reference.md](./github-api-scoping-reference.md) | B5, *1.8*, *1.9*, out-of-scope list |
| [mcp-bridge-reference.md](./mcp-bridge-reference.md) — deferred | Open gaps (no auth), B1 |
| [mesh-reference.md](./mesh-reference.md) — deferred | B9, out-of-scope list |
| [computer-snapshots-reference.md](./computer-snapshots-reference.md) — deferred | A2, A3, out-of-scope list |
| [k8s-adapter-reference.md](./k8s-adapter-reference.md) — out of scope | Out-of-scope list (PSA / `SYS_ADMIN`) |
| [app-registry-reference.md](./app-registry-reference.md) — scope | T3, *5.2*, out-of-scope list |
| [context-bus-reference.md](./context-bus-reference.md) — known limitations | B4, *1.14*, out-of-scope list |
| [semantic-fs-reference.md](./semantic-fs-reference.md) — verification status | B4, *1.14* (silent-empty fallback) |
| [berth-os-reference.md](./berth-os-reference.md) / [agents-reference.md](./agents-reference.md) — scope boundaries | Non-security scope (local Docker only, YAML shapes, schema fidelity) — no threat-model impact |
| [sdk-reference.md](./sdk-reference.md) / [sdk-python-reference.md](./sdk-python-reference.md) / [sdk-python-context-bus-reference.md](./sdk-python-context-bus-reference.md) | Non-security scope, except connector path/verb scoping → B5 |
