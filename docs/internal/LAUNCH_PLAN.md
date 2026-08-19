# Launch plan

> **Which document is authoritative for what.** `REMEDIATION.md` — defects: what
> is broken, the evidence, and what would prove it closed. `LAUNCH_PLAN.md` —
> execution order: which of those defects gate a launch and in what sequence.
> `PRIORITIES.md` — an opinionated filter over REMEDIATION, kept for its
> reasoning; superseded on *ordering* by LAUNCH_PLAN. `ROADMAP.md` — the public
> "is X real yet" page. `gaps.md` — **archived**; it validated that the substrate
> is usable from a framework, and is not a roadmap.

Written 2026-08-18. This is the execution plan for taking Berth to a public launch, written to be **executed by AI coding agents** working in this repo. It supersedes the *ordering* in [REMEDIATION.md](./REMEDIATION.md) and [PRIORITIES.md](./PRIORITIES.md) but not their findings — where this file says "skip," the defect is still real, it's just not launch-blocking.

## The strategic decision this plan encodes

Berth is two products sharing one repo:

1. **The substrate** — Berth OS: manifest-declared capabilities compiled to Landlock, per-app UIDs, TLS-terminating scoped brokers, Semantic FS, Context Bus, snapshots, deploy adapters, MCP bridge, framework adapters. This is the company. Nobody else draws enforcement boundaries *inside* the sandbox.
2. **`@berth/agents`** — a full agent framework (Agent, Crew, guardrails, evals, A2A, Python port). This is a **reference consumer**, kept working but **feature-frozen**. Racing LangGraph/Mastra/AI SDK on features is unwinnable and, in a 10x-coding-speed era, pointless — features are replicable in a week; verified enforcement and trust are not.

**Separation is at the positioning/packaging level, not the repo level.** Do not split the monorepo: single maintainer, shared CI, shared milestone-test harness. The separation ships as: distinct npm scopes of emphasis, distinct docs entry points, a frozen-surface declaration on `@berth/agents`, and a README that never leads with the framework.

## Rules for every agent working this plan

