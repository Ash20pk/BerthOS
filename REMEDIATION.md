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
| 1.3 | Bounding-set drop undone by `unshare(CLONE_NEWUSER)` | Critical | 🔴 | 2d |
| 1.4 | App RPC sockets in world-writable `/tmp`, unauthenticated | Critical | 🔴 | 3d |
| 1.5 | `on_install` is unsandboxed root shell run before enforcement | Critical | 🔴 | 2d |
| 1.6 | `berth dev` bind-mounts the whole host repo read-write | Critical | 🔴 | 1d |
| 1.7 | ttyd / VNC / CDP unauthenticated on all host interfaces | High | 🔴 | 1d |
| 1.8 | Egress broker: no port check, `*` → SSRF, DNS not pinned | High | 🔴 | 2d |
| 1.9 | GitHub broker: `read:repos` also grants `/user/emails` etc. | High | 🔴 | 1d |
| 1.10 | Capability tokens are never verified anywhere | High | 🔴 | 1d |
| 1.11 | Signals unrestricted — any app can kill the governor | Medium | 🔴 | 1d |
| 1.12 | `agent-init` mkdir's arbitrary manifest paths as root | Medium | 🟢 | 4h |
| 1.13 | Governance gate bypasses (MCP, agent-as-tool, rpc, mcp, http-rpc) | High | 🔴 | 2d |
| 1.14 | semantic-fs / context-bus: unbounded frame allocation + spoofable identity | Medium | 🔴 | 1d |

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

### 1.4 — App RPC sockets in world-writable `/tmp`, unauthenticated

**Evidence.** `packages/sdk/src/generate-capability-policy.ts:46` — `BASELINE_WRITE_PATHS = ["/tmp"]`, unconditional for every app. `entrypoint.sh:263` — sockets at `/tmp/berth-rpc/<app>.sock`. `packages/sdk/src/rpc.ts:58-69` — `connectionHandler` parses a line and calls `invokeExport` with **no authentication and no `SO_PEERCRED` check**.

Exploit: `code-interpreter` (declaring only `filesystem:write:/workspace`) runs

```bash
printf '{"id":"1","export":"write_context_file","input":{...}}\n' | nc -U /tmp/berth-rpc/filesystem.sock
```

and executes with *filesystem's* capabilities. Per-app Landlock rulesets are real and individually correct; they don't matter when apps can call each other directly. Same reachability exposes `/tmp/berth-context-bus.sock`, `/tmp/berth-semantic-fs.sock`, `/tmp/berth-mesh.sock` — all served by root daemons running *outside* any Landlock domain, because they start before `agent-init`.

