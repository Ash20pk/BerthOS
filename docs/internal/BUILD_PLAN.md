# Build plan — from what exists to best-in-category

> **Which document is authoritative for what.** `STRATEGY.md` — the category
> and the five axes this plan builds toward. `LAUNCH_PLAN.md` — the original
> launch on-ramp (WS0–WS4); its unfinished rows are absorbed into M0/M3 below
> so there is exactly one list of what to do next. `REMEDIATION.md` — defects;
> nothing here overrides a defect's evidence or its bar for closure.
> `BUILD_PLAN.md` (this file) — **the work queue**: milestone by milestone,
> task by task, written to be executed by AI coding agents.

Written 2026-08-20. Statuses below were verified against `main` at
`76e4fff` (the WS2.2 secrets merge) — per this directory's rule 3, re-verify
against `main` before starting anything, because this file *will* go stale
the way LAUNCH_PLAN did.

## How to work this plan (rules for agents; extends LAUNCH_PLAN's)

1. **One branch per task row** (`m<milestone>/<slug>`, e.g. `m1/drop-sys-admin`),
   small conventional-prefix commits, no Claude co-author trailer, commit
   locally and stop — push/PR only when the maintainer asks in that turn.
2. **A task is not done until its verification artifact exists and is named**
   in the row (edit this file in the same branch). The artifact is a
   milestone test, a negative control, or a doc section — never just a green
   unit-test run. Where a row says "negative control," that means: prove the
   test *can* fail by temporarily introducing the hole and watching it fail.
3. **Every task that changes enforcement updates the threat model in the same
   branch.** The tier table, the adversary narrowed, and the "not protected"
   list are part of the change, not a follow-up.
4. **Every M1+ task ships with its writeup skeleton** — a `docs/` page or a
   section that could be published as-is. STRATEGY §9: the work is also the
   content. An agent can't publish, but it can leave nothing between the
   maintainer and publishing.
5. **No claim ahead of its artifact** (STRATEGY §7). This rule outranks every
   sequencing decision below.
6. **Check the account before committing** — repo-local `git config
   user.email` must be `ash20pk@gmail.com`; the global config points at a
   different account.

## The shape of the journey

```
M0 Launch week          M1 Close the boundary     M2 Prove it            M3 Own the language
(days, one human gate)  (the core engineering)    (the category-winning  (the permanent moat)
                                                   artifact)
publish + freeze +      SYS_ADMIN drop            attestation            the two specs
supply chain + demo ──► daemon confinement    ──► benchmark         ──►  adapter seams
                        per-app secrets           break-out box          dogfooded CI
                        gVisor option
        └────────────────── M4 runs alongside everything: distribution as a weekly loop ─────────────────┘
```

M0 is days. M1 is the longest engineering stretch (~3–4 weeks of agent work).
M2 turns M1 into the thing no competitor has. M3 makes it permanent. M4 is
not a milestone but a cadence. Later milestones may start before earlier ones
fully close **except**: nothing in M2 publishes numbers against a boundary M1
hasn't closed, and M0.1 (supply chain) strictly precedes M0.2 (publish).

---

## M0 — Launch week (days; one human gate)

Everything here exists or is small. The point is that after M0, a stranger
can install Berth, see a kernel denial in three minutes, and read an honest
account of what that does and doesn't mean.

