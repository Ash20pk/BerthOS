# Remediation plan

Ordered list of what to fix, derived from a full audit of the repo on 2026-08-07 (framework layer, OS/sandbox layer, enterprise posture, and an adversarial pass on the isolation model). Distinct from [gaps.md](./gaps.md), which tracks *feature parity*. This file tracks *correctness, security, and credibility* — the things that are claimed but not true, or true but unverified.

Ordering principle: **make the existing claims true before adding new ones.** Phases 0–2 are the ones that decide whether Berth is a real product. Everything after is normal engineering.

Each item lists evidence (`file:line`), the fix, and a verification step that would prove it closed. Effort is a rough solo estimate.

## Status key

- 🔴 Open
- 🟡 In progress
- 🟢 Closed — with a verification artifact, not just a passing build

---

## Phase 0 — Unblock (do this first, ~half a day)

Nothing else matters if a new developer can't run the thing. Both items are small.

| # | Item | Status | Effort |
|---|------|--------|--------|
| 0.1 | `@berth/agents` cannot run on macOS at all | 🟢 | 2h |
| 0.2 | `Computer.boot()` reports success against a dead container | 🟢 | 2h |

### 0.1 — `@berth/agents` cannot run on macOS at all

**Evidence.** `packages/agents/src/build.ts:22` hardcodes `target: "production"` for every `Computer.boot()`. `packages/docker-orchestrator/docker/base.Dockerfile:165` sets `BERTH_REQUIRE_ENFORCEMENT=1` on that target. `packages/agent-init/src/main.rs:172-180` then correctly refuses to exec, because Docker Desktop's linuxkit kernel returns `ENOSYS` for `landlock_create_ruleset`. The container exits 1.

Verified by running `packages/agents/test/computer-boot-milestone.mjs` on macOS: fails. `berth dev` on the same machine works fine (dev target doesn't set the flag), so resident-app development works and every agent path is dead.

This makes the README quickstart (`cd examples/agents/simple-agent && pnpm start`) fail for every Mac user. `docs/agents-reference.md:770` names only three milestone tests as Mac-blocked; it is in fact all of them plus the quickstart. `docs/capability-tokens-reference.md:66` says fail-open exists "to keep local dev working" on exactly this kernel — but the agents path can never reach fail-open because it hardcodes production.

**Fix.** Give `buildComputerImage()` a target option. Default it to `production`, and let `Computer.boot({ enforcement: "warn" })` (or an explicit `BERTH_ALLOW_UNENFORCED=1`) select the dev target for local iteration. Print a loud, one-line warning whenever an unenforced computer boots, so it can never be mistaken for the real posture.

**Verify.** `node packages/agents/test/computer-boot-milestone.mjs` passes on macOS in the relaxed mode and still fails closed in the default mode. Add a line to the README prerequisites stating the enforcement/platform matrix explicitly.

**Closed.** Not via a build target — base.Dockerfile's `dev` stage has no `COPY . /app` (it expects `berth dev`'s bind mount, which a Computer doesn't have), so building it would boot an empty container. Instead `Computer.boot({ enforcement: "warn" })` / `BERTH_ALLOW_UNENFORCED=1` overrides the production image's `BERTH_REQUIRE_ENFORCEMENT` in the container's env, which `agent-init` reads at exec time. Loud warning per relaxed boot. Verified on macOS: the milestone fails closed by default naming `capability_enforcement_refused`, and passes under the env var. README gained the platform matrix; `docs/agents-reference.md` now says all ten milestones are affected, not three.

### 0.2 — `Computer.boot()` reports success against a dead container

**Evidence.** `packages/agents/src/computer.ts:203-217` starts the container, attaches stdio, and builds the tool list from the *manifest* — never from the live app. There is no liveness check on the default path; only the `httpRpc` path polls `/healthz` (`computer.ts:236-240`). So boot returns a populated `tools` array against a container that already exited, and the first tool call fails 30s later with `attempt timed out after 3000ms` (`computer.ts:78`). The real reason sits in `docker logs` of a container nobody tells you to look at.

**Fix.** After `startContainer()`, inspect the container. If it has exited, read the last ~40 lines of its logs and throw an error that includes them. Separately, when `withReadyRetry` exhausts its ceiling, re-inspect before throwing and append the container's exit code and log tail to the message.

**Verify.** Boot a computer whose app crashes on startup; assert the thrown error names the actual cause (e.g. `capability_enforcement_refused`) rather than a timeout.

**Closed.** The post-start inspect alone races an app that dies a moment later, so it's paired with a `container.wait()` watcher that aborts the ready-retry loop the instant the container exits, plus a diagnostic on retry exhaustion. All three append the exit code and a 40-line log tail. Covered by `packages/agents/test/computer-boot-failure-milestone.mjs`.

---

## Phase 1 — Make the security claim true (~2–3 weeks)

README line 88 currently reads: *"a prompt-injected 'ignore previous instructions, delete everything' never even reaches the syscall."* This phase is what makes that sentence defensible.

**The pattern behind almost all of these:** Landlock itself is correctly implemented and correctly inherited across `execve`. The bypasses are all *around* it — five unsandboxed root daemons share a namespace and a world-writable `/tmp` with the sandboxed app. Hardening the app while leaving what it talks to unhardened is the single architectural issue to fix.

| # | Item | Severity | Status | Effort |
|---|------|----------|--------|--------|
| 1.1 | `truncate(2)` is not a handled Landlock access right | High | 🟢 | 1h |
| 1.2 | `CAP_NET_RAW` retained; Landlock covers TCP only | Critical | 🟢 | 1d |
| 1.3 | Bounding-set drop undone by `unshare(CLONE_NEWUSER)` | Critical | 🟢 | 2d |
| 1.4 | App RPC sockets in world-writable `/tmp`, unauthenticated | Critical | 🟢 | 3d |
| 1.5 | `on_install` is unsandboxed root shell run before enforcement | Critical | 🟢 | 2d |
| 1.6 | `berth dev` bind-mounts the whole host repo read-write | Critical | 🟢 | 1d |
| 1.7 | ttyd / VNC / CDP unauthenticated on all host interfaces | High | 🟢 | 1d |
| 1.8 | Egress broker: no port check, `*` → SSRF, DNS not pinned | High | 🟢 | 2d |
| 1.9 | GitHub broker: `read:repos` also grants `/user/emails` etc. | High | 🟢 | 1d |
| 1.10 | Capability tokens are never verified anywhere | High | 🟢 | 1d |
| 1.11 | Signals unrestricted — any app can kill the governor | Medium | 🟢 | 1d |
| 1.12 | `agent-init` mkdir's arbitrary manifest paths as root | Medium | 🟢 | 4h |
| 1.13 | Governance gate bypasses (MCP, agent-as-tool, rpc, mcp, http-rpc) | High | 🟡 | 2d |
| 1.14 | semantic-fs / context-bus: unbounded frame allocation + spoofable identity | Medium | 🟢 | 1d |
| 1.15 | `apps/terminal` is non-functional on any Landlock-enforcing kernel | High | 🟢 | 2d |

### 1.1 — `truncate(2)` is not a handled Landlock access right

**Evidence.** `packages/agent-init/src/main.rs:238-247` handles ten write rights and omits `AccessFs::Truncate` (also `Execute`, also `IoctlDev`). Landlock only enforces rights present in `handled_access_fs`; an unhandled right is permitted everywhere. So `open(O_WRONLY)` outside a declared path is refused and `truncate(path, 0)` on the same file succeeds.

This directly falsifies "an undeclared write isn't caught by a try/catch — the kernel refuses the syscall outright."

**Fix.** Use `AccessFs::from_write(ABI::V3)` (which includes `Truncate`), or add `AccessFs::Truncate` explicitly. Keep `BestEffort` so older kernels degrade rather than fail.

**Verify.** Add Test 10 to `packages/docker-orchestrator/test/capability-enforcement.mjs`: `truncate()` on a path outside the declared write scope is denied.

**Closed.** The enumerated list is replaced by `AccessFs::from_write(ABI::V3)`, so a right added in a future ABI can't be forgotten the way `Truncate` was. `Execute` and `IoctlDev` stay unhandled *deliberately* — handling `Execute` would deny exec of every shell and interpreter outside the declared read paths (`/bin` and `/sbin` aren't in `BASELINE_READ_PATHS`), so it needs the baseline exec set worked out first; that gap is now called out in `main.rs` rather than being a silent omission. Test 10 is added and a new `truncate_file` diagnostic export on `apps/filesystem` drives it. Two verification artifacts, because the end-to-end one can't run everywhere: Test 10 asserts the denial on a Landlock-active kernel (on Docker Desktop's linuxkit it degrades to informational, like every other denial check in that file — confirmed by a local run), and a pair of Rust unit tests assert the handled set directly, kernel or no kernel. Those had never run anywhere, so `build-lint-test.yml` gained a `cargo test` step for `agent-init` and `mesh-daemon` (`context-bus-daemon` needs `protoc`, which the runner lacks).

### 1.2 — `CAP_NET_RAW` retained; Landlock covers TCP only

**Evidence.** `main.rs:249` — `AccessNet::ConnectTcp`. There is no UDP, ICMP, or raw-socket access right in any Landlock ABI. `main.rs:147` drops only `CAP_SYS_ADMIN` and `CAP_NET_ADMIN`, so `CAP_NET_RAW` stays in Docker's default set.

So an app declaring no network capability has unrestricted UDP (DNS exfiltration, QUIC, arbitrary C2) and, with `CAP_NET_RAW`, can build TCP in userspace that never calls `connect(2)`. This matters most for `apps/code-interpreter`, whose pitch (`docs/agents-reference.md:428`) is "zero outbound network access, enforced by the kernel."

**Fix.** Two parts. (a) Drop `CAP_NET_RAW` alongside the other two in `drop_all_capabilities()`. (b) Landlock cannot restrict UDP at all, so back the deny-by-default claim with a second mechanism — the honest options are a seccomp filter rejecting `socket(AF_INET, SOCK_DGRAM)`/`AF_PACKET` when no network capability is declared, or a network namespace with no route. Pick one and document the other as out of scope.

**Verify.** Extend `capability-enforcement.mjs` Test 5 to assert a UDP `sendto()` and a raw-socket open both fail for an app declaring no network capability.

**Closed.** (a) `CAP_NET_RAW` joins the two capabilities `drop_all_capabilities()` already dropped. Only the bounding set matters across the `exec()` that follows — for a uid-0 process exec'ing a file with no file capabilities the kernel recomputes the permitted set from the bounding set, so dropping from permitted/effective would be undone moments later; that reasoning is now in the function's doc comment, since it isn't obvious from the code. (b) The second mechanism is seccomp-bpf, not a network namespace: a namespace can't be entered per-app inside a shared container without redoing the whole daemon topology, whereas a seccomp filter installed in `agent-init` is inherited across `execve()` and irrevocable, exactly like the Landlock domain beside it. `packages/agent-init/src/seccomp.rs` refuses `socket(AF_INET|AF_INET6, SOCK_DGRAM|SOCK_RAW)` and all of `AF_PACKET` with `EPERM` — refusing the socket rather than policing send/recv, so there's no fd to smuggle and no per-call race. The type argument is compared under a mask, since every runtime OR's `SOCK_CLOEXEC` in.

Scoped deliberately, and this is the honest limit: the filter is installed **only for apps that declared no network capability at all**. An app declaring `network:connect:443` keeps UDP, because it needs DNS for that port to be reachable by name and Landlock's per-port model can't express "UDP 53 only" — closing that means routing those apps' DNS through the egress broker (1.8). `AF_UNIX` (all local RPC) and `AF_NETLINK` are untouched, the former being 1.4's problem, not this one. `socketcall(2)` needs no separate handling: it exists only on i386, and these images build for x86_64 and aarch64.

Two verification artifacts. `capability-enforcement.mjs` Test 5b drives new `probe_network_udp` and `probe_raw_socket` diagnostic exports on `apps/filesystem` — and unlike every other denial check in that file, it is asserted *unconditionally* rather than degraded to informational, because seccomp-bpf and capability dropping work on Docker Desktop's linuxkit kernel just as they do on a real host (confirmed by a local run: `bind EPERM 0.0.0.0` and `ping: permission denied (are you root?)`). A Rust unit test installs the filter on a scratch thread and makes the real `socket(2)` calls, asserting UDP/`AF_PACKET` get `EPERM` while TCP and `AF_UNIX` still work — that one runs under the `cargo test` step 1.1 added to CI. The raw-socket probe shells out to `ping`, the only raw-socket-capable tool in the base image; Node has no raw-socket API. Dropping `CAP_NET_RAW` is what makes `ping` stop working inside a sandbox, which is now called out in the docs so it isn't mistaken for a bug.

### 1.3 — Bounding-set drop undone by `unshare(CLONE_NEWUSER)`

**Evidence.** `main.rs:130-133` claims the bounding set is "a hard ceiling a process can never widen for itself." Not true when the container holds `CAP_SYS_ADMIN` (`container.ts:219`), because Docker's default seccomp profile drops its namespace-flag restrictions when that cap is present, and the kernel sets `cap_bset = CAP_FULL_SET` on user-namespace creation.

**Reproduced in the real `berth/filesystem:0.1.0` image.** After dropping exactly what `agent-init` drops, a direct `mount` is denied; then:

```
$ unshare -Urm sh -c 'grep CapEff /proc/self/status; mount -t tmpfs none /mnt'
CapEff: 000001ffffffffff
MOUNT_SUCCEEDED_CAP_REGAINED
```

Landlock's FS rules still bind (inode-based, they survive namespace tricks), but every `SYS_ADMIN`-gated syscall Landlock doesn't cover is back. `run_code({language:"shell", code:"unshare -Urm ..."})` is the whole exploit.

**Fix.** Ship a custom seccomp profile that keeps Docker's defaults but re-adds the `clone`/`unshare`/`setns` namespace-flag restrictions unconditionally, and pass it via `SecurityOpt`. Longer term: stop granting container-wide `CAP_SYS_ADMIN` — it is only needed for the FUSE mount, so mount `/context` from a separate init step or use a fuse device plugin, then drop the cap before any app process exists.

**Verify.** A test asserting `unshare -Urm` fails inside a booted sandbox.

**Closed.** Not with a custom Docker seccomp profile, which was the fix sketched above. That would mean vendoring Docker's ~1000-line default and keeping it in sync forever to avoid silently losing everything else it blocks, and it would apply container-wide — including to the daemons `entrypoint.sh` starts before `agent-init`, one of which genuinely needs `CAP_SYS_ADMIN` to mount `/context`. Instead `agent-init` installs a second seccomp filter of its own, next to the one 1.2 added: `unshare(2)` and `clone(2)` are refused with `EPERM` when any `CLONE_NEW*` flag is set, `setns(2)` is refused outright, and `clone3(2)` returns `ENOSYS`. Same properties as the Landlock domain beside it — inherited across `execve()`, irrevocable, scoped to exactly the process this binary exists to constrain.