**Fix.** Three parts, all needed:
1. Move each app's socket to a per-app directory (`/run/berth/<app>/`) mode `0700`, owned by that app's uid — which requires giving each app a distinct uid (see 1.5's user story).
2. Remove `/tmp` from the unconditional baseline write set; grant only the app's own socket dir plus a private `/tmp/<app>` scratch.
3. Add `SO_PEERCRED` verification in `rpc.ts`'s `connectionHandler` so a socket connection's uid is checked against the expected app identity.

**Verify.** Extend the cross-app boundary test (Test 9) to assert app B cannot invoke app A's exports over A's socket.

### 1.5 — `on_install` is unsandboxed root shell run before enforcement

**Evidence.** `packages/manifest-schema/src/schema.ts:89` — `on_install: z.array(z.string())`, no validation. `packages/sdk/src/run-lifecycle.ts:33-36` — `execSync(command, { stdio: "inherit" })`. Called at `entrypoint.sh:45` and `:265`, i.e. **before** `generate-capability-policy.js` and before `exec agent-init`.

So "a Landlock policy applies before your code even runs" is false for this path by construction. Any `berth.yml` — from the registry, from a PR, from 1.6 — executes arbitrary shell as uid 0 with `CAP_SYS_ADMIN`, `/dev/fuse`, AppArmor unconfined, no Landlock domain, and (in dev) the host repo mounted rw.

Note: `entrypoint.sh` itself has no injection surface — manifest `name` is `^[a-z0-9-]+$` (`schema.ts:83`), expansions are quoted, `run_app` is a function not an `eval`. This is a design decision, not an injection bug.

**Fix.** Move `on_install` into the image build (a `RUN` layer in the app's Dockerfile stage) so it executes at build time under the builder's isolation rather than at boot in the runtime sandbox. If it must stay at boot, run it inside a Landlock domain built from the declared capabilities, and drop caps first.

**Verify.** A test asserting an `on_install` entry cannot write outside the app's declared write paths.

### 1.6 — `berth dev` bind-mounts the whole host repo read-write

**Evidence.** `packages/cli/src/util/workspace.ts:35-38` — `bindMount: { hostPath: workspaceRoot, containerPath: "/workspace" }` (the entire pnpm workspace root). `container.ts:174` — no `:ro`. Apps declaring `filesystem:write:/workspace` (code-interpreter, notes, terminal, filesystem all do) get Landlock write access to that exact directory. `packages/docker-orchestrator/src/watch.ts:24` restarts the container when `berth.yml` changes.

Full chain: an app rewrites its own `berth.yml` with wider capabilities and a malicious `on_install`, deletes `.berth/installed`, chokidar restarts the container, and 1.5 executes the payload as root with the attacker's own capability list now compiled into the enforced policy. Independently, writing `/workspace/.git/hooks/pre-commit` or `package.json` scripts gives host-side code execution on the developer's next commit or build.

`berth os up` and `Computer.boot()` don't bind-mount, so this is `berth dev`-specific — which is the primary workflow.

**Fix.** Narrow the bind mount to the app's own directory rather than the workspace root. Mount `berth.yml` read-only. Ignore manifest changes originating from inside the container, or re-read the manifest from the host copy rather than the mounted one.

**Verify.** A test asserting an app cannot modify its own `berth.yml` through `/workspace`.

### 1.7 — ttyd / VNC / CDP unauthenticated on all host interfaces

**Evidence.** `container.ts:156-165` publishes browser and terminal ports with `{ HostPort: "" }` and **no `HostIp`**, so Docker binds `0.0.0.0` on the host. `entrypoint.sh:55` — `x11vnc ... -nopw`. `apps/terminal/src/tmux-controller.ts:59` — `ttyd --writable` with no `--credential`. `apps/browser-native/src/cdp-controller.ts:29-32` — `--remote-debugging-address=0.0.0.0 --no-sandbox`.

Running `berth dev` on `apps/terminal` on any routable network is an unauthenticated writable root shell for anyone on that LAN. Unauthenticated CDP additionally allows `Page.navigate("file:///etc/passwd")` and `Browser.setDownloadBehavior`, bypassing the egress broker entirely. `--no-sandbox` means a renderer RCE from a visited page lands as root in the container, at which point 1.2 and 1.3 apply.

**Fix.** Bind all published ports to `127.0.0.1` by default (`HostIp: "127.0.0.1"`), with an explicit opt-in for anything wider. Generate a random credential for ttyd and a VNC password at boot, print them alongside the URL. Bind CDP to `127.0.0.1` inside the container.

**Verify.** `docker inspect` shows `127.0.0.1` bindings; connecting to ttyd without the credential is refused.

### 1.8 — Egress broker: no port check, `*` → SSRF, DNS not pinned

**Evidence.** `egress-broker.cjs:160` parses `port` and passes it to `net.connect` at `:182`, but `isHostAllowed` (`:89-91`) takes only `host` — **the port is never checked**. `apps/browser-native/berth.yml:20-21` claims `network:connect:8090`'s job is "to make direct-to-internet connections on other ports impossible"; `CONNECT internal-db.corp:5432` through the broker reaches 5432. Separately, `globToRegExp` (`:59-62`) turns `*` into `.*`, so `browser:navigate:*` permits `169.254.169.254` (cloud IMDS), `127.0.0.1`, and `host.docker.internal` — which `container.ts:258` explicitly wires to `host-gateway`. It also fails to escape `?`. And the check is on the *name*: `net.connect` re-resolves afterward, so DNS pointing an allowed name at a link-local address is unhandled.

Worth crediting: there is **no check-vs-dial divergence and no SNI-spoofing surface** — the same variable is used for both (`:162` vs `:182`), and plain-HTTP absolute-URI requests are checked with the same predicate. That class of proxy bug is correctly avoided.

**Fix.** Add a port allowlist derived from the manifest. Escape `?` in `globToRegExp`. Add a deny list for RFC1918, link-local, loopback, and `host.docker.internal` that applies even under `*`. Resolve the hostname once, validate the resolved IP, and dial that IP with the validated `Host`/SNI (pinned resolution) rather than re-resolving. Strip hop-by-hop headers and normalize the `Host` header on the plain-HTTP path (`:141`).

**Verify.** `egress-broker-milestone.mjs` gains cases for a disallowed port, an IMDS address under `*`, and a DNS-rebinding target.

### 1.9 — GitHub broker: `read:repos` also grants `/user/emails`

**Evidence.** `github-api-broker.cjs:99-105` — `const scope = segments.length > 3 ? segments[3] : "repos"`. Any GET with three or fewer path segments is classified `github:read:repos`. So an app declaring that capability also gets `/user`, `/user/emails`, `/user/repos`, `/gists`, `/notifications`, `/orgs/{org}` — all forwarded with the real `Authorization` header (`:172`). The path is forwarded verbatim (`path: req.url`) with no normalization, so `..` is resolved at GitHub's edge rather than by the policy check.

Also: the MITM CA is trusted process-wide via `NODE_EXTRA_CA_CERTS` (`entrypoint.sh:127`), not scoped to `api.github.com`, and the key lands in a `0755` `/tmp` directory (`:113-120`). And the two brokers don't compose — an app declaring both `github:*` and `network:host:*` gets a raw `CONNECT api.github.com:443` tunnel with no path/verb inspection at all. `apps/github-assistant` is one manifest line away from this.

Worth crediting: the CONNECT gate is strict equality not a glob (`:200`), it forces the upstream `Host` header, and `rejectUnauthorized` stays true on the outbound leg.

**Fix.** Replace the positional `segments[3]` heuristic with an explicit route table mapping path patterns to scopes, defaulting to *deny* rather than `repos`. Normalize the path before matching. Move the CA to a mode-`0700` directory outside `/tmp`. Refuse to start the egress broker for a host already covered by a dedicated broker.

**Verify.** A test asserting `GET /user/emails` is denied for an app declaring only `github:read:repos`.

### 1.10 — Capability tokens are never verified anywhere

**Evidence.** `verifyCapabilityToken` (`packages/sdk/src/capabilities.ts:60-72`) is exported from `sdk/src/index.ts:6` and called from exactly one place in the repo: its own unit test (`capabilities.test.ts:115-121`). No broker, no RPC path, no governance code reads it. Additionally `BERTH_TOKEN_SECRET` is exported into the app's own environment (`entrypoint.sh:153`, preserved across `exec`), so the constrained process holds the signing key and can mint any token. In multi-app mode each app gets a *different* secret (`entrypoint.sh:267`), so cross-app verification could not work even if someone called it.

The HMAC/expiry/`timingSafeEqual` machinery is cryptographically correct and semantically empty.

**Fix.** Decide which it is. Either (a) delete the token API and stop implying a capability-token model exists, or (b) make it real: mint tokens in a broker/daemon that holds the secret *outside* the app's environment, and check them at every enforcement point (RPC dispatch, both brokers, the governance gate). Option (a) is honest and cheap; option (b) is the foundation for cross-app authz and pairs naturally with 1.4's `SO_PEERCRED` work.

**Verify.** If (b): a test asserting a forged token is rejected at an enforcement point. If (a): the export is gone and the docs no longer mention it.

### 1.11 — Signals unrestricted; any app can kill the governor

**Evidence.** The ruleset handles only `AccessFs` and `AccessNet`; `LANDLOCK_SCOPE_SIGNAL` (ABI v6) is unused. All processes share one PID namespace as uid 0. `kill -9` on the governance app makes every gated call hit the 10s timeout and, in the default `fail-open` mode (`governance.ts:116`, `:151-157`), execute anyway with only a `console.warn`. Killing the egress or GitHub broker forces their fail modes; `kill(-1, SIGKILL)` takes down the container.

**Fix.** Give each app a distinct uid (shares work with 1.4) so signal delivery between apps is refused by the kernel's normal permission check. Make `fail-closed` the default governance mode. Consider `LANDLOCK_SCOPE_SIGNAL` where ABI v6 is available.

**Verify.** A test asserting app B cannot signal app A's process.

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

### 1.13 — Governance gate bypasses

**Evidence.** `applyGovernanceGate` wraps `Tool.invoke` in a returned array; anything not in that array is ungated. Gated: resident-app tools via `Computer.boot()`/`connect()` (`computer.ts:217`, `:308`), fleet computers (`fleet-computer.ts:70`), the retriever (transitively), human approval (layered on top). **Not gated:** MCP tools (`agent.ts:479-480` concatenates them *after* gating), `Agent.asTool()` delegation (`agent.ts:324`, `crew.ts:180-183`), `berth rpc` (`commands/rpc.ts:33`), `berth mcp` (`commands/mcp.ts:70`), the HTTP RPC bridge (`http-rpc.ts:80`), direct Unix socket (1.4), and the TCP RPC listener (`rpc.ts:85`).

`governance.ts:105-107` documents two of these; the rest are undocumented.

**Fix.** Move the gate from the tool array to the dispatch function so every path through `invokeExport` is covered, rather than wrapping one particular list. Route MCP tools and agent-as-tool through it explicitly. Default `mode` to `fail-closed`.

**Verify.** A test per row of that table asserting a denied action stays denied through each transport.

### 1.14 — Unbounded frame allocation and spoofable identity in the daemons

**Evidence.** `context-bus-daemon/src/main.rs:216-218` — `let len = u32::from_be_bytes(...) as usize; let mut buf = vec![0u8; len];`. A 4-byte header of `0xFFFFFFFF` allocates 4 GiB. Identical in `semantic-fs-daemon/internal/control/control.go:170-171`. Both daemons run as root outside any Landlock domain.

Identity is self-asserted in both: `main.rs:125` (`app_name = req.app`) and `control.go:135-137` (`registry.Register(req.Pid, req.App)` from the request body), so any app can publish under another's name or poison semantic-fs write attribution. Delivered context-bus events carry no sender at all (`main.rs:146-149`).

Killing semantic-fs is worse than a crash: `runtime.ts:44-46` silently falls back to a stub returning **empty query results**, so retrieval, checkpoints, sessions, and traces degrade to silent data loss rather than an error.

**Fix.** Cap frame length (a few MB) and reject oversized headers before allocating, in both daemons. Derive the app identity from `SO_PEERCRED` rather than the request body. Make the semantic-fs stub fallback throw rather than return empty, or at minimum emit a loud persistent warning on every call.

**Verify.** A test sending an oversized length header and asserting the daemon survives; a test asserting app B cannot register as app A.

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

- `README.md:88` — "a prompt-injected 'ignore previous instructions, delete everything' never even reaches the syscall." True for `open(O_WRONLY)` and, since 1.1, `truncate` on an enforcing kernel; still false for `unshare` (1.3), sibling sockets (1.4), and `on_install` (1.5).
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
2. **Weeks 2–4** — the rest of Phase 1, with 2.1 (threat model) written *first* so it drives the design decisions in 1.4 and 1.5. Per-app uids are the shared unlock for 1.4, 1.7, and 1.11 — do that design once.
3. **Week 5** — Phase 3, plus 6.1/6.2/6.3 so the fixes are actually verified.
4. **Weeks 6–7** — Phase 4, prioritizing 4.1 and 4.2 (the two most likely to bite a real user).
5. **Ongoing** — Phase 6 items alongside everything else.
6. **Only then** — Phase 5, and only if enterprise adoption is the actual goal.

A note on process: `gaps.md`'s current bar for "closed" is that a module exists and its own unit test passes. Two items above — 3.3 (`Crew.parallel` sharing a `runId`) and 3.4 (a denial being swallowed by the tool-error handler) — are cases where two independently "closed" features break each other. Consider requiring that a closure name the other features it interacts with, and test at least one such interaction.