| # | Task | Status / done when |
|---|------|--------------------|
| 0.1 | **Supply chain before publish** (REMEDIATION 6.6). ✅ Done 2026-08-20 (`m0/supply-chain`): every `uses:` in all 24 workflows pinned to a full commit SHA with a `# vX.Y.Z` comment; all registry `FROM`s in `base.Dockerfile` digest-pinned; `dependabot.yml`'s comment rewritten to describe SHA pinning (its `github-actions` entry keeps the pins fresh); `publish-npm.yml` emits an SPDX SBOM artifact (anchore/sbom-action) on every run, dry or real. | **Verification artifact:** `scripts/lint-workflows.sh`, run by `build-lint-test.yml` before install — fails on any non-SHA `uses:` or digest-less registry `FROM`. Negative control performed 2026-08-20: reverting `codeql.yml`'s checkout pin to `@v7` made the script exit 1 with `UNPINNED ACTION`. |
| 0.2 | **Publish to npm + PyPI** (LAUNCH_PLAN 1.1). 🟡 Agent side done 2026-08-20 (`m0/publish-prep`): all 14 public packages at 0.1.0 with `publishConfig.provenance` (+ `id-token: write` in `publish-npm.yml`), compiled tests excluded from every tarball, per-package READMEs written (incl. sdk-python README/LICENSE/pyproject fields), `pnpm publish:npm:dry-run` green across all 14. **The human gate remains:** maintainer sets `NPM_TOKEN`, runs `dry_run=false`, then runs `scripts/fresh-install-check.sh` in an empty container and records the output in `docs/internal/verification/`. | Done when `npm i -g @berth/cli && berth doctor` works on a machine that has never seen the repo. Verification: a fresh-machine (or empty-container) install script recorded in `docs/internal/` with its output. |
| 0.3 | **The three-minute path on a default Mac.** ✅ Done 2026-08-20 (`m0/doctor-fix`): `berth doctor --fix` implemented — pure planner (`packages/cli/src/util/doctor-fix.ts`) + executor that re-runs doctor against the Colima socket and only claims success from the observed re-check; README quickstart is now the published-package flow; `docs/mac-enforcement.md` and `docs/doctor-reference.md` document `--fix`. | **Verification artifacts:** `doctor-fix.test.ts` (6 unit tests over the planner: non-mac refusal, no-installer refusal, brew-only-when-missing, vz/virtiofs/writable-$HOME flags, no-op path, knob passthrough); measured run recorded in `docs/internal/verification/time-to-first-denial-2026-08-20.md` — ≈2m20s to a kernel `EACCES`, caveats (pre-provisioned VM, unpublished npm) stated inline. Re-measure on a clean machine post-publish. |
| 0.4 | **Declare the freeze** (LAUNCH_PLAN WS3.1–3.3). ✅ Done 2026-08-20 (`m0/freeze`). | The canonical paragraph is CONTRIBUTING.md § "The agents packages are frozen"; `packages/agents/README.md`, `packages/agents-python/README.md`, and `ROADMAP.md`'s `@berth/agents` bullet all point at it. (A `docs/README.md` index existed briefly and was removed 2026-08-20 at the maintainer's request — README.md is the only docs entry point.) |
| 0.5 | **Ops floor** (LAUNCH_PLAN 2.3). ✅ Done 2026-08-20 (`m0/ops-floor`): `/health` + SIGTERM/SIGINT drain (Fastify `close()` → onClose → `db.close()`) on grants/registry/mesh-coordinator; `PRAGMA journal_mode=WAL; busy_timeout=5000` on the three TS `db.ts` opens; semantic-fs-daemon's Go `index.Open` gets `busy_timeout` + `journal_mode=TRUNCATE` instead — WAL there silently emptied snapshots, because `berth snapshot create` archives the bare .db file and WAL keeps recent commits in the -wal sidecar (found by `snapshot-milestone.mjs` during M1.1). | **Verification artifacts:** `health.test.ts` per server (route + WAL pragma asserted against the file on disk); `packages/grants-server/src/drain.test.ts` — kill-under-load: real server process, 20 writes in flight, SIGTERM, asserts in-flight answered, exit 0, listener gone. All green 2026-08-20; Go daemon cross-builds for Linux. |
| 0.6 | **The launch writeup package.** ✅ Drafts done 2026-08-20 (`m0/writeups`): `docs/internal/writeups/landlock-seccomp-story.md` (built around the 1.4 negative-control find — the umask accident and the squatting hole), `iam-for-agents.md` (STRATEGY §1–2 with the "uncomfortable half of the analogy" section), `mcp-denial-demo.md` (30-second script, asciinema notes, pre-publish honesty checklist). Maintainer publishes. | Every technical claim links its artifact (Test 9, mcp-milestone, threat-model, REMEDIATION). (c)'s commands are verbatim from `docs/mcp-quickstart.md`, whose flow is CI-asserted by `mcp-milestone.mjs`; its checklist requires a same-host doctor run before publishing. |