Four details worth naming, because each is a place this could have been subtly wrong:

1. **It's installed for every app, not conditionally.** 1.2's filter is deliberately narrow (only apps declaring no network capability); this one can't be, because the capability drop it protects is unconditional.
2. **`clone3` returns `ENOSYS`, not `EPERM`.** Its flags arrive behind a pointer and seccomp cannot dereference pointers, so a flag-matching rule is impossible and the syscall has to go whole — which would otherwise break `pthread_create` on any libc that reaches for it first. `ENOSYS` is the answer glibc is written to fall back from, and is what Docker's own default profile has returned since 20.10.10, so every container image in the world already runs this way. (This image is Alpine/musl, which doesn't call `clone3` at all, so the fallback is belt-and-braces.) That difference in errno is also why this is two filters rather than one: a seccompiler `SeccompFilter` carries a single match action.
3. **`CLONE_NEWTIME` is filtered on `unshare` but not on `clone`.** Its value (`0x80`) falls inside `clone(2)`'s `CSIGNAL` mask — the low byte of `clone_flags` is the child's exit signal — and the kernel rejects it for `clone(2)` anyway, accepting it only via `unshare`/`clone3`. Filtering it on `clone` would mask a bit the kernel reads as part of a signal number. There's a unit test asserting the two lists differ in exactly that one entry, and agree on every other.
4. **The `unshare` rules match with `MaskedEq(flag)`, not equality.** An equality compare against the whole argument would be bypassed by OR-ing in any other flag, which every real caller does — `unshare -Urm` passes `NEWUSER|NEWNS|NEWPID` together.

The false claim that made this possible is corrected at the source: `drop_all_capabilities()`'s doc comment called the bounding set "a hard ceiling a process can never widen for itself," and now says it is a ceiling *only within the process's own user namespace*, and that the drop and the filter are a pair worth little apart. Same correction in `docs/mesh-reference.md`, which had inherited the phrasing.

