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
| 0.3 | **The three-minute path on a default Mac.** `berth doctor --fix` offers to install/configure the Colima host it already knows how to verify (`docs/mac-enforcement.md` + `scripts/mac-enforcement.sh` become the implementation, not the instructions); README quickstart becomes the published-package flow. | Done when time-to-first-denial on a clean macOS machine is under 3 minutes, measured and recorded. Verification: extend `mcp-milestone.mjs` notes with the measured run; doctor unit tests for the `--fix` branch. |
| 0.4 | **Declare the freeze** (LAUNCH_PLAN WS3.1–3.3 — verified NOT done: `packages/agents/` has no README). Freeze notice in `packages/agents/` + `agents-python/` READMEs and CONTRIBUTING; docs index splits substrate vs reference consumer; ROADMAP drops framework-parity framing. | Done when a contributor proposing a Crew shape can be pointed at one canonical paragraph. |
| 0.5 | **Ops floor** (LAUNCH_PLAN 2.3 — verified NOT done: no `/health` route exists in any server). `/health` + SIGTERM drain on grants/registry/mesh-coordinator; WAL + `busy_timeout` on all four SQLite opens. | Done when each server answers `/health`, drains on SIGTERM (sockets closed, DB handles closed), and DBs open in WAL. Verification: unit tests per server; a kill-under-load test for one of them. |
| 0.6 | **The launch writeup package.** Three drafts in `docs/internal/writeups/`: (a) the Landlock/seccomp engineering story including the 1.4 negative-control find, (b) "IAM for agents" — the category argument from STRATEGY §1–2, (c) the 30-second MCP denial demo script with asciinema/recording notes. Agents draft; maintainer publishes. | Done when all three read as publishable without repo context, every technical claim in them links its verification artifact, and (c)'s demo runs as written. |

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
| 1.1 | **Drop container-wide `CAP_SYS_ADMIN`** (REMEDIATION 1.3 remainder). Today `container.ts:329` adds it unconditionally for semantic-fs's FUSE mount. Move the mount into a privileged init step that completes and drops the cap before any app process exists — candidate design: entrypoint performs the mount, then the supervisor re-execs the remaining boot under a dropped bounding set (`capsh`/`setpriv` equivalent already proven in `agent-init`); alternatively mount from a sidecar one-shot. Design doc first (`docs/internal/design/sys-admin-drop.md`), because this touches every boot path. | `docker inspect` on a booted sandbox shows no `SYS_ADMIN`; `semantic-fs-milestone.mjs` still passes; **negative control:** a `docker exec` `mount(2)` attempt fails with `EPERM`, asserted in a new milestone test. Threat model B4/1.3 rows updated. |
| 1.2 | **Confine the daemons** (threat model B4). `context-bus-daemon` (entrypoint.sh:433), `semantic-fs-daemon` (:449), `mesh-daemon` (:543) all run as root with no Landlock domain. Give each its own uid (extend `provision_app_identity`'s pattern), a Landlock ruleset scoped to its own state paths and sockets, and — where feasible without a Rust rewrite of the Go daemon — run them under `agent-init` itself with a generated policy. | A compromised-daemon simulation (as each daemon's uid, attempt a write outside its domain and a connect it shouldn't make) is denied by the kernel; all existing milestones green. **Negative control:** the same simulation against a pre-change container succeeds. Threat model: B4 narrowed from "no boundary" with the residual named. |
| 1.3 | **Per-app secret scoping.** Extends WS2.2's seam: `secrets:` declarations in `berth.yml` (schema + migration in `manifest-schema`); `secrets.ts` partitions per app; entrypoint sources per-app files (`/run/berth/secrets.<app>.env`, 0600, owned by that app's uid) inside `export_app_environment` instead of one shared file; `docs/secrets-reference.md`'s "no per-app scoping" caveat replaced by the real behavior. | A two-app milestone proves app B cannot read app A's declared secret — by env, by `/proc/<pid>/environ`, and by the file's DAC. Single-app behavior byte-identical when no `secrets:` is declared. |
| 1.4 | **Optional hardened runtime.** `runtime:` passthrough on `StartContainerOptions` → `HostConfig.Runtime` (gVisor first); `berth doctor` gains a runtime-class check; docs state exactly which threat tier this addresses (container-escape) and that it is defense-in-depth, not a substitute for 1.1/1.2. | Boot under gVisor passes `capability-enforcement.mjs` on a host that has it; doctor reports the runtime; docs honest about the FUSE/latency tradeoffs found. |
| 1.5 | **Threat-model re-baseline.** After 1.1–1.3: rewrite the "What this means in practice" section and the one-line summary; sweep every doc that quotes the old posture. | The sentence "not yet a boundary against an attacker who already has code execution inside the container" no longer appears anywhere, because it is no longer true — or the specific residual that keeps it true is named in its place. |

**M1 success =** the boundary claim survives the repo's own red-team framing.
**Metric:** REMEDIATION 1.3/B4 rows 🟢 with negative controls named.

---

## M2 — Prove it (axis 2; the category-winning artifact)

M2 converts M1's engineering into the thing no funded competitor has:
third-party-checkable evidence. Ship order matters — attestation first,
because the benchmark and break-out box both want to *emit* attestations.

| # | Task | Done when |
|---|------|-----------|
| 2.1 | **Attestation MVP** (`@berth/attest` or inside `@berth/audit`). A per-run record binding: the run's audit-chain segment head, the enforcement status *as measured* (agent-init's ruleset report + doctor's behavioural probe result for that boot), the capability-policy hash, boot ID, image digest. `berth attest <runId>` emits it; a standalone verifier script (no Berth dependency beyond the schema) checks it. Honesty constraint from day one, in the doc and the record itself: tamper-*evident* not tamper-proof until the chain head leaves the writer's reach — include a `trustModel` field saying so. | A run on the Colima enforcing host attests `ACTIVE`; the same policy on Docker Desktop attests `NOT_ENFORCED` — **the negative control is the feature**, asserted in a milestone test. Verifier rejects a hand-edited record. `docs/attestation-reference.md` written with its own "what this does not prove" section. |
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
| 1 Enforcement | REMEDIATION 1.3/B4/per-app-secrets closed with negative controls | 0 of 3 | 0 of 3 |
| 2 Provability | benchmark harnesses covered / box days survived / attestation in CI | none exists | — |
| 3 Universality | seams shipped (MCP, AI SDK, LangChain live) | 3 | 3 |
| 4 Time-to-first-denial | minutes, clean default Mac | unreachable (not published) | — |
| 5 Standard | third-party spec implementations | 0 (no spec) | 0 |

## What is deliberately not in this plan

Restated from STRATEGY §7 so no agent re-adds them as tasks: framework
features (frozen), hosted infrastructure, multi-tenancy/RBAC (REMEDIATION
5.2), k8s `restricted`-PSA, vector DBs, Python feature parity. Encryption at
rest (REMEDIATION 5.4) is the most likely *earned* addition — it becomes an
M2-adjacent task the moment a real user puts sensitive data through
`/context` — but it enters this file by a named user asking, not by default.