- **One branch per work item** (`ws<N>/<slug>`), small commits, no Claude co-author trailer, never push or open PRs. (Repo-standing rule.)
- **Verification is part of the task.** A task is done when its "Done when" check passes and is *recorded* (in the doc the task touches, or the item's row below marked with commit hash). This repo's brand is verified honesty — an overclaimed closure is worse than an open item.
- **Never weaken an honesty caveat** in docs to make something look done. If enforcement/testing status is unclear, say so explicitly, as the existing docs do.
- **Do not extend `@berth/agents`' feature surface** under any workstream. Bug fixes to existing behavior: yes. New capabilities, providers, Crew shapes, integrations: no — reject or file under Non-goals.
- Before starting any REMEDIATION-numbered item, re-verify its status against the actual code — and verify it against **`main`**, not against a branch. When this file was written it asserted that 4.1/4.2/4.8 "shipped in commits `d527c92`, `8504106`, `0aa8f87`" while REMEDIATION still marked them 🔴. Both were half right: those commits existed, but on an unmerged branch, so REMEDIATION was correct about `main` and this file was describing a tree nobody else had. **Resolved in WS0.2** — the stack is merged and the rows are 🟢. The lesson stands as a rule: `git merge-base --is-ancestor <sha> main` before believing any "already shipped" claim, including one in this file.

---

## WS0 — Truth and hygiene (do first, ~1 day)

The repo must look like a security product and its status docs must be trustworthy before anything else, because every later workstream reads them.

| # | Task | Done when |
|---|------|-----------|
| 0.1 | **Delete committed test artifacts** from repo root: `concurrent-inside-*.txt`, `escape-read-link`, `escape-write-link`, `multi-app-test.txt`, `allowed.txt`, `var/` if generated. Add patterns to `.gitignore`. Find what generates them and point it at a temp dir. | `git ls-files` at root shows only real product files; a fresh milestone-test run leaves the tree clean. |
| 0.2 | **Reconcile status tables.** Sweep REMEDIATION.md against git history/code; fix every stale 🔴/🟡. Add a header line to REMEDIATION, PRIORITIES, ROADMAP, gaps.md declaring which file is authoritative for what (REMEDIATION = defects, this file = execution order). | No table row contradicts the code. Spot-check: 4.1–4.8 statuses match `packages/agents/src`. |
| 0.3 | **Move internal planning docs** (`gaps.md`, `REMEDIATION.md`, `PRIORITIES.md`, this file) to `docs/internal/`, with a short `docs/internal/README.md` explaining they're working documents. Mark `gaps.md` **archived**: it validated that the substrate is usable from a framework; it is not a roadmap. | Repo root contains only: README, LICENSE, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, ROADMAP, config files, and directories. All inbound links updated. |

## WS1 — Launch blockers (the actual gate, ~1 week)

| # | Task | Done when |
|---|------|-----------|
| 1.1 | **Publish all packages to npm.** The workflow and dry run already pass end to end (PRIORITIES T1.3). *This is the one step that needs the human:* set `NPM_TOKEN`, run with `dry_run=false`. Agents: prepare a final pre-publish checklist (versions, `files` fields exclude tests, READMEs per package, provenance) and hand it to the maintainer. | `npm i @berth/sdk @berth/agents @berth/cli` works on a clean machine; Quickstart in README uses published packages, not build-from-source. |
| 1.2 | ~~**`berth doctor`**~~ **Landed.** Reports per host: Docker reachable (`ping()`, closing 6.5's raw-socket-error complaint), Landlock enforcement in the *container's* kernel, the daemon's default seccomp profile, and `/dev/fuse` — with a one-line verdict and a documented `--json` contract ([docs/doctor-reference.md](../doctor-reference.md)). The banner is wired into `startContainer()`, so `berth dev` / `berth os up` / `Computer.boot()` are covered by construction. **Two things worth knowing:** the Landlock check is *behavioural* (build a ruleset granting nothing, try a write) because "syscalls absent" and "syscalls present, LSM inactive" are indistinguishable by feature query and the second is the dangerous one; and `agent-init`'s boot line, which used to claim `restricted "<app>"` on hosts where nothing had been restricted, now follows the ruleset status. **The `enforcing` verdict is now observed, via 1.3's Colima recipe** (Ubuntu 24.04 guest, Landlock ABI 4) — and observing it immediately found a bug this command's own tests could not: the probe resolved a temp path *after* binding a ruleset that grants nothing, so on every genuinely enforcing kernel it crashed and reported `UNKNOWN`. Fixed. A green `ubuntu-latest` run remains worth having as a regression gate, not as the basis of the claim. | On Docker Desktop for Mac, boot prints an unmissable banner and `berth doctor` exits 1 with `enforcement: NOT ACTIVE (the Landlock syscalls are not available in this kernel)` — **verified locally**. `--json` documented and versioned. |
| 1.3 | ~~**A supported Mac path where enforcement is real.**~~ **Landed.** [docs/mac-enforcement.md](../mac-enforcement.md) + `scripts/mac-enforcement.sh`, both run end to end on Apple silicon. **The finding that shortens this task: no custom kernel is needed.** Colima's default Ubuntu 24.04 guest already carries `landlock` in its active LSM stack (`lockdown,capability,landlock,yama,apparmor`), which is precisely what Docker Desktop's linuxkit kernel lacks — so the recipe is an install and four flags, not a kernel build. **Two gotchas the doc leads with:** `docker context use colima` is *not* enough, because Berth reaches the daemon through dockerode, which reads `DOCKER_HOST` and not Docker CLI contexts (skip the export and `doctor` probes Docker Desktop while `docker info` reports Ubuntu); and Colima mounts `$HOME` read-only by default, so without `--mount "$HOME:w"` app writes fail `EROFS` and read as capability denials. **It also found a real bug in 1.2** — see that row. | **Done, verified 2026-08-18.** `berth doctor` → `enforcement: ACTIVE` (ABI 4), exit 0, all four checks green on guest kernel 6.8.0-117-generic; `capability-enforcement.mjs` exits 0 with `agent-init` reporting `ruleset=FullyEnforced`, so its assertions ran hard rather than degrading to warnings — undeclared write `EACCES: permission denied, open '/etc/berth-should-not-exist.txt'`, plus symlink escape, `truncate(2)`, 20/20 concurrent out-of-scope writes, `unshare(CLONE_NEWUSER)` and the cross-app socket/directory boundaries all denied by the kernel. |
| 1.4 | ~~**README compression + hero demo.**~~ **Landed.** README is 80 lines: thesis paragraph, a three-line runnable block, then the demo and its output, the framework-adapter table, and a link index. Everything else moved *verbatim* into five new docs — [quickstart](../quickstart.md), [kernel-enforcement](../kernel-enforcement.md), [why-berth](../why-berth.md), [resident-apps](../resident-apps.md), [berth-agents-guide](../berth-agents-guide.md) — with every caveat relocated, not softened; the two that a reader must not miss (not on npm yet; in-container privilege isolation still open) are kept on the README itself. Inbound links from eight files were repointed and a repo-wide relative-link check passes. **One deviation from the plan as written:** the demo does *not* use published packages, because 1.1 hasn't run — it's a `workspace:*` consumer like the other examples, and the README says so rather than printing an `npm i` line that would fail. | **Done, verified 2026-08-19.** `examples/kernel-says-no/` exists and is copy-paste runnable: on the Colima host from 1.3 it prints the in-scope write succeeding and `EACCES: permission denied, open '/etc/berth-should-not-exist.txt'`, exit 0 — no API key, no LLM, no `Agent` in the file. It refuses to fake the result on a host that can't enforce: `Computer.boot()` already declines there, and under `BERTH_ALLOW_UNENFORCED=1` the script labels the outcome `NOT ENFORCED` and exits 1 rather than presenting a denial it cannot attribute to the kernel (that branch exercised too — on an enforcing kernel with the flag set it says the denial is not proof). |
| 1.5 | ~~**MCP as the front door.**~~ **Landed.** [docs/mcp-quickstart.md](../mcp-quickstart.md) is the documented first integration path (linked from the README above the framework-adapter table, and from getting-started's opening lines), and `berth mcp` changed in three ways to make one command in an MCP client's config actually sufficient: it **boots the app's sandbox itself** when none is running and stops what it booted when the client disconnects (`--no-boot` keeps attach-only; the boot path is `bootDevContainer()`, extracted from `berth dev` so both share the mount layout); **`--warm`** pre-builds the image and exits, because the first build takes minutes and an MCP client kills a server that misses its `initialize` timeout — the single most likely way this setup fails; and a denied tool call comes back as a **labelled explanation** naming the `berth.yml` line that would allow it (`packages/cli/src/util/capability-errors.ts`). **Two things the work found.** The explainer must *not* offer `filesystem:write:/etc`: a filesystem scope may only name `/workspace`, `/context`, `/tmp`, `/app`, so outside those the honest answer is "no declaration grants this" — a naive fix line would be one the schema rejects. And `denied-by:` reads `agent-init`'s own ruleset status out of the container rather than assuming, so on a non-enforcing host the same denial says explicitly that it is *not* the Landlock policy. Also fixed on the way: `--app-dir` was passed to Docker unresolved, so a relative path became a "volume name is too short" 400; and the milestone test spawned the bridge with `StdioClientTransport`'s sanitized env, which drops `DOCKER_HOST` — the bridge silently reached a *different* daemon than the test, the same trap a Colima user hits configuring a client, now documented in the quickstart. | **Done, verified 2026-08-19** on the Colima host from 1.3 (`berth doctor` → `enforcement: ACTIVE`). `mcp-milestone.mjs` passes 5/5 with the real `@modelcontextprotocol/sdk` client: tools/list, a tool call confirmed by reading the file out of the container, the `/etc` denial explained and attributed to the kernel, `berth mcp` booting its own sandbox from nothing (Test 4), and a grantable cross-app denial naming `- filesystem:write:/workspace/.berth/dev-workspace/boundary-app-b` with the restart requirement (Test 5). 11 unit tests cover the message shapes including not-enforced/unknown attribution. Registered against a real Claude Code session following only the quickstart (`claude mcp add … --env DOCKER_HOST=…`): `claude mcp list` → `✔ Connected`, then removed, no container left behind. **Not claimed:** nobody has yet driven the full read-the-docs-cold path as a *fresh* session with no author knowledge, and the network branch of the explainer is unit-tested only. |

## WS2 — What the security buyer asks for next (~2 weeks, parallel to WS1 after WS0)

These are the two Tier-2 items PRIORITIES already picked, plus the cheap operational floor. All in REMEDIATION Phase 5.

**WS0.2 changed this workstream's shape.** 5.1 and 5.3 were already built on unmerged branches and are now on `main`, so 2.1 is a verification task rather than a build task, and TLS — which this plan didn't list at all — is available to talk about at launch. That leaves **2.2 (secrets) as the only WS2 item still needing to be written**, which matters because 2.2 is the one the launch gate requires.

| # | Task | Done when |
|---|------|-----------|
| 2.1 | ~~**5.1 Audit trail.**~~ **Landed** (`6956d4b`…`602237e`, merged in `9c42449`): `@berth/audit` with a hash-chained append-only sink, governance denials recorded, named operator tokens so an approver can't sign someone else's name, and `berth audit list` / `berth audit verify`. 26 unit tests. **Remaining work is verification, not construction:** assert that every deny in a *milestone* run reaches the trail with an actor, and that a tampered line is detected end to end. Note the honest limit already recorded in `docs/audit-reference.md` — payload capture is opt-in because 5.4 (nothing encrypted at rest) is still open, so the strongest forensic setting is one a deployment must choose. | A milestone run's denials all appear in the trail with actor + capability + decision; `berth audit verify` fails on a hand-edited line. |
| 2.2 | **5.5 Secrets.** Stop plaintext secrets in `~/.berthrc`, `docker inspect`-visible env, and snapshots. Minimum bar: file mode 0600 store, secrets injected at runtime not baked into images/snapshots, snapshot scrubbing, and a documented "what we do / don't protect" section in the threat model. | `docker inspect` on a booted sandbox shows no provider API key; a snapshot restored on another machine contains no credentials; threat model updated. |
| 2.3 | **5.6 + 5.8 (cheap ops floor).** Health endpoints + graceful shutdown on the four servers; SQLite WAL + `busy_timeout`. | Each server answers `/health`; SIGTERM drains; DBs opened WAL. |

## WS3 — Product separation & framework freeze (~2 days)

The adapters this workstream tells contributors to use — `toAiSdkTools`, `toLangChainTools`, `toToolSpecs` — are real and on `main` as of WS0.2 (`packages/agents/src/interop.ts`, plus `examples/agents/with-vercel-ai-sdk`). They were on an unmerged branch when this plan was written, so 3.1's freeze notice pointed at symbols that didn't exist; it now points at shipped ones.

| # | Task | Done when |
|---|------|-----------|
| 3.1 | **Declare the freeze.** `packages/agents/README.md` (and `agents-python`) open with: "Reference consumer of the Berth substrate. Maintained for correctness; not accepting new framework features — use Berth from your existing framework via `toAiSdkTools`/`toLangChainTools`/`berth mcp`." Add the same to CONTRIBUTING's wishlist section. | A contributor proposing a new Crew shape can be pointed at one canonical paragraph. |
| 3.2 | **Two docs entry points.** `docs/` index splits: "Berth OS (the substrate)" vs "`@berth/agents` (reference consumer)". Getting-started leads with substrate + adapters + MCP; framework quickstart is linked, not inlined. | Nav makes the hierarchy unmistakable; README links reflect it. |
| 3.3 | **Roadmap rewrite.** ROADMAP.md's "where contributions help" and forward sections point at substrate work (apps, brokers, adapters, enforcement verification) — not framework parity. | ROADMAP contains no LangGraph-parity framing. |

## WS4 — Adversarial verification (post-WS1, ongoing)

The next audit is not "Berth vs LangGraph"; it is "Berth's enforcement claims vs a red team."

| # | Task | Done when |
|---|------|-----------|
| 4.1 | **Claims inventory.** Extract every enforcement claim from README/threat-model/capability docs into `docs/internal/claims.md`, each tagged: kernel-enforced / broker-enforced / recorded-only / unenforced, with the test that proves it or `UNPROVEN`. | Every claim has a row; UNPROVEN rows become 4.2 targets. |
| 4.2 | **Red-team milestone suite.** One milestone test per attack class from the threat model (escape via symlink, broker bypass via redirect/DNS rebinding, governance bypass via each transport, self-approval, snapshot credential leakage…), run on a real-Landlock CI host, each asserting the *denial*, with a positive control proving the harness can detect an allow. | Suite in CI on `ubuntu-latest`; a deliberately-introduced hole (mutation check) fails the suite. |
| 4.3 | **External eyes.** Prepare a self-serve audit pack (threat model + claims inventory + how-to-run-the-suite) and hand the maintainer a shortlist of disclosure/audit venues. | Pack exists; maintainer decision requested. |

## Non-goals for launch (cut lines, not corners)

Explicitly out, and the launch notes must say so: Python feature parity; new Crew shapes or providers; vector-DB retrievers; autoscaling; hosted registry; k8s snapshot; live E2B/Daytona account verification; 5.2 identity/RBAC (which also keeps mTLS server-side-only — already documented); 5.4 encryption at rest (mitigated by 2.2's scoping of what's sensitive).

## Sequencing

```
WS0 (1d) ──► WS1 (1w, human gate at 1.1) ──► launch
        └──► WS2 (2w, parallel)          ──► fast-follow if not done
        └──► WS3 (2d, parallel)
launch ──► WS4 (ongoing)
```

Launch gate = WS0 + WS1 complete, WS3 complete, WS2 at least 2.2 done (secrets before public attention). WS4 starts the week after launch and never ends.