**Verification, in three layers, and the negative control matters most.** A Rust unit test installs the filter on a scratch thread, makes the real `unshare(CLONE_NEWUSER)` call, and separately asserts `fork(2)` still works — a filter too broad here would break every child process an app spawns, and would otherwise show up as an unrelated app failing days later. `capability-enforcement.mjs` Test 11 drives a new `probe_user_namespace` diagnostic export on `apps/filesystem` end-to-end, asserted *unconditionally* rather than degraded to informational (like 1.2's Test 5b, and unlike every Landlock check in that file), because seccomp-bpf works on Docker Desktop's linuxkit kernel exactly as on a real host. It reports `created` and `regainedCaps` separately, so "the namespace was created but the mount happened not to work" can't be misread as a pass.

The negative control was run against the *same booted container*, not a hypothetical one: a `docker exec` process — which is not a descendant of `agent-init` and so carries no filter — still returns `CapEff: 000001ffffffffff` and `MOUNT_SUCCEEDED_CAP_REGAINED`, while the app's own filtered process gets `unshare: unshare(0x10020000): Operation not permitted`. So the denial is demonstrably the filter and not the environment.

**Regression-checked against the apps most likely to need namespaces**, since a seccomp filter that breaks process spawning would be a bad trade: Chromium was A/B'd directly (`--headless --no-sandbox --dump-dom`, run with and without `agent-init` in the same image — byte-identical output), `published-port-security-milestone.mjs` passes 9/9 including the tmux/ttyd and Xvfb/x11vnc display stacks, `multi-app-milestone.mjs` passes, and `code-interpreter`'s `run_code` still works for all three of python, javascript, and shell.

**Not closed by this.** The container still holds `CAP_SYS_ADMIN` container-wide, and the pre-exec daemons (context-bus, semantic-fs, mesh) still carry it with no seccomp filter and no Landlock domain — B4 in the threat model, unchanged. The real fix is the second half of the original entry: mount `/context` from a separate init step or a FUSE device plugin, then drop the cap before any app process exists. That's now recorded as an open gap in `docs/threat-model.md` rather than being folded into this closure.

### 1.4 — App RPC sockets in world-writable `/tmp`, unauthenticated

**Evidence.** `packages/sdk/src/generate-capability-policy.ts:46` — `BASELINE_WRITE_PATHS = ["/tmp"]`, unconditional for every app. `entrypoint.sh:263` — sockets at `/tmp/berth-rpc/<app>.sock`. `packages/sdk/src/rpc.ts:58-69` — `connectionHandler` parses a line and calls `invokeExport` with **no authentication and no `SO_PEERCRED` check**.

Exploit: `code-interpreter` (declaring only `filesystem:write:/workspace`) runs

```bash
printf '{"id":"1","export":"write_context_file","input":{...}}\n' | nc -U /tmp/berth-rpc/filesystem.sock
```

and executes with *filesystem's* capabilities. Per-app Landlock rulesets are real and individually correct; they don't matter when apps can call each other directly. Same reachability exposes `/tmp/berth-context-bus.sock`, `/tmp/berth-semantic-fs.sock`, `/tmp/berth-mesh.sock` — all served by root daemons running *outside* any Landlock domain, because they start before `agent-init`.

**Fix.** Three parts, all needed:
1. Move each app's socket to a per-app directory (`/run/berth/<app>/`) mode `0700`, owned by that app's uid — which requires giving each app a distinct uid (see 1.5's user story).

> **Steps 0–3 of that migration have landed** — parts 1 and 2 below are closed; part 3 (`SO_PEERCRED`) is not, which is why this entry is still 🟡 rather than 🟢. Every app runs as its own uid (`10000 + index`) with a private group and a shared `berth` group, dropped irreversibly in `agent-init` after Landlock, the capability drop, and both seccomp filters. `/context` survives that via `allow_other` + `default_permissions` and `root:berth` backing files; the three daemon control sockets are `0660 root:berth`.
>
> **Designed, then built:** [docs/per-app-uid-design.md](./docs/per-app-uid-design.md) works out the uid scheme, the eight blockers, and a five-step migration for 1.4, 1.11, and 1.14 together. Two findings change this entry. First, **1.5 must land before 1.4**, not after — `on_install` as a boot-time root shell can `chown` its way around every boundary the uid split creates, and moving it to build time is also what keeps system-Python installs working for a non-root app. Second, part 1 cannot be replaced by a narrower Landlock policy: Landlock does not gate `connect()` to a pathname Unix socket (no `inode_permission` hook; ABI 6's scope right covers *abstract* sockets only), so `generate-capability-policy.ts:43-45`'s "connecting to a Unix socket requires write access to it" is a DAC fact, not a ruleset one. The design also records a strictly weaker one-day fallback for 1.4 alone, if the uid work proves too costly.
2. Remove `/tmp` from the unconditional baseline write set; grant only the app's own socket dir plus a private `/tmp/<app>` scratch.
3. Add `SO_PEERCRED` verification in `rpc.ts`'s `connectionHandler` so a socket connection's uid is checked against the expected app identity.

**Verify.** Extend the cross-app boundary test (Test 9) to assert app B cannot invoke app A's exports over A's socket.

**Closed.** Sockets are at `/run/berth/<app>/rpc.sock`, in a directory `0710` owned by that app's uid, with the socket itself `0660` — `chmod`'d explicitly in `rpc.ts` rather than left to the umask, for a reason the negative control below makes concrete. `/tmp` is out of every app's baseline write set, replaced by a private `/tmp/<app>` that `TMPDIR`, `TMUX_TMPDIR`, `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` and `HOME` all point at. `/run/berth` itself is `0755 root:root`, so nothing but `entrypoint.sh` can add an entry.

**The mode is `0710`, not the `0700` the fix above specified, because `0700` would have deleted a shipped feature rather than secured it.** `@berth/agents` synthesizes an agent app whose whole purpose is calling its sibling apps' exports — `network.ts`'s `callSibling`, the agent-as-tool path — by connecting directly to their sockets. A directory nothing but the owner can traverse leaves no way to authorize that. So reaching a sibling is now something an app *declares*: `app:invoke:<name>` puts the caller in the target's per-app group at boot, and `@berth/agents` emits one line per sibling whose exports it embeds as tools, generated from the same list the tools come from so the declaration cannot drift from what the agent can actually call. An app declaring nothing gets `EACCES` from the kernel. Naming an app that isn't in the container warns and is ignored — a manifest is not the place to learn the container's composition.

**Part 3 — knowing which sibling is calling — is closed too, but not with `SO_PEERCRED`, because Node cannot read it.** There is no `getsockopt` in Node, and no way to read ancillary credentials on a Unix socket; this SDK is vendored into images as a tarball with no build step, so a native addon is not a real option either. So the identity comes from the filesystem instead: each authorized caller gets its *own* socket at `/run/berth/<target>/peers/<caller>/rpc.sock`, in a directory mode `2710` owned by the target and group-owned by the caller. The caller is the only unprivileged uid that can traverse into it, so which socket a connection arrived on is a fact the kernel established at `connect(2)` and the caller cannot influence — the same property `SO_PEERCRED` gives, one layer up. The target's own `rpc.sock` went to `0600`: no sibling reaches it, only the app itself and root.

That replaced Step 3's group grant, which is gone and was strictly weaker — putting the caller in the target's group let it connect, but left every caller indistinguishable from inside the server. The setgid bit on each peer directory is what makes this work without a privileged step: the socket the target binds inherits the *caller's* group, so a non-root app never has to `chown` anything.

One honest limit remains: it is a **connect-time** gate, so it authorizes a caller and not a per-export subset — once granted, the target's whole export surface is reachable. Per-export policy is 1.13's territory, and now has an identity to hang off.

Three smaller things worth naming:

1. **The `/run/berth` allowance in `agent-init` is scoped to the app's own name**, not admitted as a prefix the way `/workspace` and `/tmp` are. A prefix would let a policy file claiming to be one app grant write access to every sibling's socket directory — the exact boundary the move draws. The manifest-level allowlist (`ALLOWED_FILESYSTEM_SCOPE_PREFIXES`) deliberately does *not* grow to match, so `/run/berth/...` stays undeclarable in a `berth.yml`; it is compiler-injected only, like the device paths 1.15 added.
2. **`entrypoint.sh`'s multi-app loop is now three serial passes**, not one. A caller can only join its target's group once that group exists, and the target may come later in the app list. The supplementary-group list is also read back with `id -G` after the wiring rather than assembled by hand, so a group added by any step is picked up without that function knowing about it.
3. **Everything that wrote to a hardcoded `/tmp` path was audited rather than guessed at**, since removing the blanket grant breaks anything that assumed it: `tmux`'s socket directory (`TMUX_TMPDIR`), Playwright's browser profiles and Chromium's `--disable-dev-shm-usage` shared memory (both via `TMPDIR`), and `base.Dockerfile`'s image-wide `XDG_CONFIG_HOME=/tmp/.chromium`, which every app in a multi-app container would otherwise have shared. The three daemon control sockets stay at `/tmp/berth-*.sock` and need no write grant — connecting to a pathname socket is DAC, not Landlock (see the design doc), and group `berth` is what permits it.

**Verification — `capability-enforcement.mjs` Test 9, and every assertion is *unconditional*** unlike the Landlock half of that same test, which degrades to informational where Landlock is inactive. This boundary is DAC, so it holds on Docker Desktop exactly as on a real host; if it ever starts passing conditionally, something has reverted to running apps as root.

- App A reaches its own socket — the positive control, since every denial below would also "pass" against apps that simply cannot connect to anything — and is refused on app B's with `EACCES`. Nothing listens at the pre-1.4 path.
- A third fixture, `boundary-app-c`, differs from A by one manifest line and *is* allowed through on its own peer socket, while still being refused on a direction it never declared, and on B's `0600` socket, which would otherwise be a way to call B while carrying no identity.
- **The impersonation case**: app A, which declared nothing, is refused with `EACCES` on the channel B keeps for C. If it were reachable, A could invoke B's exports and be recorded as C.
- **The identity actually arrives**: C makes a real `write_file` call to B over its peer socket, B's log line names `"boundary-app-c"` as the caller, and the file is then read back through B — proving the call ran with B's capabilities and was attributed to C, not merely that a socket was connectable.
- A fixture also declares `app:invoke:no-such-app`, so the unknown-target branch is exercised rather than assumed.

**The negative control is where this gets interesting, and it did not reproduce the exploit as written.** Run against the pre-Step-3 code, `boundary-app-a` connecting to `boundary-app-b`'s socket in the `1777` directory already returned `EACCES`. The reason is mundane and was not a design decision by anyone: the socket file was `srwxr-xr-x` — the default umask — and owned by app B's uid, so `other` had no write bit, and `connect(2)` needs one. **Step 2's per-app uids had closed the connect path by accident**, and the "exploit still works verbatim" note this entry carried after Step 2 was wrong from the moment it was written. What the world-writable directory did still permit was *squatting*: any app could `bind()` a not-yet-started sibling's socket path and serve in its place, which the sticky bit does not prevent. That is the hole this step actually closes, alongside making the boundary a designed one — `0660` is set explicitly now precisely because relying on a umask for a security property is how the above happened.

### 1.5 — `on_install` is unsandboxed root shell run before enforcement

**Evidence.** `packages/manifest-schema/src/schema.ts:89` — `on_install: z.array(z.string())`, no validation. `packages/sdk/src/run-lifecycle.ts:33-36` — `execSync(command, { stdio: "inherit" })`. Called at `entrypoint.sh:45` and `:265`, i.e. **before** `generate-capability-policy.js` and before `exec agent-init`.

So "a Landlock policy applies before your code even runs" is false for this path by construction. Any `berth.yml` — from the registry, from a PR, from 1.6 — executes arbitrary shell as uid 0 with `CAP_SYS_ADMIN`, `/dev/fuse`, AppArmor unconfined, no Landlock domain, and (in dev) the host repo mounted rw.

Note: `entrypoint.sh` itself has no injection surface — manifest `name` is `^[a-z0-9-]+$` (`schema.ts:83`), expansions are quoted, `run_app` is a function not an `eval`. This is a design decision, not an injection bug.

**Fix.** Move `on_install` into the image build (a `RUN` layer in the app's Dockerfile stage) so it executes at build time under the builder's isolation rather than at boot in the runtime sandbox. If it must stay at boot, run it inside a Landlock domain built from the declared capabilities, and drop caps first.

**Verify.** A test asserting an `on_install` entry cannot write outside the app's declared write paths.

> **Was a prerequisite for 1.4/1.11**, which is why it jumped the queue — see [docs/per-app-uid-design.md § Blocker 4](./docs/per-app-uid-design.md#blocker-4--on_install-is-defined-as-a-root-shell--resolved). Leaving `on_install` at boot would have made the uid boundary decorative, and running it *as* the app's uid would have broken the `pip install` case `base.Dockerfile:101` deliberately enables. The build-time fix avoids both.

**Closed.** `on_install` is a Docker build layer, for **both** targets, and nothing executes it at container boot.

Doing it for the production target only would have been the easy half — it already has a `COPY . /app` to hang a `RUN` off. But `berth dev` is the primary workflow and the one 1.6 makes most reachable, and a dev image deliberately contains no app source at all (it arrives via the bind mount at container start). The build *context* still has that source, though, so the dev stage stages a throwaway copy under `on-install/apps/<name>/`, runs each app's generated script against it, and deletes it in the same layer. What survives is exactly what the boot-time version existed to provide — site-packages, apk packages, a built asset — which is what the bind mount doesn't supply. One runner script (`docker/run-on-install.sh`) serves both stages because `apps/<name>/` is the layout production already uses.

Four details worth naming:

1. **The commands go into a generated file, never into a `RUN` directive.** Interpolating a manifest string into a Dockerfile line would make a command containing a newline able to end the `RUN` and have the rest parsed as further directives (`FROM`, `COPY --from`, …). A script file has no such escaping surface. `on_install` entries are also now schema-validated as non-empty and NUL-free, reported per-index so the YAML line mapping points at the offending entry.
2. **The install marker is gone, not merely unused.** There is no boot-time action left to run at most once. `berth dev`'s named volume survives, because it still keeps the generated capability policy out of the developer's working tree, and is renamed `appStateVolume` / `berth-<name>-app-state` to stop describing a marker that no longer exists.
3. **Docker's classic builder resolves `COPY` paths in stages it never runs.** The dev stage's `COPY on-install` failed a `target: "production"` build outright until the context was created for both targets. Found by a build failing at exactly that step, not by reasoning about it.
4. **An `on_install` change now needs a rebuild**, since the watcher restarts the container without rebuilding. That's a real DX cost, stated in `docs/manifest-reference.md` rather than left to be discovered.

**Verification — `packages/docker-orchestrator/test/on-install-milestone.mjs`**, four tests against a real build and a real container. Its fixture's `on_install` writes to `/etc`, which no capability this manifest could declare would permit at runtime; the proof file's presence therefore dates the execution.

The third test is the one that matters, and it reproduces 1.6's chain in full: rewrite `berth.yml` inside a running container, delete the install marker, restart, assert the new `on_install` did not execute. **Confirmed to fail against the old code**, not merely to pass against the new — a negative control run with the boot-time path stashed back in fails all three of "no on_install in the boot logs", "no marker file", and "the rewritten `on_install` did not execute".

That negative control earned its keep immediately: the first version of Test 3 passed against the old code too. `container.restart()` resolves when Docker has started the container, not when `entrypoint.sh` has finished, so the assertion was reading before the payload could have been written — an absence test that always passed. It now waits for the regenerated capability policy, which in both the old and new orderings is written *after* the lifecycle step, before asserting.

Regression-checked: `multi-app-milestone` and `capability-enforcement` pass unchanged; `python-sdk-milestone` had an assertion that the Python lifecycle script *runs* `on_install` at boot — that assertion was the vulnerability, so it is inverted rather than deleted, and the Python path's build-time execution is visible in the same run's build output. `apps/github-assistant`'s `pip install -r requirements.txt` was built through the new dev path directly, and a system-level effect (`/etc` write) was confirmed to persist into a dev image and the staging copy confirmed absent from it.

### 1.6 — `berth dev` bind-mounts the whole host repo read-write

**Evidence.** `packages/cli/src/util/workspace.ts:35-38` — `bindMount: { hostPath: workspaceRoot, containerPath: "/workspace" }` (the entire pnpm workspace root). `container.ts:174` — no `:ro`. Apps declaring `filesystem:write:/workspace` (code-interpreter, notes, terminal, filesystem all do) get Landlock write access to that exact directory. `packages/docker-orchestrator/src/watch.ts:24` restarts the container when `berth.yml` changes.

Full chain: an app rewrites its own `berth.yml` with wider capabilities and a malicious `on_install`, deletes `.berth/installed`, chokidar restarts the container, and 1.5 executes the payload as root with the attacker's own capability list now compiled into the enforced policy. **The `on_install` half of that chain is closed by 1.5** — nothing executes it at boot any more, and `on-install-milestone.mjs` Test 3 asserts exactly this sequence produces nothing. The wider-capabilities half stands: a rewritten `berth.yml` still compiles into the enforced policy on the next restart, and the host-side writes below are untouched and are the more serious half regardless. Independently, writing `/workspace/.git/hooks/pre-commit` or `package.json` scripts gives host-side code execution on the developer's next commit or build.

`berth os up` and `Computer.boot()` don't bind-mount, so this is `berth dev`-specific — which is the primary workflow.

**Fix.** Narrow the bind mount to the app's own directory rather than the workspace root. Mount `berth.yml` read-only. Ignore manifest changes originating from inside the container, or re-read the manifest from the host copy rather than the mounted one.

**Verify.** A test asserting an app cannot modify its own `berth.yml` through `/workspace`.

**Closed.** Not by narrowing the mount, which was the fix sketched above and turns out not to be available: pnpm's `node_modules` symlinks point at sibling package directories by relative path, so mounting only the app's own directory leaves every `@berth/*` import dangling. That is why the whole workspace root was mounted in the first place.

But nothing in that tree needs to be *writable* for module resolution, for reading source, or for reading a manifest. So the root is mounted **read-only** and the two things that genuinely need writing are mounted back over it:

```
/workspace                       workspace root, READ-ONLY
/workspace/<app>/.berth          per-app named volume — the generated capability policy
/workspace/.berth/dev-workspace  host directory — shared app data, via BERTH_WORKSPACE_ROOT
```

This is a *VFS* property (`EROFS`), not a Landlock rule, so unlike most of what this repo enforces it holds identically on a kernel with no Landlock — including Docker Desktop, where `agent-init` fails open and every Landlock assertion is unverifiable. That makes it one of the few boundaries here that is real on a Mac.

Four things worth naming:

1. **`berth.yml` is read-only inside the container**, which is what the fix above meant by mounting it read-only — but via the *directory* mount rather than a file-level bind, so an editor that replaces the file by rename (most of them do) still works on the host side. A file-level bind would have pinned an inode and silently stopped reflecting host edits.
2. **App data moved.** `notes.json`, whatever `code-interpreter` writes, and everything `apps/filesystem` lists now land under `.berth/dev-workspace/` instead of the root of the developer's repo. Every first-party app already read `BERTH_WORKSPACE_ROOT` before falling back to `/workspace`, so this needed no app changes. It's a real host directory rather than a named volume specifically so it stays inspectable — and it's already gitignored, which the root of the repo was not (see `.gitignore`'s list of stray files milestone tests have committed by accident).
3. **Every mountpoint has to exist on the host before the container starts.** Docker cannot create one inside a read-only bind: the nested mount fails at container init with `read-only file system`. Established by trying it, not assumed. That's why `resolveDevBindMount()` has side effects.
4. **A declared write path under `/workspace` that doesn't exist yet no longer gets created.** `agent-init`'s `create_dir_all()` hits `EROFS`, warns, and the grant is skipped — the same failure mode declared *read* paths already have since 1.12. No first-party app is affected (they all declare `/workspace` or `/context`, which exist), and the honest fix is for such an app to write under the dev workspace instead.

**Verification — `packages/docker-orchestrator/test/dev-workspace-mount-milestone.mjs`**, twelve assertions, wired into CI as its own workflow. It imports `resolveDevBindMount` from the built CLI rather than reconstructing the binds by hand, so a change to how `berth dev` mounts things cannot pass here while breaking there.

The app under test is `apps/filesystem`: its declared write path *is* `/workspace`, and its exports are a thin unvalidating wrapper over `fs`, so any escape has to be refused by the kernel rather than by app code. Test 1 asserts it can still write its own workspace *and* that the file appears on the host — every denial below would also "pass" against an app that simply cannot write anything at all. Tests 2–4 are the three writes 1.6 names: the repo root, `.git/hooks/pre-commit`, and its own `berth.yml`, each asserted both as an RPC error and as an absence on the host. Test 6 boots a second, multi-app container, because a companion's `.berth` volume is added by hand in `dev.ts` rather than by `startContainer`'s own option — miss it and `generate-capability-policy.js` fails on the read-only mount, which surfaces much later as an app with no policy.

**Confirmed to fail against the old behaviour**, not merely to pass against the new: with the mount put back to read-write, all seven security assertions fail — and the run really does plant `pwned-root.txt` and `.git/hooks/pre-commit` in the repository it was run from, and overwrite `apps/filesystem/berth.yml`. That is the finding rather than a test bug, so the test deliberately doesn't clean up after itself and its header says so.

**Not closed by this.** `berth dev` still mounts the whole repo *readable*, so an app with `filesystem:read:/workspace` can still read every file in it, including `.env` and `.git`. Narrowing that needs the module-resolution problem solved a different way (a synthetic `node_modules` staged into the image, say), and is a separate piece of work from the write boundary this closes.

### 1.7 — ttyd / VNC / CDP unauthenticated on all host interfaces

**Evidence.** `container.ts:156-165` publishes browser and terminal ports with `{ HostPort: "" }` and **no `HostIp`**, so Docker binds `0.0.0.0` on the host. `entrypoint.sh:55` — `x11vnc ... -nopw`. `apps/terminal/src/tmux-controller.ts:59` — `ttyd --writable` with no `--credential`. `apps/browser-native/src/cdp-controller.ts:29-32` — `--remote-debugging-address=0.0.0.0 --no-sandbox`.

Running `berth dev` on `apps/terminal` on any routable network is an unauthenticated writable root shell for anyone on that LAN. Unauthenticated CDP additionally allows `Page.navigate("file:///etc/passwd")` and `Browser.setDownloadBehavior`, bypassing the egress broker entirely. `--no-sandbox` means a renderer RCE from a visited page lands as root in the container, at which point 1.2 and 1.3 apply.

**Fix.** Bind all published ports to `127.0.0.1` by default (`HostIp: "127.0.0.1"`), with an explicit opt-in for anything wider. Generate a random credential for ttyd and a VNC password at boot, print them alongside the URL. Bind CDP to `127.0.0.1` inside the container.

**Verify.** `docker inspect` shows `127.0.0.1` bindings; connecting to ttyd without the credential is refused.

**Closed.** Four changes, and one of them is a real capability removal rather than a hardening.

**Binding.** Every published port now carries an explicit `HostIp`, defaulting to `127.0.0.1`. Docker's default for an *omitted* `HostIp` is `0.0.0.0`, which is how this happened in the first place — the old code never asked for every interface, it just didn't say. `BERTH_PUBLISH_HOST` (or a `publishHost` option) widens it for the genuine "reach this from my phone" case, and `startContainer` warns, naming the consequence, whenever it isn't loopback. An empty value is treated as unset, so a stray `BERTH_PUBLISH_HOST=` in someone's `.env` can't quietly restore the old behavior. A side effect worth naming: `berth os up` and `Computer.connect()` already *addressed* the HTTP RPC bridge as `http://127.0.0.1:<port>` while Docker was publishing it on every interface — the bearer token was the only thing between a LAN and a resident app's exports. The binding now matches what the code always assumed.

**Credentials.** Generated per boot by `container.ts` and returned from `startContainer`, so `berth dev` can print them next to the URL — the container can only *log* a secret, and a secret in a log stream every resident app can also read isn't one. ttyd gets `--credential berth:<24 random bytes>`; x11vnc gets `-rfbauth` with an 8-character password (VNC's classic auth truncates to 8, so anything longer would overstate its strength) stored in a 0700 directory under `/root`, not the world-writable `/tmp`. Both consumers fail closed rather than falling back to no auth: `apps/terminal` generates and logs its own credential if none was passed in, because a bare `docker run` of that app otherwise produces an unauthenticated writable root shell; and if the VNC password file can't be written, `entrypoint.sh` starts *neither* x11vnc nor websockify — `-nopw` is not an acceptable fallback, and letting `set -e` abort would take the whole sandbox down over a feature nobody may be watching.

**CDP is no longer published at all.** Chromium's `--remote-debugging-address=0.0.0.0` is gone, so it binds the container's loopback interface. This one isn't a hardening — it removes host-side CDP attach, which was a real (if undocumented) debugging affordance. It's the right trade: unauthenticated CDP is arbitrary local-file read (`Page.navigate("file:///etc/passwd")`) and a total bypass of the egress broker (`Browser.setDownloadBehavior`), i.e. it hands away every capability `browser-native`'s manifest carefully scopes, to anything that can open a TCP connection — which was the LAN, any sibling container on the same Docker network, and any app in the same container. Playwright drives Chromium over loopback from inside the container, so nothing legitimate depended on the wider bind. `9222` also came out of `base.Dockerfile`'s `EXPOSE`, so a future `docker run -P` can't republish it by accident. `--no-sandbox` stays and is now commented as to why: Chromium refuses its own sandbox as uid 0, and every process in a Berth container is uid 0 until the per-app uid work in 1.4/1.11.

**Verification.** `packages/docker-orchestrator/test/published-port-security-milestone.mjs`, wired into CI as its own workflow, nine assertions across two real containers. It runs anywhere Docker does — none of it depends on the host kernel providing Landlock, unlike `capability-enforcement.mjs`.

Both key assertions were confirmed to *fail* against the old behavior, not just pass against the new:
- Loopback: re-running with `BERTH_PUBLISH_HOST=0.0.0.0` reproduces the old binding exactly and Test 1 fails on it — which doubles as the escape hatch's own test.
- VNC: Test 9 asserts at the RFB protocol level, reading the security types the server offers a client rather than scraping a log line, because that list is what an attacker on the port actually sees. It offers `[2]` (VNC Authentication). Running x11vnc with the old `-nopw` in the same image offers `[1]` (None) — connect and you have keyboard and mouse.

Two details the tests had to account for. ttyd starts lazily on `apps/terminal`'s first export call, not at boot, so the test drives `read_screen` first — otherwise there'd be nothing listening to authenticate against. And the VNC half needs its own container with `BERTH_TEST_MODE` *unset*: every existing browser milestone runs headless, which skips `entrypoint.sh`'s display stack entirely, so x11vnc would never have started and this change would have looked verified while being untested.

Test 6 exists specifically because tests 4 and 5 would both pass if ttyd were simply broken; it asserts the correct credential still returns 200.

**Not closed by this.** The ports remain reachable by any host-local process (T5 in the threat model) and by other apps in the same container — that's 1.4's per-app uid work, not this. The printed credential is only as private as the terminal it was printed to.

**One caveat on the verification, stated rather than buried — now addressed, pending a CI run.** Tests 4-6 (ttyd's authentication specifically) used to *skip on Linux*, because `apps/terminal` couldn't start tmux there at all — which this milestone is what discovered, filed as 1.15. So on a Landlock-enforcing kernel, what was proven was the loopback binding, the absent CDP port, the credential reaching the container, and the whole VNC story; ttyd's `--credential` was proven only on a host where tmux does start.

1.15 is now fixed (the compiled policy grants the pty devices plus `/dev/null` and `/dev/tty`, and file-targeted rules no longer downgrade the ruleset), so the skip has been **removed** rather than narrowed: ttyd failing to listen is now a plain failure that dumps the container log. A sixteenth assertion checks tmux's server started at all. The first green `ubuntu-latest` run is what turns this caveat from "addressed" into "closed" — and is the same run 1.15 is waiting on.

### 1.8 — Egress broker: no port check, `*` → SSRF, DNS not pinned

**Evidence.** `egress-broker.cjs:160` parses `port` and passes it to `net.connect` at `:182`, but `isHostAllowed` (`:89-91`) takes only `host` — **the port is never checked**. `apps/browser-native/berth.yml:20-21` claims `network:connect:8090`'s job is "to make direct-to-internet connections on other ports impossible"; `CONNECT internal-db.corp:5432` through the broker reaches 5432. Separately, `globToRegExp` (`:59-62`) turns `*` into `.*`, so `browser:navigate:*` permits `169.254.169.254` (cloud IMDS), `127.0.0.1`, and `host.docker.internal` — which `container.ts:258` explicitly wires to `host-gateway`. It also fails to escape `?`. And the check is on the *name*: `net.connect` re-resolves afterward, so DNS pointing an allowed name at a link-local address is unhandled.

Worth crediting: there is **no check-vs-dial divergence and no SNI-spoofing surface** — the same variable is used for both (`:162` vs `:182`), and plain-HTTP absolute-URI requests are checked with the same predicate. That class of proxy bug is correctly avoided.

**Fix.** Add a port allowlist derived from the manifest. Escape `?` in `globToRegExp`. Add a deny list for RFC1918, link-local, loopback, and `host.docker.internal` that applies even under `*`. Resolve the hostname once, validate the resolved IP, and dial that IP with the validated `Host`/SNI (pinned resolution) rather than re-resolving. Strip hop-by-hop headers and normalize the `Host` header on the plain-HTTP path (`:141`).

**Verify.** `egress-broker-milestone.mjs` gains cases for a disallowed port, an IMDS address under `*`, and a DNS-rebinding target.

**Closed.** Five changes, and one of them changes what a capability means.

**Ports are scoped, and that needed a decision.** The `port` was parsed and handed to `net.connect` without being compared to anything. The manifest has no port list to derive an allowlist from — `network:connect:<port>` is a *Landlock* grant about which ports the app itself may reach, and `browser-native` declares only `8090`, the broker's own port, so deriving from it would have denied 443 and broken every browser app. So the port comes from the host scope instead: a capability naming no port covers **80 and 443**, and a scope may name its own (`network:host:internal-db.corp:5432`, or `:*` for any). `CONNECT internal-db.corp:5432` under `browser:navigate:*` is now refused; the same app can still reach that port by saying so.

**`?` was an unescaped regex quantifier.** `a?.example.com` meant "optional a", so it matched `.example.com` and anything ending in it.

**Internal addresses are refused under every pattern, `*` included.** Loopback, RFC1918, link-local (169.254.169.254 is cloud IMDS and hands instance credentials to anything that can make a request), CGNAT, and multicast. `browser:navigate:*` reads as "any site on the internet"; nobody declaring it means "and the metadata service, and the Docker bridge, and the host". `host.docker.internal` is covered by the address check rather than by name, because `container.ts` wires it to `host-gateway` and the gateway is what matters.

**DNS is pinned.** The check was on the name and `net.connect` resolved it again, so a record whose answer changed between the two — rebinding — turned an allowed name into an internal address. One resolution, validated, dialled.

**Hop-by-hop headers and `Host` on the plain-HTTP path.** `proxy-authorization` is the broker's own credential to an upstream proxy and must never be supplied by a request; `Host` is normalized because the request line and the `Host` header can disagree, and many upstreams route by the latter while this broker checked the former.

**Two bugs found by running it, not by reading it.** `dns.lookup()` goes through `getaddrinfo`, which on Alpine/musl races A and AAAA and stalls — the same bug the `family: 4` comments elsewhere in this file already exist to dodge, and which passing `family: 4` to `lookup()` does *not* dodge. In a real container every CONNECT logged nothing at all, because the await never settled and neither branch was reached; `resolve4()` (c-ares) fixes it. Separately, a throw inside either handler was an unhandled rejection, and Node exits on those — so one bad request took egress down for the whole container and surfaced to the browser as `ERR_PROXY_CONNECTION_FAILED`, which reads as a network fault rather than a refusal. Handler failures now deny that one request and leave the broker serving.

**Verification — `egress-broker-milestone.mjs` Part A3**, against the broker script directly, since every one of these is decided before a byte leaves it. Undeclared port refused, default ports still working, an explicitly declared port permitted (asserted on the decision, not a completed tunnel — nothing listens on `example.com:5432`, so an allowed CONNECT legitimately fails to establish). IMDS, loopback, RFC1918 and the Docker bridge all refused under `*`. `localtest.me`, a real public record pointing at `127.0.0.1`, covers the rebinding shape where the name passes the glob and the resolved address does not. A real public host still tunnels, as the positive control — every denial above would also "pass" against a broker that had simply stopped working.

**Confirmed against the old broker, and the assertion is written so the control names the vulnerability rather than timing out on it:** it reports that port 5432 was *allowed*, which is the bug. The naive version of that test just hung, because the old broker dials 5432 and nothing answers.

### 1.9 — GitHub broker: `read:repos` also grants `/user/emails`

**Evidence.** `github-api-broker.cjs:99-105` — `const scope = segments.length > 3 ? segments[3] : "repos"`. Any GET with three or fewer path segments is classified `github:read:repos`. So an app declaring that capability also gets `/user`, `/user/emails`, `/user/repos`, `/gists`, `/notifications`, `/orgs/{org}` — all forwarded with the real `Authorization` header (`:172`). The path is forwarded verbatim (`path: req.url`) with no normalization, so `..` is resolved at GitHub's edge rather than by the policy check.

Also: the MITM CA is trusted process-wide via `NODE_EXTRA_CA_CERTS` (`entrypoint.sh:127`), not scoped to `api.github.com`, and the key lands in a `0755` `/tmp` directory (`:113-120`). And the two brokers don't compose — an app declaring both `github:*` and `network:host:*` gets a raw `CONNECT api.github.com:443` tunnel with no path/verb inspection at all. `apps/github-assistant` is one manifest line away from this.

Worth crediting: the CONNECT gate is strict equality not a glob (`:200`), it forces the upstream `Host` header, and `rejectUnauthorized` stays true on the outbound leg.

**Fix.** Replace the positional `segments[3]` heuristic with an explicit route table mapping path patterns to scopes, defaulting to *deny* rather than `repos`. Normalize the path before matching. Move the CA to a mode-`0700` directory outside `/tmp`. Refuse to start the egress broker for a host already covered by a dedicated broker.

**Verify.** A test asserting `GET /user/emails` is denied for an app declaring only `github:read:repos`.

**Closed.** Four changes: what a path maps to, what a path *is*, where the CA lives, and which broker owns a host.

**The scope came from a position, and positions lie.** `segments.length > 3 ? segments[3] : "repos"` is not a heuristic that occasionally over-grants — every GET with three or fewer segments *was* `github:read:repos`. `/user/emails` has two. An explicit route table replaced it, consulted in order, and a path no route matches is refused with `"requested":"(no route)"` rather than assigned a scope. `/user/<sub>` maps to `user:<sub>` specifically so that `github:read:user` doesn't quietly cover `/user/emails` the same way `repos` did. The table is still GitHub-shaped and still doesn't cover the whole REST API — the difference is which way it fails: a missing route costs an app a 403, not a grant.

**The path was checked here and resolved somewhere else.** `path: req.url` forwarded verbatim meant `/repos/o/r/issues/../../../../user/emails` was classified `github:read:issues` by this broker and read as `/user/emails` by GitHub's edge. Dot segments are now resolved before the check, and the normalized path is what gets forwarded — the same "no check-vs-dial divergence" property 1.8's pinned DNS was about. A `..` climbing above the root, an encoded separator (`%2f` is a separator to some parsers and a literal to others; a broker that has to guess is a broker that can be fooled), and a malformed escape are all denied rather than guessed at. Segments are decoded only to decide what they *are* — what gets forwarded is the original bytes, minus the dot segments, so normalizing can't itself change what GitHub reads.

**The CA key was in world-writable /tmp, mode 0755.** `NODE_EXTRA_CA_CERTS` being process-wide is inherent to the mechanism — Node has no per-host trust knob — which is exactly why the key to that CA is worth protecting: whoever holds it can mint a certificate for any host the app will then trust. It moved to `/run/berth/github-api-broker`, created `0700` with the keys `0600`; `entrypoint.sh` then narrows the directory to `0750 root:<app-gid>`, so the one app that was told to trust the CA can read `ca.crt` and nothing else can. If that narrowing fails the app can't read the CA and its GitHub calls fail the handshake — broken, not open.

**That move needed a policy change to stay working, which is the interesting part.** The read baseline covers `/tmp` in full, so nothing under it ever needed a grant; `/run/berth/<app>` is per-app and doesn't cover a broker's own directory. Node reads `NODE_EXTRA_CA_CERTS` at process start — after `agent-init` has enforced. So `generate-capability-policy` (both the TS and Python compilers) now adds that directory to `readPaths` for an app declaring any `github:*` capability, in the same one-line shape `terminal:*` already uses. Without it, an app that declares any `filesystem:read:` capability — which is what turns read scoping on at all, and `apps/github-assistant` does — would fail every GitHub call on a Landlock-enforcing kernel while working fine on Docker Desktop, which is the exact failure shape REMEDIATION.md 1.15's `/bin`+`/sbin` note describes.

**The two brokers didn't compose, and `apps/github-assistant` is the live case.** It declares `browser:navigate:*.github.com` today; `api.github.com` matches. `egress-broker.cjs` now refuses `api.github.com` under every pattern *when the same policy declares a `github:*` capability* — which is exactly when `entrypoint.sh` has started the dedicated broker for it. Conditional rather than absolute, because an app with no `github:*` capability has no second broker running and no path-level policy to route around; refusing it would be a host this product can't reach for no security gain. What kept this from being exploitable in practice today is unrelated and thin: `github-assistant` declares `network:connect:8092` only, so Landlock refuses it the egress broker's own port. That's a backstop, not the fix.

**Verification, in two places, each against the shipped script directly — every one of these decisions is made before a byte leaves the broker.** `github-assistant-milestone.mjs` gains a no-Docker `runRouteTableScenario()`: `/user/emails` refused with the denial naming `github:read:user:emails`; `/user`, `/gists`, `/notifications`, `/orgs/<org>` refused; the traversal refused with nothing containing `..` reaching the upstream; `/emojis` refused as unrouted; the cert dir `0700` and the CA key `0600`. A declared `/repos/<owner>/<repo>` read forwarded to a real mock upstream is the positive control — every denial above would also "pass" against a broker that had simply stopped forwarding. `egress-broker-milestone.mjs` Part A4 covers the composition half, with both directions asserted: refused for an app declaring `github:read:repos` + `browser:navigate:*`, still reachable for an app declaring neither.

**Confirmed against the old broker, and the assertion says which bug it is:** `/user/emails` comes back `404` — from the mock upstream, not from the broker, which is the whole finding. The message names that explicitly rather than reporting an unexpected status code.

**One thing that needed CI, now had.** The `readPaths` grant matters solely on a kernel that enforces Landlock: the full milestone passes locally on Docker Desktop, where the ruleset is `NotEnforced`, so a local pass shows the new CA path works end to end without showing that the grant is what makes it work. Both milestones are green on `ubuntu-latest` (`095f1ec`), and the run's own policy line carries the grant — `readPaths=... /run/berth/github-api-broker ...` — with the app going on to read that CA and complete a real handshake through the broker.

Stated precisely, because the distinction is the whole point of the paragraph: what that run proves is that the grant is present and the path works on a Landlock-capable kernel. It does not isolate the grant as *necessary* — that would need the same run with the grant removed, which no test does.

### 1.10 — Capability tokens are never verified anywhere

**Evidence.** `verifyCapabilityToken` (`packages/sdk/src/capabilities.ts:60-72`) is exported from `sdk/src/index.ts:6` and called from exactly one place in the repo: its own unit test (`capabilities.test.ts:115-121`). No broker, no RPC path, no governance code reads it. Additionally `BERTH_TOKEN_SECRET` is exported into the app's own environment (`entrypoint.sh:153`, preserved across `exec`), so the constrained process holds the signing key and can mint any token. In multi-app mode each app gets a *different* secret (`entrypoint.sh:267`), so cross-app verification could not work even if someone called it.

The HMAC/expiry/`timingSafeEqual` machinery is cryptographically correct and semantically empty.

**Fix.** Decide which it is. Either (a) delete the token API and stop implying a capability-token model exists, or (b) make it real: mint tokens in a broker/daemon that holds the secret *outside* the app's environment, and check them at every enforcement point (RPC dispatch, both brokers, the governance gate). Option (a) is honest and cheap; option (b) is the foundation for cross-app authz and pairs naturally with 1.4's `SO_PEERCRED` work.

**Verify.** If (b): a test asserting a forged token is rejected at an enforcement point. If (a): the export is gone and the docs no longer mention it.

**Closed as (a) — the token API is deleted.**

The machinery was cryptographically correct and semantically empty, and the reason it could not be fixed cheaply is worth stating plainly: `entrypoint.sh` exported `BERTH_TOKEN_SECRET` into the environment of the app the tokens were meant to constrain. The constrained process held the signing key, so it could mint any token for any capability — and in multi-app containers each app got a *different* secret, so cross-app verification was impossible by construction, not merely unimplemented. A token proves you can read your own environment.

Option (b) would have meant a minting daemon holding the secret outside every app, a socket protocol to reach it, and verification at four call sites. That work would have bought an identity Berth **already has**: since 1.4, which socket a connection arrived on is a fact the kernel established at `connect(2)` and the caller cannot influence. A token signed with a secret the caller holds is strictly weaker than that. Building (b) on top would have been re-deriving, in userspace and worse, something the kernel already tells us.

**What was removed:** `verifyCapabilityToken` (its only caller was its own unit test), `CapabilityGrant`'s `token`/`issuedAt`/`expiresAt` fields, `signToken`, `TOKEN_TTL_MS`, the `node:crypto` import, and both `BERTH_TOKEN_SECRET` exports from `entrypoint.sh` — single-app and multi-app.

**What stayed, because it is real and used:** `requestCapability()`'s allow/deny answer, which reports the decision `agent-init` already compiled into a Landlock policy at boot, and its `pending` submission to the grants server, which is the live human-approval path (`grants-server-milestone.mjs` covers it end to end).

`CapabilityTokenRequest` is renamed `CapabilityRequest`. It never carried a token — it is the log record of a request — and leaving "Token" in the name of the one surviving type would have implied the mechanism still exists.

**This is a breaking change to a published SDK surface**, stated rather than buried: `@berth/sdk` no longer exports `verifyCapabilityToken`, `CapabilityGrant` loses three fields, and `@berth/manifest-schema` renames an exported type. Nothing in this repo consumed any of them outside tests.

**Verify.** The unit test that asserted the HMAC verified correctly is *replaced*, not deleted — the HMAC was never the problem. The new test asserts the absence: a grant carries no `token`/`issuedAt`/`expiresAt`, and `@berth/sdk` does not export `verifyCapabilityToken`. That keeps the API from quietly growing a token back. Full suite 55/55.

**One piece of drift accepted deliberately:** `docs/capability-tokens-reference.md` keeps its filename, because 34 links across 23 files point at it and renaming inside a security change is the wrong trade. Its title and opening now say what it actually documents — kernel enforcement and the grants flow — and why the name persists. Worth folding into 2.4's doc-drift pass.

### 1.11 — Signals unrestricted; any app can kill the governor

**Evidence.** The ruleset handles only `AccessFs` and `AccessNet`; `LANDLOCK_SCOPE_SIGNAL` (ABI v6) is unused. All processes share one PID namespace as uid 0. `kill -9` on the governance app makes every gated call hit the 10s timeout and, in the default `fail-open` mode (`governance.ts:116`, `:151-157`), execute anyway with only a `console.warn`. Killing the egress or GitHub broker forces their fail modes; `kill(-1, SIGKILL)` takes down the container.

**Fix.** Give each app a distinct uid (shares work with 1.4) so signal delivery between apps is refused by the kernel's normal permission check. Make `fail-closed` the default governance mode. Consider `LANDLOCK_SCOPE_SIGNAL` where ABI v6 is available.

**Verify.** A test asserting app B cannot signal app A's process.

> Step 5 of [docs/per-app-uid-design.md](./docs/per-app-uid-design.md#migration-order) — once uids differ, `kill(2)` between apps is refused by the kernel's ordinary permission check and no new mechanism is needed. `LANDLOCK_SCOPE_SIGNAL` stays optional rather than load-bearing.

**Closed.** Two halves, and the second is the one that mattered more.

**Signals.** No new mechanism, exactly as predicted: apps run as distinct uids, so `kill(2)` between them is refused by the kernel's ordinary permission check. `LANDLOCK_SCOPE_SIGNAL` stays unused. That makes this a *test* rather than a fix — and it needs one, because nothing else in this repo would fail if a future change quietly put two apps back on the same uid.

`capability-enforcement.mjs` Test 12 drives a new `probe_signal` export on all three boundary fixtures, and every assertion is **unconditional** like the socket half of Test 9 — this is DAC, so it holds on Docker Desktop exactly as on an enforcing kernel. Positive control first (app A signals its own process, since every denial below would also "pass" against a broken probe or an already-exited pid), then `signal 0` and a real `SIGKILL` from A to B, both `EPERM`, then B confirming it is still alive.

**The negative control is what makes it evidence**, run against the same booted container rather than a hypothetical one: a `docker exec` process — root, and not a descendant of any `agent-init` — signals app B's pid successfully. So the two refusals are the uid boundary and not a stale pid.

**Governance now defaults to fail-closed.** This is the half that actually changed behaviour. The original entry framed killing the governor as a denial of service; under the old fail-open default it was worse than that — one signal and every subsequent gated call executed anyway, with a `console.warn` as the only trace. The gate's authority was contingent on its own uptime.

Per-app uids close the specific kill, but a governor can still crash, hang, or be slow, and a gate that opens under those conditions is not a gate. So `applyGovernanceGate`'s default is inverted: an unreachable governor now throws `GovernanceUnavailableError` instead of calling through. `fail-open` remains available by name for anyone who genuinely wants availability over the guarantee — it is just no longer what you get by not deciding.

Two tests that asserted the old default are inverted rather than deleted (they were asserting the vulnerability), and one is added to keep `fail-open` itself covered. The claim is corrected at every source that repeated it: `docs/governance-reference.md`'s section heading and body, `docs/agents-reference.md`'s human-approval contrast, `docs/threat-model.md`'s open-gap entry, and both `guardrails.ts` and `guardrails.py`, whose module docstrings described governance as "fail-open by design".

**Not closed by this.** Killing a *broker* still forces its own failure mode — that is 1.8/1.9's territory, not this item's. And `governance.exempt` apps stay ungated by construction.

### 1.12 — `agent-init` mkdir's arbitrary manifest paths as root

**Evidence.** `main.rs:274` and `:300` — `create_dir_all(path)` for every entry in `writePaths` *and* `readPaths`, run as uid 0 with `CAP_SYS_ADMIN` before `restrict_self()` at `:332`. There is no allowlist in `compileCapabilityPolicy` (`generate-capability-policy.ts:133-136` adds any string). `filesystem:write:/` grants write to the whole container filesystem with no warning. `stripTrailingGlob` only strips a literal `/*` (`:73-75`), so `filesystem:write:*` creates and grants a directory literally named `*`.

In `berth dev` these directories are created on the **host** through the bind mount.

**Fix.** Add a manifest-time allowlist of permissible capability path prefixes (`/workspace`, `/context`, `/tmp/<app>`, the app dir) and reject anything else at validation time with a clear error. Don't create read paths at all — a missing read path should be a warning, not a side effect. Reject `/` outright.

**Verify.** `berth test` fails a manifest declaring `filesystem:write:/`.

**Closed.** The allowlist is `/workspace`, `/context`, `/tmp`, `/app` — exactly the four paths that exist for an app to use (`/app` because that's where `berth dev` mounts a single app; companions live under `/workspace/<rel>`). It lives in `@berth/manifest-schema` as `ALLOWED_FILESYSTEM_SCOPE_PREFIXES` and is enforced in three places, which is one more than it looks like it needs:

1. `BerthManifestSchema`'s `superRefine`, per capability index, so `loadManifest()`'s YAML line mapping points at the offending list entry — every CLI path (`berth test`, `dev`, `publish`) and the registry get it for free.
2. `compileCapabilityPolicy()`, which warns and skips. Not redundant: a grants-server `approved` string never passes through the schema at all, and the existing precedent there is to drop one bad capability rather than fail policy generation, since agent-init's fallback for "no policy file" is to run *unrestricted*.
3. `agent-init` itself, in Rust, deliberately duplicating the list — it's the process running `create_dir_all()` as uid 0, and in `berth dev` those mkdirs land on the host, so it re-checks rather than trusting a policy file it didn't write. Applied to write paths only: the policy's `readPaths` mixes declared paths with the compiler's own `/usr`, `/lib`, `/etc` baseline, which this list would reject.

Beyond the prefix check, a scope must be absolute and canonical (no `.`, `..`, empty segments, trailing slash), `/` is rejected by name with its own message, and `*` is accepted only as a trailing `/*` — `filesystem:write:*` isn't absolute, so it's now caught by the first check rather than creating a directory literally named `*`.

Read paths are no longer created, per the fix above. The cost is stated rather than hidden: `PathFd::new()` then fails with ENOENT and the grant is skipped *permanently*, because the ruleset is sealed moments later — which bites in a multi-app container, where `entrypoint.sh` starts every app's chain concurrently and an app declaring read on a sibling's directory can run first. The warning now names that consequence; the real fix is boot ordering, not a root mkdir.

Verified: `berth test` on a manifest declaring `filesystem:write:/` exits 1 with `berth.yml:4 capabilities.0: filesystem:*:/ would grant the entire container filesystem`, and `/etc/cron.d` fails the same way naming the allowed prefixes. All 19 real `berth.yml` files in the repo still validate unchanged (the only two that don't are `packages/cli/src/templates/*` with `{{ name }}` placeholders, which never validated). Test coverage: 6 new cases in `packages/manifest-schema/src/schema.test.ts` (including that non-filesystem scopes like `browser:navigate:*` are left alone), 2 new Rust unit tests on the write-path predicate under the `cargo test` step 1.1 added to CI, and the existing capability fuzz test in `packages/sdk` gained three adversarial generators plus a hard assertion that no path in a compiled policy ever falls outside the allowlist.

### 1.15 — `apps/terminal` is non-functional on any Landlock-enforcing kernel

**Evidence.** Found by `published-port-security-milestone.mjs` on its first CI run (1.7) — the first time any test exercised this app against a kernel that actually enforces Landlock. On `ubuntu-latest`, with `ruleset=FullyEnforced`, the app's very first export call returns:

```
{"id":"1","error":"Command failed: tmux new-session -d -x 500 -y 50 -s berth-terminal -c /workspace\nserver exited unexpectedly"}
```

The app boots, registers with the context bus, and reports ready — then every one of its three exports fails, because they all go through `ensureSession()`. This is not a degraded web view: `run_command`, `read_screen`, and `send_keys` are the entire app, and none of them work. It passes on Docker Desktop for Mac purely because Landlock is `NotEnforced` there and `agent-init` fails open.

**Cause, partially established.** Allocating a pty is `open("/dev/ptmx", O_RDWR)` — a *write* open — and `BASELINE_WRITE_PATHS` is `["/tmp"]`, so `/dev` is not writable. `apps/terminal` declares only `filesystem:write:/workspace`.

**But granting the pty devices is not sufficient, and the obvious fix is actively harmful.** Attempted and reverted (see the revert on the 1.7 branch): adding `/dev/ptmx` and `/dev/pts` to the compiled write paths for `terminal:*` apps. Two results, both from a real CI run:

1. tmux **still** fails with the same error, so pty write access is necessary but not the whole story. Note `/dev/ptmx` is a symlink to `pts/ptmx`, so a `/dev/pts` rule should already cover the real node — whatever tmux needs beyond that is unidentified.
2. The ruleset status degraded from `FullyEnforced` to **`PartiallyEnforced`**. Adding a rule on the devpts mount is what changed it. That matters more than the feature: `agent-init` refuses to exec unless the status is exactly `FullyEnforced` when `BERTH_REQUIRE_ENFORCEMENT=1`, which is what a production deploy sets — so shipping that change would have turned a broken app into an **unbootable** one.

**Fix.** Unknown; needs real investigation rather than another write-path guess. Establish first what tmux actually gets `EACCES`/`EPERM` on (strace it under an enforced ruleset), and separately why a devpts rule downgrades the ruleset — if `PartiallyEnforced` is unavoidable for any app needing a pty, then either the pty grant needs a different mechanism entirely, or `agent-init`'s exactly-`FullyEnforced` requirement needs a considered exception, which is a security decision, not a workaround.

**Verify.** `published-port-security-milestone.mjs`'s Tests 4-6 stop skipping (they skip today only on this exact tmux signature, and fail on anything else), and a new assertion that `run_command` round-trips on a Landlock-enforcing kernel.

**🟢 Closed — the enforcing-kernel run is green.** `Published Port Security` passed on `ubuntu-latest` (`main`, 2026-08-09), which is the artifact this entry was waiting on: with the tmux skip removed, tmux starting under a real Landlock ruleset is now asserted rather than assumed. What follows is the original amber write-up, kept because it is the record of how both unknowns were established.

**Originally filed as: fixed and unit-tested; the enforcing-kernel proof has not run.** Both unknowns above are now answered, by evidence rather than another guess. Status stays amber deliberately: the decisive artifact is a CI run on `ubuntu-latest`, and this was developed on a Mac where Landlock is absent, so the end-to-end assertion has never executed. Everything below is either established fact or verified locally.

**Unknown 1 — what tmux actually needs.** `strace`d a real `tmux new-session` inside the terminal image. It opens four things read-write:

```
openat("/tmp/tmux-0/default.lock", O_WRONLY|O_CREAT)   /tmp — already baseline
bind(AF_UNIX, "/tmp/tmux-0/default")                    /tmp — already baseline
openat("/dev/null",  O_RDWR)                            ← never granted
openat("/dev/ptmx",  O_RDWR|O_NOCTTY)                   ← the previous attempt granted this
openat("/dev/pts/0", O_RDWR|O_NOCTTY)                   ← ...and this
openat("/dev/tty",   O_RDWR)                            ← never granted
```

So "granting the pty devices is not sufficient" has a mundane answer: a tmux server also opens `/dev/null` to daemonize. That is now in `BASELINE_WRITE_PATHS` for *every* app rather than scoped to terminal ones — opening `/dev/null` read-write is what any process does when it redirects a child's stdio to it, so scoping it here would have left the same landmine for whichever app next spawns a child with `stdio: "ignore"`. `/dev/pts` and `/dev/ptmx` are added only for an app declaring `terminal:*`, which is the one thing that capability now compiles into the kernel policy.

`/dev/tty` is deliberately *not* granted, though the strace shows tmux opening it. The first CI run of this fix is what established why: it is the calling process's *controlling terminal*, and `agent-init` has none — these containers are created with `Tty: false` — so `PathFd::new()` fails with `ENXIO` and the grant is skipped, warning on every boot of every app. It is also unnecessary: the process that opens `/dev/tty` is the shell inside the pty, for which it resolves to `/dev/pts/N`, already covered. tmux was confirmed to start under real enforcement with that grant skipped, which is the proof it was never load-bearing.

**Unknown 2 — why a devpts rule downgraded the ruleset.** Not devpts-specific, and not really about `/dev` at all. `landlock` 0.4's `PathBeneath` compatibility pass `fstat()`s the rule's target and, if it isn't a directory, masks the requested access down to `ACCESS_FILE` (`ReadFile | WriteFile | Execute | Truncate | IoctlDev | ResolveUnix`). Everything else in `AccessFs::from_write(ABI::V3)` is directory-only. When that mask changes anything the crate returns `CompatResult::Partial` — its own source comments "Linux would return EINVAL" — and under `BestEffort` that downgrades the whole ruleset to `PartiallyEnforced`.

`/dev/ptmx` is a symlink to the `pts/ptmx` **character device**, and `PathFd::new()` follows it. So the rule targeted a file, carried directory rights, and downgraded the ruleset — which a production image refuses to boot on. **Any** file-targeted write rule would have done the same; the pty work merely happened to be the first to add one.

`agent-init` now picks the access set per path from the inode type: `write_access_rights()` for a directory, `write_access_rights() & AccessFs::from_file(ABI::V3)` for anything else. The crate then has nothing to mask and reports no downgrade. It also stops calling `create_dir_all()` on a path that already exists — that would otherwise warn `ENOTDIR` on every boot now that some write paths are device nodes.

**Verified locally.** Six new tests, all passing: five Rust unit tests (the file set contains no directory-only right; access rights are chosen by inode type against real `/tmp` and `/dev/null`; the device allowance is exact-match so `/dev`, `/dev/sda`, `/dev/mem` stay refused) plus a JS fuzz update. One of them is the closest thing to a kernel-free proof of the downgrade fix available: it asserts `file_write_access_rights() & AccessFs::from_file(V3) == file_write_access_rights()`, which *is* the crate's downgrade condition, and asserts the directory set fails that same check — so the distinction can't quietly become dead code. The `packages/sdk` capability fuzzer now generates `terminal:*` capabilities and asserts the pty grants appear **only** when one was declared, which is what keeps this from being a silent widening for every app in the repo.

The skip is gone from `published-port-security-milestone.mjs`, per the verify criterion above, and replaced with a positive assertion that tmux's server started — made against the container log rather than an RPC result, because the stdio attach is documented as racy while the log line is not. That takes the milestone from 14 assertions to 15, and it passes on Docker Desktop.

**What this does not prove.** Docker Desktop's kernel has no Landlock, so locally the ruleset is `NotEnforced` and `apps/terminal` worked before this change as well as after. Nothing here demonstrates that tmux now starts *under enforcement*, or that the status is `FullyEnforced` rather than `PartiallyEnforced` — those need the CI run. No VM tooling (colima/lima/multipass) is installed on this machine and installing one wasn't in scope. That run has since happened and is green (see the header above), which is what closed this. The log dump on the `!listening` path stays, so a future regression prints the container log rather than skipping past it.

**Wider implication worth noting.** This went unnoticed because every milestone test that runs on a real kernel happens to cover apps whose needs Landlock's write model expresses cleanly. `apps/terminal` had no CI coverage at all. It is worth asking which other first-party apps have never been run against an enforcing kernel — that is the same gap 6.3 describes from the other direction.

### 1.13 — Governance gate bypasses

**Evidence.** `applyGovernanceGate` wraps `Tool.invoke` in a returned array; anything not in that array is ungated. Gated: resident-app tools via `Computer.boot()`/`connect()` (`computer.ts:217`, `:308`), fleet computers (`fleet-computer.ts:70`), the retriever (transitively), human approval (layered on top). **Not gated:** MCP tools (`agent.ts:479-480` concatenates them *after* gating), `Agent.asTool()` delegation (`agent.ts:324`, `crew.ts:180-183`), `berth rpc` (`commands/rpc.ts:33`), `berth mcp` (`commands/mcp.ts:70`), the HTTP RPC bridge (`http-rpc.ts:80`), direct Unix socket (1.4), and the TCP RPC listener (`rpc.ts:85`).

`governance.ts:105-107` documents two of these; the rest are undocumented.

**Fix.** Move the gate from the tool array to the dispatch function so every path through `invokeExport` is covered, rather than wrapping one particular list. Route MCP tools and agent-as-tool through it explicitly. Default `mode` to `fail-closed`.

**Verify.** A test per row of that table asserting a denied action stays denied through each transport.

**🟡 The in-process bypasses are closed; the separate transports are not.** Splitting the entry this way is deliberate — the two halves have different fixes, and calling the whole thing done would overstate it.

**The gate moved off the tool array and onto the dispatch.** That was the actual defect: `applyGovernanceGate` mapped over one `Tool[]`, so it protected exactly the tools in that array at that moment, and anything assembled afterwards was never gated — not because those paths were considered and allowed, but because they weren't in the list. `resolveGovernanceGate().gateDispatch()` now wraps the dispatch function itself, and `computerToolsFor()` builds tools *from the gated dispatch*, so a tool that skipped the gate can no longer exist on a governed Computer. `computer.call()` and the retriever come along for free, because they were always routed through that same dispatch.

Two consequences worth naming. The governor's own exports bypass the gate explicitly, because routing `evaluate_action` through it would recurse forever — previously that fell out of the tool-name lookup by accident, and now it is a stated rule with a test. And the old owner map keyed on `toolNameFor()`, so gating depended on a tool's *name* matching what the map expected; at dispatch level the app and export names are the arguments, and no name matching is involved.

**MCP and agent-as-tool are gated under synthetic app names**, since neither has a resident app behind it:

| Path | Announced as |
|---|---|
| MCP server tool | `{ app: "mcp:<server>", export: "<tool>" }` |
| Delegated agent (`asTool()`, i.e. what `Crew.withManager()` hands a manager) | `{ app: "agent:<name>", export: "invoke" }` |

The prefixes carry information a governor can act on without recognising every name: `mcp:` means the action leaves the sandbox entirely, `agent:` means work is being handed to another agent. Delegation is one decision rather than one per tool the delegate owns — the governor decides whether that agent may be given the task at all, and the delegate's own calls are then gated as it makes them. `McpClientHandle` gained a `name` so the identity comes off the handle rather than being reconstructed from the caller's options; unnamed servers all collapse to `mcp`, which is a reason to name them.

**This is a behaviour change for anyone already running a governor**, stated here rather than discovered: a governance app that denies apps it does not recognise will now deny MCP and delegation calls that previously ran ungated. That is the bypass closing, but combined with 1.11's fail-closed default it is worth checking before upgrading. Called out in `docs/governance-reference.md` too.

**Still open, and now the whole of what this entry tracks:** `berth rpc`, `berth mcp`, the HTTP RPC bridge, the TCP RPC listener, and direct `invokeAppExport()`. These are separate transports into the same container, and no governance app sits on their path — closing them means either routing them through a Computer or giving the governor a presence at the SDK's own RPC dispatch, which is a larger design question than moving a wrapper. 1.4's per-caller sockets now give that dispatch a caller identity to hang per-export policy off, which is the natural foundation for it.

**Verification.** Seven unit tests in `packages/agents/src/governance.test.ts`: a denial through the raw dispatch (not merely through a tool), the governor's own exports bypassing without recursion, `governance.exempt` honoured at dispatch level, the exact `{app, export, input}` payload for both synthetic identities, an unreachable governor blocking an MCP tool under the fail-closed default, and the no-governor case returning `undefined` so ungoverned Computers pay nothing.

### 1.14 — Unbounded frame allocation and spoofable identity in the daemons

**Evidence.** `context-bus-daemon/src/main.rs:216-218` — `let len = u32::from_be_bytes(...) as usize; let mut buf = vec![0u8; len];`. A 4-byte header of `0xFFFFFFFF` allocates 4 GiB. Identical in `semantic-fs-daemon/internal/control/control.go:170-171`. Both daemons run as root outside any Landlock domain.

Identity is self-asserted in both: `main.rs:125` (`app_name = req.app`) and `control.go:135-137` (`registry.Register(req.Pid, req.App)` from the request body), so any app can publish under another's name or poison semantic-fs write attribution. Delivered context-bus events carry no sender at all (`main.rs:146-149`).

Killing semantic-fs is worse than a crash: `runtime.ts:44-46` silently falls back to a stub returning **empty query results**, so retrieval, checkpoints, sessions, and traces degrade to silent data loss rather than an error.

**Fix.** Cap frame length (a few MB) and reject oversized headers before allocating, in both daemons. Derive the app identity from `SO_PEERCRED` rather than the request body. Make the semantic-fs stub fallback throw rather than return empty, or at minimum emit a loud persistent warning on every call.

**Verify.** A test sending an oversized length header and asserting the daemon survives; a test asserting app B cannot register as app A.

> The frame cap is independent and can land any time. The identity half cannot: `SO_PEERCRED` returns uid 0 for every caller today, so it carries no information until [docs/per-app-uid-design.md](./docs/per-app-uid-design.md) Step 2 lands. Sequenced there as Step 4.

**Closed.**

**Frame cap.** Both daemons refuse a length header above 8 MiB *before* allocating, and drop the connection — a client that framed one message this badly has no credible next frame on the same stream. 8 MiB is orders of magnitude above what either daemon actually carries (small JSON-ish events on the bus; register/tag/query with an embedding vector as the largest payload on semantic-fs) and refuses the 4 GiB a `0xFFFFFFFF` header used to reserve.

**Identity.** Both daemons now derive it from `SO_PEERCRED` — `tokio::net::UnixStream::peer_cred()` in the context bus, `syscall.GetsockoptUcred` in semantic-fs — read once at `accept()`, since the uid the kernel stamped on a connection cannot change for its lifetime and the client cannot influence it. The rules are three, and identical in both (deliberately duplicated implementations, `src/peer.rs` and `internal/control/peer.go`, each with the other named in its header and the same cases in its tests):

1. **uid 0 keeps its own claim.** The host relay, the daemons themselves, anything that already has full authority in this container — see [Blocker 7](./docs/per-app-uid-design.md). A root caller could set that uid anyway.
2. **A uid that resolves to a `berth-<app>` account *is* that app**, whatever the frame says. A contradicting claim is overridden and logged.
3. **Any other uid gets `uid-<n>`.** Not an error, but its claim about an app name is worth nothing. A system account whose name merely lacks the prefix is deliberately not an app, or adding any user to the image would hand it an identity.

Two details worth naming. The failure path — credentials unreadable — resolves to the *most restrictive* answer, not to root; a connection whose credentials cannot be read is one whose claims are worth less, not more. And for semantic-fs the forged **pid** mattered as much as the forged name: the FUSE layer attributes a write by looking the writing pid up in this registry, so a caller able to register another process's pid could attribute its own writes elsewhere. Both now come from the kernel.

**The stub fallback is closed too, and the fix is conditional on where the app is running.** `runtime.ts` used to fall back to `createLocalSemanticFs()` whenever the daemon wasn't reachable, and that stub returns an empty result set from `query()`. Outside a sandbox — a bare `node dist/index.js` in a unit test — that is a truthful answer: there is no index. Inside one the index exists and the daemon is meant to be serving it, so the same empty array is a *wrong* answer, indistinguishable from "nothing matched", on the path every checkpoint, session, trace and retrieval read goes through.

So the fallback now splits. Outside a sandbox, the local stub is unchanged. Inside one, apps get `createUnavailableSemanticFs()`, which throws on `query()` and on `tag()` — a tag that stored nothing is a lost write, not a successful one. `register()` deliberately does *not* throw: it runs at boot, and taking the whole app down because attribution is unavailable is worse than running with `/context` writes unattributed, which it says once, loudly. Every later call still throws.

`BERTH_BOOT_ID` is the discriminator, because `entrypoint.sh` exports it before anything else in the container starts — so it is present for every process in a sandbox and for nothing outside one. The socket path would not do: it has a default whether or not a daemon was ever launched.

**A second silent path, found while fixing the first.** The client above only covers a daemon that is already gone at boot. For one that dies *later*, `unix-socket.ts` rejected in-flight calls on `close` but had no `error` handler at all — so a `socket.write()` to a destroyed socket raised an `error` event nothing was listening for, which in Node is an uncaught exception that takes the app down. And every subsequent call sat for the full 5s call timeout before failing with a message naming nothing useful. Both are fixed: the connection records why it went away, later calls reject immediately and by name, and the `error` event is handled.

**Verification.** Four unit tests in `packages/sdk/src/semantic-fs/semantic-fs.test.ts` — `query()` and `tag()` throw and name the daemon, `register()` warns exactly once and resolves, and a real Unix socket server is stood up, connected to, and then destroyed to prove a call afterwards rejects promptly rather than after the 5s timeout.

Adding that file exposed a packaging bug worth naming, because it was silently deleting test coverage: `@berth/sdk`'s test script was `node --test dist/**/*.test.js`, and in the shell pnpm runs scripts through, `**` matched exactly one directory level. The moment a test file existed in a subdirectory, the glob matched *only* it — the run went from 39 tests to 4 and still exited 0. It is now an explicit two-pattern list, and the suite reports 43.

**Verified end to end too, but only after fixing two transport bugs that were hiding it.** The obvious integration test — kill `semantic-fs-daemon`, re-run the query that just worked, assert an error rather than `[]` — appeared to show the app wedging completely: it stopped answering on its stdio RPC channel, while `/proc` showed the Node process alive and idle and a *freshly attached* client got answers immediately. Chasing that turned up two independent, pre-existing bugs in how this repo talks to a container over `container.attach()`, both in `stdio-rpc.ts` — the client `Computer.boot()` uses for every single-app container — and in all nine test files that copy the same pattern.

1. **docker-modem writes the attach options into the container's stdin.** `attach` is a POST, and `dial()` does `data = JSON.stringify(opts._body || opts)` for *every* POST, so `{"stream":true,"stdin":true,...}` is sent as the request body with no trailing newline. After the connection upgrades those bytes are the first thing on the container's stdin, and the app reads `{"stream":true,...}{"id":"1","export":...}` as one line and discards it as unparseable — so the first RPC call on every attach was silently lost. Confirmed by reading the app's own log inside a running container, which shows exactly that concatenated line. Fixed by writing a `\n` immediately after attaching, which terminates the stray body as its own ignored line. (`_body: {}` is the tidier-looking fix and does not work: docker-modem then sends a chunked request with no body and the attach never completes — the container hangs at startup.) `python-sdk-milestone.mjs` had found this and worked around it for itself; nothing else had, which is the likely cause of the intermittent "first RPC call timed out" failures across these tests, and of the retry-once hack two of them carry.
2. **A dead attach stream was indistinguishable from an unresponsive app.** The stream's read side had already ended — while the container and the app were both healthy and answering a new client — and writes to it were silently dropped, so every call sat out its full 30s timeout blaming the app. `createStdioRpcClient` now reattaches when its stream is gone (safe precisely because it only runs when the stream is already dead — the warning about never re-attaching is about calling `end()` on a *live* one), reports a dropped write instead of waiting, and handles the socket's `error` event so it cannot become an uncaught exception in the process driving the container.

With those fixed the assertion is straightforward and passes: after `pkill -9 semantic-fs-daemon`, the same query returns `{"error":"semantic-fs call \"query\" cannot be sent: the control socket closed"}` rather than an empty result set.

**Verification.** `capability-enforcement.mjs` Test 9's daemon half, asserted on the daemons' own log lines rather than on a response, because both daemons ack a register either way — the point is not that the call fails, it is that the name recorded is not the one sent. App A registers with both daemons as `boundary-app-b` (and, on semantic-fs, as pid 1); both log the override and record `boundary-app-a`. Then app A sends a `0xFFFFFFFF` length header to each, and the bus is asserted to still serve a fresh registration afterwards — a daemon that had died would fail that, and one that had allocated 4 GiB would likely have taken the container with it. Unit tests in both daemons cover the three rules and the zero-value failure path directly.

---

## Phase 2 — Close the credibility gap (~3 days)

The gap between what the README claims and what the code does is the fastest way to lose a technical evaluator. These are documentation changes, but they are not cosmetic — they change what a reader is entitled to believe.

| # | Item | Status | Effort |
|---|------|--------|--------|
| 2.1 | Write an actual threat model | 🟢 | 1d |
| 2.2 | Soften README claims to match current enforcement | 🟢 | 4h |
| 2.3 | Correct "query by intent" to describe what Semantic FS does | 🔴 | 2h |
| 2.4 | Fix doc drift (Crew shape counts, provider tests, YAML count) | 🔴 | 2h |

### 2.1 — Write an actual threat model

**Evidence.** Across README, SECURITY.md, ROADMAP, CONTRIBUTING, gaps.md, and all 21 files in `docs/`: `threat model` — zero occurrences. `trust boundary` — zero. `untrusted` — zero. `malicious` — zero. `adversar*` — one line. `attacker` — one line.

The raw material already exists and is unusually honest, just scattered and framed as feature scope: `capability-tokens-reference.md:66` (fail-open is the default), `multi-app-reference.md:5` (a `docker exec` path bypasses `agent-init` entirely — *this is an enforcement bypass documented as a feature note*), `governance-reference.md:54` ("a v1 default, not a security guarantee"), `README.md:319-320` (two capabilities are "recorded and reported only").

**Fix.** One page, `docs/threat-model.md`: assets, adversaries (prompt-injected agent, malicious resident app, malicious manifest from the registry, network attacker, host-local attacker), trust boundaries, what is enforced by what mechanism, and an explicit "not protected against" list that consolidates the scattered notes. Link it from the README security section and from SECURITY.md.

**Verify.** Every deferred-scope note in `docs/*.md` is either referenced from the threat model or moved into it.

**Closed.** `docs/threat-model.md`: seven assets, six adversaries (T1 prompt-injected agent → T6 malicious remote endpoint, plus an explicit trusted-by-assumption list — host kernel, Docker daemon, LLM provider), nine trust boundaries with the mechanism holding each and its real strength, the three-tier enforcement table with a *verification artifact* per row, and two separate "not protected" lists.

Three things worth naming about how it's written, because they're what make it useful rather than decorative:

1. **The adversaries are ordered by how well Berth does against them, and it says so.** T1 is what the kernel layer is designed for and holds against; T2 (malicious resident app) and T3 (malicious manifest) are where the architecture is weakest, stated in those words. The section on trust boundaries ends on the pattern behind it — B2 is genuinely strong and everything adjacent to it is weak — which is the same sentence Phase 1's preamble opens with, now reachable by a reader who never opens this file.
2. **"Not protected against" is split into *open gaps* and *out of scope by decision*,** because conflating them is how a threat model becomes a to-do list nobody trusts. Open gaps carry their remediation ID. The out-of-scope list carries the *reason* — per-syscall audit logging is impossible because Landlock has no deny-notification hook, not merely unimplemented; `docker exec` bypassing `agent-init` is inherent to Docker, not a bug `--apps` failed to fix.
3. **A closing map from every `docs/*.md` scope section to the section covering it**, which is this item's verify criterion made checkable rather than asserted. Thirteen source docs, including the four whose scope notes have no threat-model impact (local-Docker-only, YAML shape limits, schema fidelity) — named as such rather than silently omitted, so the map is a complete accounting.

Two claims got corrected against the source while writing it: the enforcement-tier table's test references (Tests 1–2 and 10 are writes, 3–4 reads, 6–7 symlink escape and concurrency — the earlier draft's grouping was wrong), and the snapshot entry, which separates a real decision (`BERTH_TOKEN_SECRET` deliberately not captured, since restoring a stale secret is a regression) from the gap sitting next to it (the whole container environment *is* captured to an unmodded `env.json`, 5.5).

Linked from three places: the README's `What isn't enforced yet` section (both as an entry point for evaluators and as the "full version" pointer under the summary line 2.2 ended on), and SECURITY.md twice — once at the top as required reading before filing, once in the report checklist, replacing the capability-table-only pointer with one that names the specific section defining what counts as a vulnerability. All relative links and anchors verified to resolve.

### 2.2 — Soften README claims to match current enforcement

Specific lines that are currently false or unsupportable:

- `README.md:88` — "a prompt-injected 'ignore previous instructions, delete everything' never even reaches the syscall." True for `open(O_WRONLY)` and, since 1.1, `truncate` on an enforcing kernel; ~~`unshare` (1.3)~~, ~~`on_install` (1.5)~~ closed; sibling sockets (1.4) are now refused by DAC rather than by the kernel's Landlock domain, and only for a caller that declared no `app:invoke:` — the sentence is defensible for that path but the mechanism is not the one it implies.
- `README.md:45` — "An undeclared write isn't caught by a try/catch. The kernel refuses the syscall outright." Same caveats. `truncate` used to be the clean counterexample; 1.1 closed it, and `execve` is the remaining unhandled right (deliberately — see 1.1).
- ~~`README.md:100` — code-interpreter has "zero outbound network access, full stop." False for UDP (1.2).~~ Closed by 1.2: both this line and the `network:connect:` matrix row now name the two mechanisms (Landlock for TCP, seccomp for UDP/raw) and state the remaining limit — an app that declares any port keeps UDP for DNS.
- ~~`README.md:316` — `network:connect:*` "denied by default... zero outbound TCP, full stop." The "TCP" qualifier is doing load-bearing work that readers will miss.~~ Same fix; the qualifier is no longer load-bearing because the non-TCP paths are closed for the apps the claim is about.

**Fix.** State the enforcement matrix plainly — which syscall classes are kernel-enforced, which are broker-enforced, which are advisory — and add the platform caveat from 0.1. "Kernel-enforced filesystem scoping, with network and cross-app isolation in progress" is both more honest and, to a serious buyer, more credible than the current claim.

**Closed.** A new `### What isn't enforced yet` section sits directly under the capability table and does two things: a three-tier table (kernel / broker / recorded, with the mechanism and what each is worth), then the seven open gaps that change what a reader should be willing to run — 1.3, 1.4, 1.5, 1.6, 1.7, 1.13, and 1.10 — each in one sentence, linked to this file for the evidence. It ends on the summary line this item asked for: kernel-enforced filesystem and network scoping is real and testable today, cross-app and in-container privilege isolation is in progress, and Berth is not yet a boundary to trust against an attacker who already has code execution inside the container.

The three overclaiming lines are fixed rather than deleted. Line 45 now says *write* specifically, names the platform dependency with a link to 0.1's matrix, and points at both the per-capability table and the new limits section. Line 88 turned out to contain a claim the README's own table already contradicted — it said `terminal:attach:*` is "enforced by the kernel (Landlock)" while the table lists it as recorded-only — so that's corrected, and the surviving filesystem claim is made concrete (`rm -rf /etc` dies on `unlink(2)` with `EACCES`) rather than sweeping. Line 323's "the kernel enforces this list" became "filesystem and network scoping is compiled into a kernel policy; the rest is brokered or recorded."

Not attempted here: 2.1's `docs/threat-model.md`, which is where the scattered deferred-scope notes should ultimately be consolidated. The README section is deliberately a summary with a pointer, not a substitute for it.

### 2.3 — Correct the Semantic FS description

**Evidence.** `packages/sdk/src/semantic-fs/embeddings.ts:4-8` says it outright: embeddings come from `tag()`'s task/relatedApps/path text, **not file content**. `unix-socket.ts:103` embeds `` `${task} ${relatedApps.join(" ")} ${path}` ``. `semantic-fs-daemon/internal/index/index.go:216-231` scores `float64(keywordScore) + cosineSim` where cosine ∈ [0,1] — one substring hit outranks a perfect semantic match. Files never explicitly tagged have no embedding at all (`control.go:146-150`). No vector index: `SELECT *` over every row, then an insertion sort (`index.go:189-192`, `:237-241`).

The code comments are honest. `packages/sdk/src/semantic-fs/client.ts:9` and the README say "query by intent" with no caveat.

**Fix.** Describe it as what it is — a hybrid keyword-and-tag index with optional embedding assist over tag text — and note the scaling limit. Optionally add a real content-embedding path later, but don't claim it until then.

### 2.4 — Fix doc drift

- Four places say "six Crew shapes"; TypeScript has **seven** (`crew.ts:117`: sequential, withManager, networked, parallel, loopUntil, route, pipeline) and Python has six. `README.md:325`, `packages/agents-python/pyproject.toml:4` (this one ships to PyPI), `docs/agents-python-reference.md:3` and `:18` — the last contradicts itself in one sentence ("five of Crew's six shapes:" then lists six).
- `docs/agents-python-reference.md:66` claims no TypeScript provider has a unit test, used to justify leaving Python providers untested. `packages/agents/src/fallback.test.ts` exists with 9 tests, and there are eight provider files, not six.
- `docs/agents-reference.md:723` says "those three shapes stay code-only" and lists four.
- `packages/agents/src/types.ts:31-36` names 2 of 7 shipped providers; this lands in the published `.d.ts`.

---

## Phase 3 — Core agent-loop bugs (~1 week)

Real defects in shipped code, independent of security.

| # | Item | Status | Effort |
|---|------|--------|--------|
| 3.1 | `tools: []` breaks every OpenAI-family LLM judge | 🔴 | 2h |
| 3.2 | Truncated responses returned as final answers | 🔴 | 4h |
| 3.3 | `Crew.parallel` shares one `runId` across concurrent agents | 🔴 | 4h |
| 3.4 | Denied human approval doesn't stop the run | 🔴 | 4h |
| 3.5 | Checkpoints written per turn, not per tool call | 🔴 | 1d |
| 3.6 | Anthropic empty-content messages rejected by the API | 🔴 | 2h |
| 3.7 | No provider adapter has a unit test | 🔴 | 2d |

### 3.1 — `tools: []` breaks every OpenAI-family LLM judge

`packages/agents/src/guardrails.ts:92` and `eval.ts:225` both call `judge.chat({ messages, tools: [] })`. `providers/openai.ts:85` unconditionally sends `tools: tools.map(...)`, and the OpenAI API rejects an empty tools array. So `createLlmGuardrail()` and `llmJudge()` — the two LLM-judge features — fail against OpenAI, Azure, Bedrock, and Ollama. `providers/google.ts:98` guards this correctly (`tools.length > 0 ? ... : undefined`); Anthropic tolerates it, which is why it went unnoticed.

**Fix.** Omit the `tools` key when the array is empty, in `openai.ts` and every provider derived from it. **Verify.** Covered by 3.7.

### 3.2 — Truncated responses returned as final answers

No provider reads `stop_reason`/`finish_reason` (zero grep hits in `providers/`). Anthropic's `maxTokens` defaults to 4096 (`anthropic.ts:23`); the OpenAI provider has no max-tokens control at all. A response cut off at the limit returns `toolCalls: []`, and `agent.ts:224` treats that as the final answer — silent truncation presented as success. With a `responseSchema` it burns every repair attempt on unparseable half-JSON. OpenAI's `content_filter` and `message.refusal` are equally unread.

**Fix.** Surface `stopReason` on `LLMTurn`; throw a typed `TruncatedResponseError` when it indicates a length cutoff or content filter.

### 3.3 — `Crew.parallel` shares one `runId` across concurrent agents

`crew.ts:233-238` (and Python `crew.py:208`) pass `options.runId` to N agents under `Promise.all`. With a checkpoint store or the `"full"` tracer, all N write the same key; the surviving checkpoint is an interleaved mixture and `resume(runId)` replays garbage. `tracing.ts:66-70` already acknowledges the trace-file race.

**Fix.** Derive a per-agent key (`${runId}:${agent.name}:${index}`) for checkpoints and traces in every fan-out shape. **Verify.** A test asserting N parallel agents produce N distinct checkpoints.

### 3.4 — Denied human approval doesn't stop the run

`approval.ts:120-124` throws `HumanApprovalDeniedError` from inside `tool.invoke`, so `agent.ts:270-284`'s tool-error handling catches it and feeds it back as an `{error}` result. The model can immediately re-issue the identical call and open a fresh grant request. Documented as fail-closed; behaves as advisory.

**Fix.** Let a denial (and a guardrail trip) propagate out of the loop instead of being caught — check the error type before converting it to a tool result.

### 3.5 — Checkpoints written per turn, not per tool call

`agent.ts:291` checkpoints after the whole `for` loop at `:261-289`. A crash after tool call 3 of 4 loses all four and re-executes them on resume, including side-effecting ones. Also: `checkpoint.ts:83-84` is write-then-tag as two RPCs with no atomicity, and `load()` swallows every error into `null` (`:86-93`) so a transient read failure silently restarts from scratch.

**Fix.** Checkpoint after each tool call. Make `save()` atomic (temp file + rename). Distinguish "no checkpoint" from "read failed" in `load()`.

### 3.6 — Anthropic empty-content messages

`providers/anthropic.ts:39-44` produces `content: []` for an assistant turn with neither text nor tool calls; `:27` sends `content: ""` for empty user text. The API rejects both, and the repair path can push `{role:"assistant", text: ""}` (`agent.ts:245-247`).

### 3.7 — No provider adapter has a unit test

`packages/agents/src/providers/` contains eight implementation files and no test files; the only provider test is `fallback.test.ts`, which uses stubs. That absence is why 3.1, 3.2, and 3.6 are all live. Same on the Python side (618 lines, no tests). Add mock-server-backed tests per provider covering message mapping, tool-call round trips, empty tool lists, streaming deltas, and finish reasons.

---

## Phase 4 — Agent-loop capabilities (~2 weeks)

Not bugs — capabilities the loop doesn't have. Prioritized by how quickly a user hits them.

| # | Item | Status | Effort |
|---|------|--------|--------|
| 4.1 | No context-window management; sessions grow unboundedly | 🔴 | 3d |
| 4.2 | No cancellation (`AbortSignal`) or timeouts anywhere | 🔴 | 2d |
| 4.3 | Tool calls in one turn run sequentially | 🔴 | 1d |
| 4.4 | No `tool_choice`, temperature, top_p, or reasoning budget | 🔴 | 2d |
| 4.5 | No prompt caching; no cost tracking; usage never reaches the caller | 🔴 | 2d |
| 4.6 | Text-only — no image content parts | 🔴 | 3d |
| 4.7 | Streaming is text deltas only; `/chat` emits no tool events | 🔴 | 2d |
| 4.8 | Error taxonomy: core-loop failures are bare `Error` | 🔴 | 1d |

**4.1** — `agent.ts:172` copies and only ever appends; nothing trims or summarizes. No token budget; a provider context-length error isn't detected (`:213-221` traces and rethrows). `session.ts:14` says outright there's no trimming, and `run()` prepends every prior item (`:120-122`) then persists every tool-call and tool-result message (`:192`). A long-lived session eventually makes every subsequent `run()` fail with no recovery. Needs: a token-budget option, a trim/summarize hook before the model call, and detection of context-length errors with a trim-and-retry.

**4.2** — Zero `AbortSignal` in either package. `Tool.invoke(input)` takes no signal (`types.ts:7`); `LLMProvider.chat` takes no signal (`:39`). No per-tool timeout (`agent.ts:271` awaits unboundedly), no wall-clock deadline — only `maxTurns`. `server.ts:153-206` never listens for client disconnect, so a closed tab keeps burning tokens. `approval.ts:70-80` blocks 10 minutes uncancellably.

**4.3** — `agent.ts:261-289` awaits each call in sequence. Add a concurrency option with an opt-out for side-effecting tools.

**4.4** — Only `model` plus Anthropic's `maxTokens` are configurable; no temperature, top_p, stop, seed, or reasoning budget in any provider or in `LLMProvider`. The missing `tool_choice` is the expensive one — it's why structured output must be a prose-and-reparse loop (`structured-output.ts:28`) instead of OpenAI's `response_format: json_schema` or an Anthropic forced tool, both available in SDKs already imported. `LLMTurn` also has no field for thinking blocks, which Anthropic requires be echoed back across tool-use turns.

**4.5** — No `cache_control` anywhere; `anthropic.ts:65-75` re-sends the full system prompt and every tool schema uncached on all 25 turns. Cache and reasoning token counts are discarded (`anthropic.ts:84`, `openai.ts:107-109`, `google.ts:85-88`). `AgentRunResult` is `{text, toolCalls}` — usage never reaches the caller, so `runAgent()` can't report what a run cost.

**4.6** — `AgentMessage.text?: string` (`types.ts:12-20`) has no content-part union. Note `mcp-client.ts:77-84` deliberately preserves a non-text MCP content block "so an image block isn't silently dropped" — then `anthropic.ts:35` `JSON.stringify`s it into text anyway, defeating the intent.

**4.7** — The stream callback is `(delta: string) => void`. `openai.ts:140-155` accumulates tool-call argument fragments but never surfaces them. `/chat` emits only text parts (`server.ts:175-199`), so a `useChat` UI can't show tool activity. Two concrete defects there: every delta from every turn uses one text part id `"0"` (`:177, 191, 195, 197`) so multi-turn runs merge into one bubble, and a mid-stream failure sends `{type:"error"}` after a 200 is already written.

**4.8** — Typed errors exist only at the edges (`StructuredOutputError`, `GuardrailTripwireError`, `GovernanceDeniedError`, `HumanApprovalDeniedError`). Max-turns, missing checkpoint, and unknown tool are all bare `Error` (`agent.ts:295`, `:149`, `:153`, `:267`). No `RateLimitError`/`ContextLengthExceededError` wrapper, so `createFallbackProvider` falls through on *any* error with no retriable classification (`fallback.ts:33-45`).

---

## Phase 5 — Enterprise foundations (~4–6 weeks)

Only start this once Phases 0–2 are done; there is no point adding SSO to a system whose isolation claim doesn't hold. Each of these is a hard blocker for a regulated-environment review.

| # | Item | Status | Effort |
|---|------|--------|--------|
| 5.1 | No audit trail with a verifiable actor | 🔴 | 1w |
| 5.2 | No identity, tenancy, or RBAC anywhere | 🔴 | 2w |
| 5.3 | No TLS on anything, no option to enable it | 🔴 | 3d |
| 5.4 | Nothing encrypted at rest; conversation history plaintext 0644 | 🔴 | 1w |
| 5.5 | Secrets management: plaintext in `~/.berthrc`, `docker inspect`, snapshots | 🔴 | 1w |
| 5.6 | No health/metrics/graceful shutdown/rate limiting on any server | 🔴 | 3d |
| 5.7 | No data-schema migrations for any of the four SQLite DBs | 🔴 | 2d |
| 5.8 | SQLite: no WAL, no busy_timeout, synchronous driver blocks the event loop | 🔴 | 1d |

**5.1** — Governance denials are logged **nowhere** (`governance.ts:159-161` throws silently; the only log line is the fail-open warning at `:156`). No HTTP access logs on any server — all three Fastify instances are constructed without a `logger` (`grants-server/src/index.ts:29`, `registry-server/src/index.ts:22`, `mesh-coordinator/src/index.ts:19`). `AgentStepEvent` (`tracing.ts:4-17`) records tool *names* but never arguments or outputs, and no actor. `decided_by` on a grant is free text from the request body (`grants-server/src/routes.ts:91-92`). The `[agent-init] {...}` JSON lines are good content but aren't parseable JSON because of the prefix. No file sink, rotation, retention, or integrity chaining anywhere.

**5.2** — No user, tenant, org, or role concept exists. One shared operator secret for grants-server, per-name tokens for registry, per-peer tokens for mesh. Anyone with the operator token can approve any team's escalation and attribute it to any name. The context bus performs no identity check at all. Two teams cannot share an installation.

**5.3** — Every server is plain HTTP with no `https` option. The CLI hardcodes `http://127.0.0.1:4874` (`commands/grants/{list,approve,deny}.ts:3-4`) and sends the operator token in cleartext. `berth deploy --grants-server` requires a URL reachable from the fleet — capability approvals crossing a network over HTTP. `http-rpc.ts:49` binds `0.0.0.0` plain HTTP. `docs/mesh-reference.md:51` states the assumption repo-wide.

**5.4** — No encryption anywhere (grep for `encrypt|aes-|cipher|kms|vault` finds only MITM comments). `CheckpointedRun` persists full `messages` to `/context/agent-runs/<runId>.json` (`checkpoint.ts:5-15`) and `Session` persists conversation history to `/context/agent-sessions/<id>.json` (`session.ts:42-50`) — both 0644, both captured verbatim into snapshot tarballs. For PHI/PII this is a non-starter on its own.

**5.5** — Fleet credentials in `~/.berthrc` at default 0644 (`util/fleet.ts:9-30`); passed as `Env` on `createContainer` so permanently visible in `docker inspect` (`container.ts:237`), including `BERTH_HTTP_RPC_TOKEN` (`:201`); `berth snapshot create` copies the whole container environment to `~/.berth/snapshots/.../env.json` with no mode (`snapshot.ts:132`) despite its own comment at `:77-81` claiming secrets aren't captured; `~/.berth/os/<name>.json` holds the RPC bearer token at 0644 (`os-state.ts:58-61`). `grants-server/src/operator-token.ts:19` uses `mode: 0o600` correctly — apply that pattern everywhere, then add a real secret-store seam.

**5.6** — No `/health` on grants, registry, or mesh-coordinator. No metrics endpoint anywhere. No SIGTERM handler on any of the three (SQLite handles never closed). No rate limiting (`@fastify/rate-limit` is not a dependency). `registry-server/src/index.ts:22-23` raises the body limit to 100 MB on a route where first publish of a name needs no auth — anonymous disk-fill; downloads also `readFile` the whole blob into memory (`storage.ts:19-21`).

**5.7** — `manifest-schema/src/migrations.ts` is a proper versioned chain for `berth.yml`. All four SQLite databases use bare `CREATE TABLE IF NOT EXISTS` with no `user_version` and no migration runner (`grants-server/src/db.ts:49-60`, `registry-server/src/db.ts:98`, `mesh-coordinator/src/db.ts:~90`, `semantic-fs-daemon/internal/index/index.go:47-75`). Any future column is a manual undocumented operation.

**5.8** — `new DatabaseSync(dbPath)` with no PRAGMAs in all three servers. No WAL (readers block writers), no `busy_timeout`, and the synchronous driver blocks the Fastify event loop on every query. Also full-table reads on hot paths: `SELECT * FROM apps` then filter in JS (`registry-server/src/db.ts:189`), `SELECT * FROM peers` on every registration and poll (`mesh-coordinator/src/db.ts:221`).

---

## Phase 6 — Verification and DX (~1 week, run alongside)

| # | Item | Status | Effort |
|---|------|--------|--------|
| 6.1 | `network.ts` (415 lines, `Crew.networked`) has zero automated tests | 🔴 | 2d |
| 6.2 | `providers/auto.ts` — the quickstart's defining feature — is untested | 🔴 | 4h |
| 6.3 | CI runs one Node, one Python, one OS | 🔴 | 4h |
| 6.4 | Eleven documented features have no runnable example | 🔴 | 2d |
| 6.5 | No `berth doctor`; no Docker preflight; no troubleshooting docs | 🔴 | 1d |
| 6.6 | Pin GitHub Actions by SHA; add SBOM and license scanning | 🔴 | 1d |
| 6.7 | `berth fleet scale` drops the alias's env and region | 🔴 | 4h |
| 6.8 | `berth deploy --fleet=daytona` cannot work as written | 🔴 | 1d |
| 6.9 | `berth os up` rebuilds instead of restarting, destroying `/var/berth` | 🔴 | 1d |

**6.1** — Largest untested file in the package; both `generateAgentServerApp()` and `bootNetworkedAgent()` are public exports (`index.ts:103-112`). Its only milestone is credential-gated and not CI-wired (`crew-networked-milestone.mjs:22-25`). A headline feature with no verification of any kind. `computer.ts` (363 lines), `tools.ts`, `resolve-apps.ts`, and `build.ts` are also untested.

**6.2** — `detectLLMProvider`/`resolveLLMProvider` appear in no test file, yet `README.md:128` sells auto-detection as the quickstart's defining move ("Notice we never pass `llm`"). Precedence across six providers is unverified. Same for Python's `providers/auto.py`.

**6.3** — Every workflow pins `node-version: 22` and `runs-on: ubuntu-latest`; `build-lint-test.yml:38` pins Python 3.11 while `pyproject.toml` claims 3.11/3.12/3.13. No macOS runner, despite docs referencing Docker Desktop for Mac throughout — which is exactly how 0.1 went unnoticed.

**6.4** — Guardrails, checkpointing, sessions, retrieval, MCP client, structured output, evals, tracing, A2A, declarative YAML, and four of the seven Crew shapes all have full doc sections and no runnable example. Also: examples live in two roots (`examples/agents/` and `packages/agents/examples/`) and `README.md:406-408` documents only the first, so a reader following the README's own map never finds the crew examples.

**6.5** — `Computer.boot()` constructs `new Docker()` bare (`computer.ts:164`); no `docker.ping()` anywhere. With Docker stopped, a first run fails with a raw dockerode socket error. There is no `doctor`/`preflight` command among the 17. `README.md:411` — the section titled "Something not working?" contains three issue-template links and no troubleshooting. Zero Windows/WSL guidance anywhere. Build time is never stated, so a first-timer can't distinguish a slow cold build from a hang.

**6.6** — No action is SHA-pinned; all use floating tags, and `pypa/gh-action-pypi-publish@release/v1` is a mutable *branch* ref on the workflow holding `id-token: write`. `.github/dependabot.yml:52-56` claims actions are "pinned for supply-chain safety" — pinned to tags, not digests. No SBOM, no CI license scan, no digest-pinned base images (`base.Dockerfile:16, 27, 39, 46, 58, 62`), unpinned `apk`/`pip` installs (`:64-107`, including `rm -f /usr/lib/python3*/EXTERNALLY-MANAGED`), and `image.ts:92-96` falls back to `npm install` rather than `ci`. No Cargo.toml declares a `license` field. Two dependency risks worth tracking: `@xenova/transformers@2.17.2` (superseded, single-maintainer, critical path for Semantic FS) and a workspace-wide `onnxruntime-web@1.14.0` override.

*Credit where due — this area is already strong:* CodeQL across four languages, gitleaks over full history, `pnpm audit` gating every PR, Dependabot across five ecosystems, OIDC trusted publishing, dry-run-by-default release workflows, clean license posture with no copyleft in the npm tree.

**6.7** — `commands/fleet/scale.ts:41` destructures only the adapter and builds `{imageRef, manifest}` at `:67` — no `env`, no `region`, unlike `deploy.ts:69-81`. Scaled instances get neither your API keys nor the right region, with no warning.

**6.8** — `adapter-daytona/src/index.ts:108-112`'s own comment admits `target.imageRef` is a local Docker tag that Daytona's `image` param cannot resolve, and there is no registry-push step anywhere in the deploy path.

**6.9** — `commands/os/up.ts:91` calls `removeStaleContainer` (`container.remove({force:true})`) and rebuilds from scratch rather than restarting. That destroys `/var/berth` — the entire semantic FS and its index, so every checkpoint, session, and trace — plus the `on_install` marker and the mesh owner token (which makes re-registration 401 permanently). No `RestartPolicy` or `Healthcheck` exists anywhere in the repo (zero grep hits). Also `up.ts:105-114` passes no `installMarkerVolume`, unlike `dev.ts:67`, so the long-lived OS re-runs every `on_install` on every start.

---

## Suggested sequencing

1. **Week 1** — Phase 0 (both items), then 1.1, 1.2, 1.12, and 2.2. Small, high-signal; ends with a Mac-runnable framework and a README that doesn't overclaim.
2. **Weeks 2–4** — the rest of Phase 1, with 2.1 (threat model) written *first* so it drives the design decisions in 1.4 and 1.5. Per-app uids are the shared unlock for 1.4, 1.11, and 1.14's identity half — that design is now written down once, in [docs/per-app-uid-design.md](./docs/per-app-uid-design.md), and it reorders this list: **1.5 comes before 1.4**. It also argues *against* using the uid split to drop Chromium's `--no-sandbox` (1.7), since Chromium's own sandbox needs the `CLONE_NEWUSER` that 1.3 deliberately refuses — so 1.7 gains nothing here after all.
3. **Week 5** — Phase 3, plus 6.1/6.2/6.3 so the fixes are actually verified.
4. **Weeks 6–7** — Phase 4, prioritizing 4.1 and 4.2 (the two most likely to bite a real user).
5. **Ongoing** — Phase 6 items alongside everything else.
6. **Only then** — Phase 5, and only if enterprise adoption is the actual goal.

A note on process: `gaps.md`'s current bar for "closed" is that a module exists and its own unit test passes. Two items above — 3.3 (`Crew.parallel` sharing a `runId`) and 3.4 (a denial being swallowed by the tool-error handler) — are cases where two independently "closed" features break each other. Consider requiring that a closure name the other features it interacts with, and test at least one such interaction.
