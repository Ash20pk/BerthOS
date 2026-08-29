# Claims inventory

Every enforcement claim Berth makes, tagged by the tier that enforces it, with
the test that proves the *denial* — or `UNPROVEN` where nothing does. BUILD_PLAN
M2.4 / LAUNCH_PLAN WS4.1.

This file is the backbone of the audit pack: it is where a reviewer starts, and
where a claim with no test behind it has nowhere to hide. It is kept honest two
ways — `redteam/claims-linter.mjs` fails CI if any row below cites a test that
no longer exists, and the tier is the same vocabulary [threat-model.md](../threat-model.md)
uses, so the two cannot drift without one of them being obviously wrong.

## The tiers, and what a tag promises

| Tier | What enforces the claim | What a bypass would mean |
|---|---|---|
| **kernel** | Landlock, seccomp, the capability bounding-set drop, or the per-app uid split — the kernel refuses the action | a vulnerability: a Kernel-tier bypass is the most serious thing you can report |
| **broker** | a Berth process on the path (egress/GitHub broker, the governance gate, the grants server) refuses or rewrites the request | a vulnerability, subject to the broker actually being in the path |
| **recorded** | nothing is prevented; the action is *detected* and written to a tamper-evident record after the fact | not a boundary, and never claimed as one — the value is evidence, not prevention |
| **unenforced** | documented as out of scope; no mechanism stands here | expected — but a *worse-than-documented* version is still worth reporting |

Reading a row: **DENIAL test** is the milestone (or unit test) that asserts the
attack fails. **Control** says how that test proves it is not vacuous — a
negative control (the same action succeeding when the mechanism is removed) or
a positive control (a legitimate version of the action succeeding).

## Kernel-tier claims