**M0 success =** a stranger can go from zero to an explained kernel denial in
one sitting, on npm-published code, with the story of why it matters sitting
next to it. **Metric initialized:** time-to-first-denial (axis 4).

---

## M1 — Close the boundary (axis 1; ~3–4 weeks of agent work)

After M1, the threat model's honest one-liner upgrades from "strong against a
prompt-injected agent" to "strong against code execution inside the
container." Each task lands with its threat-model edit (rule 3).

| # | Task | Done when |
|---|------|-----------|
| 1.1 | **Drop container-wide `CAP_SYS_ADMIN`.** ✅ Done 2026-08-20 (`m1/drop-sys-admin`): per-sandbox semantic-fs **sidecar** performs the FUSE mount (rshared host bind for the mountpoint; named volumes for backing store + control socket — virtiofs can't hold the root:berth ownership model); sandbox gets the mount as an rslave bind with **no SYS_ADMIN, no /dev/fuse, no apparmor exception**; created_by attribution falls back from pid to uid (`BERTH_APP_UID_MAP`) across the pid-namespace boundary; per-boot mountpoints + sidecar-side stale-mount sweep; automatic loud fallback to the pre-M1.1 posture where rshared propagation is unavailable (observed once on Docker Desktop; `docker inspect` tells the truth in both modes). Design + deviations: `docs/internal/design/sys-admin-drop.md`. | **Verification artifact:** `sys-admin-drop-milestone.mjs` (+ CI workflow) — clean inspect, live writable propagated mount, `mount(2)` EPERM as root; **negative control:** a `BERTH_DISABLE_FS_SIDECAR=1` boot shows the cap back and the same mount succeeding. Regression sweep green on Colima 2026-08-20: semantic-fs, capability-enforcement (13 PASS), snapshot, snapshot-crash, multi-app, context-bus, on-install, published-port-security, mcp, per-app-secrets. Threat model 1.3 row rewritten with residuals named (sidecar still privileged → M1.2; k8s adapter unchanged). |
| 1.2 | **Confine the daemons** (threat model B4). ✅ Done 2026-08-20 (`m1/daemon-confinement`): three daemons, three postures matched to what each actually needs. **context-bus-daemon** runs under `agent-init` itself — own uid (9001), a script-written policy granting only its socket directory, plus the same seccomp filters + capability drop every app gets (no outbound TCP, no UDP, no namespace creation). **semantic-fs-daemon** can't: `mount(2)` is refused by a Landlock domain, so it narrows *in-process* — a new `internal/privs` empties the capability bounding set and reduces the effective set to the file-ownership caps (CHOWN/DAC_OVERRIDE/FOWNER/FSETID) across all threads via `AllThreadsSyscall`, plus `no_new_privs`, the instant `fuse.Mount` returns; SYS_ADMIN is gone before the first request and unrecoverable. **mesh-daemon** can't either (it holds `CAP_NET_ADMIN` for wg0's lifetime), so it applies its own Landlock write domain in `main()` before the tokio runtime spawns any thread, scoped to the WireGuard/key/socket paths + `/dev/net/tun`. uid 0 kept for mesh (netlink) and semantic-fs (`root:berth` backing store) — both named residuals. `BERTH_DISABLE_DAEMON_CONFINEMENT=1` restores the pre-M1.2 posture for all three. | **Verification artifact:** `daemon-confinement-milestone.mjs` (+ CI workflow): context-bus uid 9001 with its socket's 0660 root:berth model intact; **compromised-daemon simulation** (the daemon's own policy/uid/groups attempting an out-of-domain write that DAC *would* allow and an undeclared TCP connect) denied by the kernel; mesh-daemon's `--confinement-probe` denied outside its domain and allowed inside it (positive control); the sidecar's pid-1 `CapBnd` empty and `CapEff` stripped of SYS_ADMIN while `/context` still round-trips a write. **Negative control:** a `BERTH_DISABLE_DAEMON_CONFINEMENT=1` boot shows context-bus root again, the same out-of-domain write succeeding, and SYS_ADMIN back in the sidecar's bounding set. Landlock-denial checks self-skip on a non-enforcing kernel (honest, not silently green). Threat model B4 row rewritten with residuals named. |
| 1.3 | **Per-app secret scoping.** ✅ Done 2026-08-20 (`m1/per-app-secrets`): `secrets:` in `berth.yml` (schema-validated env var names, default `[]`); `partitionSecretsPerApp` in `secrets.ts` (declared names leave the shared file, delivered only to declarers); entrypoint stages `/run/berth/secrets.<app>.env` 0600 owned by the app's uid and sources it inside `export_app_environment` (per-app subshell); `docs/secrets-reference.md` + threat model updated in-branch. | **Verification artifact:** `per-app-secrets-milestone.mjs` (+ its CI workflow) — 16 checks: B blocked by env, `/proc/<pidA>/environ` (per-app uids; container root itself lacks CAP_SYS_PTRACE), and the file's DAC; A's own read as positive control; **control boot with no declaration shows the token reaching both apps — the negative control**. Undeclared secrets keep shared-file behavior; no-declaration boot byte-identical (unit-tested). Ran green on the Colima host 2026-08-20. |
| 1.4 | **Optional hardened runtime.** ✅ Done 2026-08-23 (`m1/hardened-runtime`), with the done-when's boot criterion honestly **failed and recorded**: `runtime:` passthrough on `StartContainerOptions` → `HostConfig.Runtime` (+ `BERTH_RUNTIME`, empty-means-unset; the semantic-fs sidecar deliberately stays on the default runtime — its FUSE mount needs real host mount propagation); `berth doctor` gains a `runtime` check and `--runtime` flag, and the enforcement probe + boot-banner cache are now **per-runtime** — under gVisor the kernel being probed is the sentry; docs state the tier (container-escape, defense-in-depth, not a substitute for 1.1/1.2) in kernel-enforcement.md § Optional hardened runtime + threat-model. | The probe found the real blocker one layer below the FUSE risk this row named: **gVisor's sentry has no Landlock** (`landlock_create_ruleset` → ENOSYS, runsc release-20260817.0), so `capability-enforcement.mjs` cannot pass under it — selecting runsc today trades the whole kernel tier for escape protection, and doctor + banner say so per-runtime. Evidence and environment: `docs/internal/verification/gvisor-runtime-2026-08-23.md`. Unit tests: runtime passthrough/empty-env (container.test.ts), runtime check ok/fail/informational + probe-under-runtime (doctor.test.ts). Re-probe when gVisor gains Landlock; no code change needed for the answer to flip. |
| 1.5 | **Threat-model re-baseline.** ✅ Done 2026-08-23 (`m1/threat-rebaseline`): rewrote threat-model.md's one-line summary and "What this means in practice" (both halves — the T1→T2 escalation is now in "Reasonable today", the mesh residual and connect-time grants in "Not reasonable yet"); swept README, kernel-enforcement, mac-enforcement, STRATEGY axis 1, the REMEDIATION 1.16 closing note, and both writeups (iam-for-agents, landlock-seccomp-story — the latter's "when those close, this paragraph changes" promise honored). | The old sentence appears nowhere outside this row's own history, because it is no longer true; every replacement names the residuals that bound the new claim — mesh-daemon's uid 0 + `CAP_NET_ADMIN` behind a control socket that trusts self-declared identity (*1.14*), daemon protocol robustness (*1.14*), connect-time cross-app grants (*1.13*), and `docker exec` by construction. |

**M1 success =** the boundary claim survives the repo's own red-team framing.
**Metric:** REMEDIATION 1.3/B4 rows 🟢 with negative controls named.

---

## M2 — Prove it (axis 2; the category-winning artifact)

M2 converts M1's engineering into the thing no funded competitor has:
third-party-checkable evidence. Ship order matters — attestation first,
because the benchmark and break-out box both want to *emit* attestations.

| # | Task | Done when |
|---|------|-----------|
| 2.1 | **Attestation MVP** (`@berth/attest` or inside `@berth/audit`). ✅ Done 2026-08-23 (`m2/attestation`), inside `@berth/audit` (`attest.ts`): the record binds the audit-chain head + the run's slice of it (`meta.runId`), enforcement *as measured* (agent-init's `capability_policy_applied` ruleset reports read off the boot's stderr, filtered by boot ID + the doctor probe per kernel/runtime), the in-container sha256 of each enforced capability-policy file, boot ID, image digest. `berth attest <runId>` emits it (and refuses if the cited chain fails verification, if the run left no records, or if its own output fails the shipped verifier); `scripts/verify-attestation.mjs` checks it with no dependency beyond `node:crypto`. `trustModel` is a **required** field — the verifier rejects a record without it — and the verdict is derived, never asserted: `verifyAttestation` re-derives `enforcement.status` from the embedded measurements, so a verdict edit with a recomputed self-hash is still rejected. | **Verification artifact:** `attestation-milestone.mjs` (+ CI workflow), 14 checks incl. both tamper rejections and a control boot whose seccomp profile ENOSYSes the landlock syscalls — the attestation flips to `NOT_ENFORCED` on an enforcing host. Ran green on **both** daemons 2026-08-23: Colima attests `ACTIVE`, Docker Desktop attests `NOT_ENFORCED` for the same policy — the negative control is the feature, recorded in `docs/internal/verification/attestation-2026-08-23.md`. `docs/attestation-reference.md` § "What this does not prove" written; threat model gains the Recorded-tier scope row; writeup skeleton at `docs/internal/writeups/attestation-story.md`. Residual, named: unsigned — tamper-evident only until the chain head leaves the writer's reach. |
| 2.2 | **The containment benchmark.** Generalize the milestone suite into a harness-agnostic runner (`bench/` or separate repo): each check is (setup, agent-side action, expected containment). Rows from the existing suite: undeclared write, symlink escape, undeclared egress, IMDS/`host.docker.internal` reach, secret visibility in runtime metadata (the WS2.2 checks), CDP exposure, cross-agent interference, namespace-escape. Targets: plain Docker, Berth, and at least one of E2B/Daytona (their free tiers; mock nothing). | Reproducible from a public repo by a stranger; the scored table generated, not hand-written; **every red cell is honest — a cell Berth fails stays red and links the REMEDIATION item.** Positive control: a deliberately weakened Berth config scores worse. |
| 2.3 | **The public break-out box.** A standing Berth sandbox (the Colima/Linux host recipe productized into a small deploy script) holding a flag no capability grants; published rules; attempts logged to the audit trail; the box's own boot attestation published. Agents build the deploy + rules doc; maintainer hosts it. | Box deployable from one script; rules doc names scope and reward; attempt log public; the flag's protection is exactly the shipped enforcement — no special hardening, or the box proves nothing. |
| 2.4 | **Red-team suite + claims inventory** (absorbs LAUNCH_PLAN WS4.1–4.2). `docs/internal/claims.md` extracting every enforcement claim tagged kernel/broker/recorded/unenforced with its proving test or `UNPROVEN`; one milestone per attack class from the threat model, each with a mutation check. | Every claim has a row; the suite runs in CI; a deliberately introduced hole fails it. |

**M2 success =** an outsider can verify the central claim without trusting
us. **Metrics:** harnesses covered by the benchmark; days the box survives;
attestation negative-control in CI.

---

## M3 — Own the language (axes 3 + 5; the permanent moat)

| # | Task | Done when |
|---|------|-----------|
| 3.1 | **Spec: the capability manifest.** Extract the grammar from `manifest-schema` into a standalone spec document (own repo or `spec/`): syntax, semantics per namespace, the enforcement-tier vocabulary (kernel/broker/recorded — the spec *requires* implementations to declare their tier, which is the honesty culture exported), versioning rules, conformance tests. | A third party could implement it from the document alone; Berth's own implementation passes the conformance suite; spec versioned independently of the repo. |
| 3.2 | **Spec: the attestation record.** Same treatment for 2.1's record format, including the `trustModel` field and verifier algorithm. | Same bar as 3.1; the standalone verifier from 2.1 is the reference implementation. |
| 3.3 | **Next adapter seams.** OpenAI Agents SDK adapter; Claude Agent SDK sandbox-backend integration. Each: a runnable example, a milestone test, and an upstream-shaped integration doc or PR draft. | Each seam has all three; the examples run against published packages, not `workspace:*`. |
| 3.4 | **Dogfood in public.** Berth's own CI agents run inside Berth policies; the run's checks include its attestation artifact. Start with one workflow (the docs-lint or a milestone runner) and expand. | A merged PR whose checks include an attestation produced by the agent that wrote it — the "built by agents, contained by Berth" claim becomes a link, not a slogan. |

**M3 success =** the category speaks Berth's grammar. **Metric:** third-party
spec implementations (the slowest, most valuable number on the board).

---

## M4 — The distribution cadence (not a milestone; a weekly loop)

Runs alongside M1–M3 from launch day. Agents prepare; the maintainer
publishes and talks to whoever shows up.

- **Weekly ship-and-tell:** every merged M-task gets its writeup published
  (rule 4 means the draft already exists). The `SYS_ADMIN` drop, the daemon
  confinement, each benchmark row — all content.
- **Fortnightly metric review** — the axis board, kept in this file (§ below).
- **The falsification watch** (STRATEGY §8): after launch, explicitly log in
  this file who showed up. Platform/security engineers → double down on M1/M2
  order. Only framework-seekers → M3.3's seams jump the queue. A platform
  ships the primitive natively → M3.1/3.2 jump everything.

## The axis board

Update at each review; a number nobody updates is a claim nobody checked.

| Axis | Metric | Baseline 2026-08-20 | Current |
|---|---|---|---|
| 1 Enforcement | REMEDIATION 1.3/B4/per-app-secrets closed with negative controls | 0 of 3 | 1 of 3 (per-app secrets, 2026-08-20) |
| 2 Provability | benchmark harnesses covered / box days survived / attestation in CI | none exists | — |
| 3 Universality | seams shipped (MCP, AI SDK, LangChain live) | 3 | 3 |
| 4 Time-to-first-denial | minutes, clean default Mac | unreachable (not published) | ≈2m20s on a pre-provisioned Colima Mac (`verification/time-to-first-denial-2026-08-20.md`); clean-machine number pending publish |
| 5 Standard | third-party spec implementations | 0 (no spec) | 0 |

## What is deliberately not in this plan

Restated from STRATEGY §7 so no agent re-adds them as tasks: framework
features (frozen), hosted infrastructure, multi-tenancy/RBAC (REMEDIATION
5.2), k8s `restricted`-PSA, vector DBs, Python feature parity. Encryption at
rest (REMEDIATION 5.4) is the most likely *earned* addition — it becomes an
M2-adjacent task the moment a real user puts sensitive data through
`/context` — but it enters this file by a named user asking, not by default.