| Claim | Tier | Denial test (file — key assertion) | Control |
|---|---|---|---|
| K1. Undeclared write/create/delete/rename/**truncate** dies `EACCES` in the kernel | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 2 write-traversal denied; Test 10 truncate denied | positive: in-scope write/truncate succeed (Tests 1, 10); degrades to informational only where Landlock is inactive (hard-fails under CI) |
| K2. Read scoping is opt-in once any `filesystem:read:` is declared | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 4 out-of-scope read denied | positive: Test 3 in-scope read |
| K3. A symlink planted inside a granted dir cannot redirect a write/read outside it | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 6/7 symlink write/read denied; also `breakout/test/breakout-milestone.mjs` assertion 3 | negative: `breakout` weakened boot leaks the flag through the symlink |
| K4. Enforcement holds under concurrency (no TOCTOU window) | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 7, 20 concurrent out-of-scope writes all denied | positive: 20 concurrent in-scope writes all succeed |
| K5. Outbound TCP is deny-by-default without `network:connect` (Landlock `AccessNet`) | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 5 connect denied; `redteam/redteam.mjs` egress row | negative: `redteam` mutation flips it to CONNECTED with the kernel tier off |
| K6. UDP/ICMP/raw sockets are refused for an app with no network capability | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 5b/5c, `sent===false`/`opened===false` + EPERM | **asserted unconditionally** — seccomp works even on non-Landlock kernels |
| K7. `unshare`/`clone(CLONE_NEW*)` is refused for every app | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 11, `created===false` + EPERM | **asserted unconditionally** |
| K8. The capability bounding set (`CAP_SYS_ADMIN`/`NET_ADMIN`/`NET_RAW`) is dropped | kernel | effect proven transitively by K6/K7; the `capabilities_dropped` audit event itself is `UNPROVEN` (no milestone asserts the event) | — |
| K9. `BERTH_REQUIRE_ENFORCEMENT=1` refuses to boot unrestricted | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 8, refusal + non-zero exit on a non-enforcing host | positive: the enforcing branch boots and runs |
| K10. One app's filesystem grant does not reach a sibling's directory | kernel | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 9 cross write/read denied | positive: boundary-app-b seeds its own file; degrades where Landlock inactive |
| K11. A sibling's RPC socket is reachable only via a declared `app:invoke:<name>` | kernel + DAC | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 9 sibling socket connect refused (EACCES) | **unconditional (DAC)**; positive: own socket connects, app-C with the grant connects |
| K12. No socket at the pre-1.4 world-writable path; grants are not transitive; no peer-channel impersonation; the root relay socket is unreachable by an app | kernel + DAC | `packages/docker-orchestrator/test/capability-enforcement.mjs` — the :636/:666/:687/:697 assertions | positive controls throughout |
| K13. An app cannot `kill(2)`/SIGKILL a sibling | kernel + DAC | `packages/docker-orchestrator/test/capability-enforcement.mjs` — Test 12 cross-signal/kill EPERM, sibling survives | **negative**: root via `docker exec` CAN signal; positive: self-signal works |
| K14. Daemon caller identity comes from `SO_PEERCRED`, not the request body | kernel + DAC | `packages/docker-orchestrator/test/capability-enforcement.mjs` — context-bus/semantic-fs identity-spoof refused (:770/:785) | positive: the daemon still registers the caller under the kernel's uid |
| K15. The daemons survive a 4 GiB length-header frame (bounded allocation) | kernel (robustness) | `packages/docker-orchestrator/test/capability-enforcement.mjs` — oversized-frame survival, ≥2 later registrations | the oversized frame *is* the mutation; no separate control |
| K16. `CAP_SYS_ADMIN` is gone from the sandbox; `mount(2)` fails EPERM even as root; no `/dev/fuse` | kernel | `packages/docker-orchestrator/test/sys-admin-drop-milestone.mjs` — mount(2) fails as root | **negative**: `BERTH_DISABLE_FS_SIDECAR=1` legacy boot has the cap back and the mount succeeds |
| K17. The pre-agent-init daemons are themselves confined (own uid/Landlock/seccomp/cap-drop) | kernel | `packages/docker-orchestrator/test/daemon-confinement-milestone.mjs` — out-of-domain write + undeclared TCP refused | **negative**: `BERTH_DISABLE_DAEMON_CONFINEMENT=1` boot lets the same actions succeed |
| K18. A sibling cannot read another app's per-app secret file (env, `/proc/<pid>/environ`, or DAC) | kernel + DAC | `packages/docker-orchestrator/test/per-app-secrets-milestone.mjs` — B blocked by env/proc/file DAC | **negative**: a no-`secrets:`-declaration control boot shows the token reaching both apps; positive: A reads its own file |
| K19. Each app in a multi-app boot is its own independently-enforced agent-init process | kernel | `packages/docker-orchestrator/test/multi-app-milestone.mjs` — both processes log their own ruleset | implicit contrast with a `docker exec` passenger |
| K20. `terminal:attach` pty access is Landlock-gated | kernel | `packages/docker-orchestrator/test/published-port-security-milestone.mjs` (+ agent-init Rust unit tests) — presence of the gate | **weak**: no milestone asserts pty allocation is refused *without* the grant — see gaps below |
| K21. A Chromium renderer exploit lands with the app's own uid; its namespace sandbox `clone(NEWUSER)` is refused | kernel | covered transitively by K7 | **weak**: no browser-specific test — see gaps below |

## Broker-tier claims

| Claim | Tier | Denial test (file — key assertion) | Control |
|---|---|---|---|
| B1. The egress broker refuses an out-of-scope host (403) and allows an in-scope one | broker | `packages/docker-orchestrator/test/egress-broker-milestone.mjs` — Part A allow 200 / deny 403 | positive: allowed host 200 |
| B2. `*` scope still refuses loopback/RFC1918/link-local/IMDS/`host.docker.internal`; DNS is pinned (no rebinding) | broker | `packages/docker-orchestrator/test/egress-broker-milestone.mjs` — Part A3 IMDS/internal/DNS-rebind all 403 | positive: a real public host returns 200 |
| B3. Upstream proxy chaining forwards an allowed CONNECT but never forwards a denied host | broker | `packages/docker-orchestrator/test/egress-broker-milestone.mjs` — Part A2 | positive + negative pair |
| B4. A host owned by a dedicated broker is refused by the egress broker (brokers compose) | broker | `packages/docker-orchestrator/test/egress-broker-milestone.mjs` — Part A4, logs `dedicated_broker_host` | positive: unrelated host 200; a no-dedicated-broker boot allows it |
| B5. Real Chromium and http-fetch traffic is actually routed through the broker | broker | `packages/docker-orchestrator/test/egress-broker-milestone.mjs` — Parts B, C | positive: navigation succeeds |
| B6. The GitHub broker denies by default; `github:read:repos` no longer carries `/user`, `/gists`, `/orgs`, … | broker | `packages/docker-orchestrator/test/github-assistant-milestone.mjs` — those paths 403 | positive: a declared repo read is forwarded 200 |
| B7. `..` is normalized before the scope check; an unrouted path is denied and logged | broker | `packages/docker-orchestrator/test/github-assistant-milestone.mjs` — unrouted 403 + logged | positive: declared read 200 |
| B8. Verb→scope mapping (GET/HEAD read, else write) over a real TLS-terminating decrypt-and-forward | broker | `packages/docker-orchestrator/test/github-assistant-milestone.mjs` — Test 3 forwarded / Test 4 out-of-scope 403 | positive Test 3 / negative Test 4 |
| B9. A `governs:true` app gates every other app's tool calls and denies per policy | broker | `packages/agents/test/governance-gate-milestone.mjs` — GovernanceDeniedError + reason | positive: an allowed call succeeds |
| B10. The `berth rpc` relay transport is gated | broker | `packages/agents/test/governance-gate-milestone.mjs` — relay denied | positive: an allowed export runs on the relay |
| B11. The HTTP RPC bridge transport is gated | broker | `packages/agents/test/governance-gate-milestone.mjs` — http denied; disk-check control | positive: an allowed export runs |
| B12. The SDK-side gate takes caller identity from the listener, not the request; fail-closed | broker | `packages/sdk/src/governance-gate.test.ts` (unit) | unit test — not a milestone |
| B13. `evaluate_action` error/timeout throws rather than allowing (fail-closed default) | broker | `packages/agents/src/governance.test.ts` (unit) | unit test |
| B14. An MCP tool-call denial returns an explained refusal (`denied-by:`), not a bare errno | broker | `packages/docker-orchestrator/test/mcp-milestone.mjs` — Test 3 CAPABILITY DENIAL; cross-app write via MCP denied | positive: an allowed call and a write-back read |
| B15. A grant requester cannot self-approve without the operator token (401) | broker | `packages/docker-orchestrator/test/grants-server-milestone.mjs` — token-less approve 401 | positive: a token'd approve succeeds and lands in policy |

## Host-tier claims (port publishing, secret delivery)

| Claim | Tier | Denial test (file — key assertion) | Control |
|---|---|---|---|
| H1. Published ports bind `127.0.0.1`, never `0.0.0.0`; no CDP (9222) port is published | broker | `packages/docker-orchestrator/test/published-port-security-milestone.mjs` — Test 1/2, VNC/noVNC loopback Test 7 | re-running with `BERTH_PUBLISH_HOST=0.0.0.0` reproduces the old binding and fails Test 1 |
| H2. ttyd requires a per-boot credential; unauth 401, wrong credential refused | broker | `packages/docker-orchestrator/test/published-port-security-milestone.mjs` — Tests 4/5 refused | positive: Test 6 correct credential passes |
| H3. The per-boot credential is absent from `docker inspect` | broker | `packages/docker-orchestrator/test/published-port-security-milestone.mjs` — Test 3 | — |
| H4. Credentials are delivered via a 0600 bind file, not Docker `Env`; absent from `docker inspect`/`exec` | broker | `packages/docker-orchestrator/test/secrets-milestone.mjs` — Test 1 (not in inspect), Test 4 (not via exec) | positive: Test 3, the token still reaches the app |
| H5. A snapshot carries no credential values (`env.json` lists redacted names only) | broker + recorded | `packages/docker-orchestrator/test/secrets-milestone.mjs` — Test 5, snapshot tarball has no credentials | positive: Test 3 token reaches app |

## Recorded-tier claims (detect, do not prevent)

| Claim | Tier | Test (file — key assertion) | Control |
|---|---|---|---|
| R1. `berth attest <runId>` derives `enforcement.status` from measurements — `NOT_ENFORCED` on a non-enforcing host, never a silent pass | recorded | `packages/docker-orchestrator/test/attestation-milestone.mjs` — measured status equals independent measurement | **negative**: the verifier rejects a hand-edited record and a forged verdict |
| R2. The attestation is tamper-**evident**, not tamper-proof; unsigned; trusts the host at emission | recorded (documented limit) | present-and-required `trustModel` field, asserted by `packages/audit/src/attest.test.ts` | — |
| R3. Every allow/deny/could-not-reach lands in a hash-chained, actor-attributed audit trail | recorded | `packages/audit/src/sink.test.ts` (unit) | unit test |
| R4. The containment benchmark compares Docker/Berth/weakened-Berth; unmeasured rows never score as a pass | recorded | `bench/run.mjs`, `bench/checks.mjs` — the runner exits non-zero unless the weakened config scores worse | the weakened-Berth column is the negative control |
| R5. The red-team suite proves each kernel-tier denial is falsifiable (flips when the mechanism is removed) | recorded | `redteam/redteam.mjs` — each attack DENIED shipped, ALLOWED mutated | the mutation boot is the control, per row |
| R6. `browser:screenshot:*` and any unimplemented namespace are recorded-only, not a control | recorded | `UNPROVEN` by definition — there is nothing to deny | n/a |
| R7. Berth's published enforcement-tier table matches the spec's vocabulary, and the manifest grammar it implements is the one written down | recorded | `spec/capability-manifest/conformance/run.mjs` — 87/87 against `spec/capability-manifest/conformance/adapters/berth.mjs`, which publishes the tier table | **negative**: `spec/capability-manifest/conformance/adapters/broken.mjs` must fail the same suite (`spec/capability-manifest/conformance/selftest.mjs`). Limit: a tier *claim* is not externally checkable — this row proves the table exists, is well-formed, and agrees with itself, not that a row is true; that is what every other row in this file is for |

## Unenforced — documented, not a boundary

These have no mechanism and no denial test on purpose. They are here so the
inventory is complete and so a reviewer can tell "we chose not to" from "we
missed it." Each is expanded in [threat-model.md](../threat-model.md) §"Not
protected against".

| Claim / non-claim | Tier | Where it is documented |
|---|---|---|
| U1. `docker exec` bypasses the sandbox — root on the host reaches everything | unenforced | threat-model.md:113; used as the *negative control* in capability-enforcement Test 12 and red in `bench` — proven as a bypass, not a boundary |
| U2. The mesh daemon retains uid 0 + `CAP_NET_ADMIN` behind a control socket that trusts self-declared identity (largest in-container escalation path, *1.14*) | unenforced | threat-model.md:127 |
| U3. No per-syscall denial audit logging (Landlock has no deny hook) | unenforced | threat-model.md:108 |
| U4. One egress broker per container, not per app; GitHub broker unshared across multi-app | unenforced | threat-model.md:111–112 |
| U5. Human-approval-swallowed-by-tool-error-handler (*3.4*) is a named open defect | unenforced | threat-model.md:47 |
| U6. K8s adapter needs `SYS_ADMIN` + `/dev/fuse` hostPath; not the confined posture | unenforced | threat-model.md:115 |
| U7. Enterprise ops: no identity/RBAC (*5.2*), nothing encrypted at rest (*5.4*), no rate-limit/`/health` (*5.6*), no migration runner (*5.7*), unauth first-publish registry | unenforced | threat-model.md:101 |
| U8. Operator→servers is plain HTTP with shared bearer tokens; TLS built but off by default | unenforced | threat-model.md:55 (B9) |
| U9. Secrets are not a vault: no protection against the docker-socket holder, undeclared secrets stay shared, root daemons, remote-fleet env in a provider control plane | unenforced | secrets-reference.md §"what this does not protect against" |

## UNPROVEN and weakly-proven — the work list

The rows worth attacking, because a claim without a test is a claim on trust.
These are the targets a red-team milestone (WS4.2) should convert into a
denial test with a control.

1. **Governance gate on the TCP cross-container listener** — claimed gated
   (*1.13*), but only `packages/sdk/src/governance-gate.test.ts` (unit) covers
   it; no milestone asserts a TCP-listener denial. **UNPROVEN at milestone
   tier.**
2. **Governance verdict over a sibling peer socket** — the caller *identity* is
   proven (capability-enforcement K14) but the *deny over that channel* is
   unit-test-only. **Weak.**
3. **`terminal:attach` without the grant** (K20) — pty gating is tested for
   presence; no milestone asserts pty allocation is refused when the capability
   is absent. **Weak (negative direction).**
4. **Chromium renderer sandbox** (K21) — only transitively covered by K7; no
   browser-specific breakout. **Weak.**
5. **The `capabilities_dropped` audit event** (K8) — the drop's effect is
   proven; the event itself is asserted by no milestone. **Minor.**
6. **Daemon length-header bounded allocation** (K15) — survival is asserted; the
   fix has no mutation control beyond the oversized frame itself. **Minor.**
7. **Human-approval-swallowed-by-tool-error** (*3.4*, U5) — a documented open
   defect, not a fixed boundary. **UNPROVEN as closed, on purpose.**

Anything marked UNPROVEN here is fair game for the break-out box and for
external reviewers — that is what the inventory is for.
