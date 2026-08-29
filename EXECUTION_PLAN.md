# Execution plan — acting on COFOUNDER_REVIEW.md

Companion to [COFOUNDER_REVIEW.md](./COFOUNDER_REVIEW.md). That file says *what is wrong*.
This one says *what to do, in what order, and what has to be true before each step starts*.

Written 2026-08-29 against branch `m2/close-unproven-governance`. Every chunk below is one
branch off `main` with small commits, per the repo's git rules. Nothing is pushed or PR'd.

---

## Findings that change the plan

Three facts from reading the tree, which make the plan cheaper than the review assumed:

1. **The core artifact is almost already separable.** `berth mcp`, `berth doctor`, and
   `berth attest` import only `@berth/docker-orchestrator` and `@berth/manifest-schema`.
   They do not touch `@berth/agents` at all.
2. **`@berth/agents` reaches the CLI through exactly 3 command files** —
   `commands/eval.ts`, `commands/agent/run.ts`, `commands/crew/run.ts`. Past-you already
   refused this dependency twice on purpose (see the comments in `util/os-config.ts:67`
   and `commands/os/up.ts:148`). The seam was designed; it just was never cut.
3. **The daemons are not the framework.** `agent-init` (Rust), `context-bus-daemon` (Rust),
   `mesh-daemon` (Rust), `semantic-fs-daemon` (Go) are image-embedded, not npm packages.
   They cannot be "moved to experimental" the way a TS package can, and `agent-init` is
   the product. Demoting a *daemon* means not starting it by default, not relocating it.

4. **The `@berth` npm scope belongs to someone else** — an abandoned project in the same
   problem space, published five months before this repo existed. Chunk 7 is blocked on a
   scope rename, and the review's "just publish to npm this week" was not actionable as
   written. Full detail and the availability table are in Chunk 7.

Consequence: **the split is a dependency cut in 3 files plus a workspace/CI reshuffle**, not
a rewrite. That moves it earlier in the order than I first thought. The naming blocker is
independent of everything else and can be resolved in parallel.

---

## The dependency graph that constrains ordering

```
manifest-schema ──┬──> docker-orchestrator ──┬──> cli        [CORE]
tls ──────────────┤                          │
audit ────────────┘                          │
                    sdk ────────────────────┘
                    
agents ──> {adapter-core, audit, docker-orchestrator, grants-server, manifest-schema, sdk}
cli   ──> {agents, adapter-{core,daytona,e2b,k8s}, registry-server, ...}   <-- the cuts
```

**Core keep-set (7):** `agent-init`, `manifest-schema`, `docker-orchestrator`, `sdk`, `audit`,
`tls`, `cli`.
**Demote-set (11):** `agents`, `agents-python`, `sdk-python`, `mesh-coordinator`,
`mesh-daemon`, `registry-server`, `grants-server`, `semantic-fs-daemon`,
`context-bus-daemon`, `adapters/*` (daytona/e2b/k8s), `seam-*`.

Note the two genuinely hard cases, called out rather than buried:
- `agents` depends on `grants-server`, so both move together or neither does.
- `docker-orchestrator` *starts* the daemons. Demoting them is a boot-default flag change
  inside a core package, not a move. Handled in Chunk 3, deliberately separate.

---

## Ordering principle

Reversible and message-level work first; the one-way door (the move) only after the
competitive argument is written down — because if the "why not gVisor/E2B" doc cannot be
written convincingly, **the whole restructure is premature** and the answer is different.

That is the single most important sequencing decision in this plan.

---

## Chunk 0 — Decisions only you can make (blocks Chunks 4 and 6)

No code. These are not tasks I can do; they are inputs I need.

| # | Decision | Why it blocks | Default if you say nothing |
|---|---|---|---|
| D1 | **Mac vs Linux/CI as the home platform** (review gap #3) | Determines whether Chunk 6 is a VM-shipping task or a CI-positioning task. Rewrites the README's first 30 lines either way | CI-first: Linux is universal, buyers already think in permissions |
| D2 | **Is `@berth/agents` frozen, deleted, or spun to its own repo?** | Freeze = `experimental/` in-tree (Chunk 4 as written). Separate repo = extra history-preserving `git filter-repo` step | Freeze in-tree; splitting history is work with no user benefit yet |
| D3 | **Publish to npm before or after the restructure?** | Publishing first means the 11 demoted packages ship at 0.1.0 and then vanish from the scope — an ugly first impression for anyone who installed them | After Chunk 4, so the first published surface is the one you intend to support |
| D4 | **Who are the 3 design-partner candidates?** (review change #5) | The competitive doc in Chunk 1 should answer *their* objections, not generic ones | I proceed with a generic platform/security-team reader |
| D5 | **New npm scope, product rename, or ask for `@berth`?** | The `@berth` scope is owned by an abandoned project (see Chunk 7). Blocks all publishing | `@berthos/*` — matches the GitHub repo, no product rename, Python names already free |

---

## Chunk 1 — `docs/why-not-existing-sandboxes.md`  *(no code, highest leverage)*

Review changes #6, gap #8. **This is the gate on everything after it.**

1. Write the honest comparison table: gVisor, Firecracker, E2B, Daytona, Modal, plain
   Docker + seccomp/AppArmor, raw Landlock in your own image.
2. For each, answer the actual objection: *"why not just write a Landlock policy in my own
   init?"* The candidate answer — declarative per-app manifest, brokers for what the kernel
   can't see (HTTP verb/path), hash-chained audit, per-run attestation, and it works *inside*
   the box those vendors give you rather than replacing it — must survive being written down.
3. Add the row the review demands be admitted: **one broker per API does not scale**
   (gap #6). Say what the general mechanism would have to be, or say it's unsolved.
4. Link it from the README and from `docs/threat-model.md`.

**Exit test:** you can read it and not wince. If the table shows Berth losing every column
except honesty, stop the plan here and rethink the product — that is a real outcome and this
chunk is designed to surface it cheaply, before any restructuring.

---

## Chunk 2 — Reposition the message  *(docs + README, still no restructure)*

Review change #2. The README is already half-converted ("keep the agent framework you
already have"); this finishes the turn.

1. Rewrite the README lede around **the runtime under other people's agents**. MCP is the
   product surface, not a footnote in the middle.
2. Demote `@berth/agents` in the README to one line under a "also in the box" heading, and
   drop it from the feature table entirely. It currently gets a 12-row table — more than
   kernel enforcement gets.
3. Prototype the target CLI shape from the review: `berth wrap <mcp-server> --allow
   filesystem:write:/workspace`. **Spec it in the doc first**; implement in Chunk 5.
4. Add the broker-per-API scaling admission to `docs/threat-model.md` (review change #7).
5. Update `docs/internal/claims.md` only if wording changes — do not touch tiers or tests.

**Exit test:** `pnpm build && pnpm lint` clean; no claim in the README lacks a claims.md row.

---

## Chunk 3 — Daemons off by default  *(core behavior, do before the move)*

Not in the review as its own item, but forced by finding #3. The daemons are the largest
part of the "surface area for zero users" problem *and* they carry the biggest residual
(mesh-daemon's retained root + `CAP_NET_ADMIN`).

1. Audit `docker-orchestrator` for which daemons start unconditionally vs. on a declared
   capability. Mesh already gates on `network:peer:` — confirm and document.
2. Make `semantic-fs-daemon` and `context-bus-daemon` start only when an app declares a
   capability that needs them. Fewer moving parts in the default boot = smaller attack
   surface and a shorter honest claims list.
3. Run every affected milestone locally: `daemon-confinement`, `context-bus`, `semantic-fs`,
   `mesh`, `multi-app`, `capability-enforcement`. **A green run here is required before
   Chunk 4** — you do not want to debug a boot regression and a workspace move in one diff.

**Exit test:** default boot starts strictly fewer processes; all six milestones green.

---

## Chunk 4 — The `experimental/` move  *(the one-way door)*

Review change #1. Approved as real work. Sequenced last among the structural chunks because
it is the least reversible and depends on Chunks 1 and 3 passing.

Order matters inside the chunk — each step is its own commit:

1. **Cut the CLI's 3 imports.** Verified cheap by reading the files:

   | File | Lines | Runtime symbols needed from `@berth/agents` |
   |---|---|---|
   | `commands/agent/run.ts` | 30 | 1 — `createAgentFromYaml` |
   | `commands/crew/run.ts` | 26 | 1 — `createCrewFromYaml` |
   | `commands/eval.ts` | 122 | 3 — `runEvalSuite`, `recordEvalRun`, `listEvalRuns` |

   Five runtime symbols across three files, each used inside `run()`. oclif discovers
   commands by directory (`oclif.commands: "./dist/commands"`), so **command modules are
   already loaded lazily at runtime** — moving these five to `await import("@berth/agents")`
   inside `run()` costs nothing and breaks the runtime dependency outright.

   **The one real subtlety:** the four `type` imports in `eval.ts` are erased at runtime but
   still needed at *build* time, so a naive lazy-import leaves `@berth/cli` needing
   `@berth/agents` as a devDependency — a core-to-experimental build edge, backwards even
   if harmless. Three ways out, in preference order:
   1. **Relocate the three commands into the frozen package as an oclif plugin.** Core
      `@berth/cli` then has zero reference to the framework, in either direction. Most work,
      architecturally correct, and it makes "the framework is optional" literally true.
   2. Keep `@berth/agents` as a devDependency-only for typecheck, `optionalDependencies` at
      runtime. Cheapest; leaves the backwards build edge.
   3. Type the boundary as `unknown` and validate at the call site. No new edge, loses
      typechecking on exactly the surface most likely to drift.

   Pick (1) if Chunk 4 proceeds at all; (2) is the acceptable shortcut if time is short.
   *This step alone delivers most of the review's intent and is independently revertible.*
2. **Cut the adapter imports** in `util/fleet.ts` and `commands/deploy.ts` the same way,
   dropping `adapter-{daytona,e2b,k8s}` and `registry-server` from core.
3. **Create `experimental/` and move the 11 packages** in dependency order (leaves first:
   `seam-*`, adapters, then `grants-server` + `agents` together, then the Python packages).
4. **Update `pnpm-workspace.yaml`** — add `experimental/*`, `experimental/adapters/*`; the
   `examples/agents/*` entries move with them.
5. **Update CI.** 9 of 34 workflows cover demoted subsystems (`agents-milestone`, `mesh`,
   `k8s-adapter`, `snapshot`, `grants-server`, `semantic-fs`, `context-bus` ×2, `python-*`
   ×2). Keep them running but **remove them from the required-checks set** — freezing a
   subsystem means its tests still prove it, they just no longer gate core.
6. **Docs:** 22 of 35 files in `docs/` reference the framework. Do not rewrite 22 docs. Add
   one banner line to each demoted doc — "this subsystem is frozen; see EXECUTION_PLAN.md" —
   and fix only the README/`why-berth.md`/`quickstart.md` prose properly.
7. Move `examples/agents/*` (3 examples) alongside. Keep `kernel-says-no`,
   `prompt-injection`, `no-egress`, `audit-trail` in core — they are the hero demos.

**Exit test:** `pnpm install && pnpm build && pnpm lint && pnpm test` green from a clean
`node_modules`; `capability-enforcement`, `mcp`, `attestation`, `breakout`, `redteam`
milestones green; `examples/kernel-says-no` still runs.

**Rollback:** one `git revert` per step; step 1 is the valuable half and survives alone.

---

## Chunk 5 — `berth wrap`  *(the repositioning made real)*

Depends on Chunk 2's spec and Chunk 4's slimmed core.

1. Implement `berth wrap <mcp-server-cmd> --allow <capability>...`: boot a Berth OS, run the
   named MCP server *inside* it under a manifest synthesized from the `--allow` flags, and
   re-expose its tools upstream with the existing `BERTH CAPABILITY DENIAL` explanation on
   refusal. This is the "runtime under other people's agents" claim in executable form.
2. New milestone test: wrap a third-party MCP server, have it attempt an out-of-scope write,
   assert kernel denial + the explained refusal + the audit row.
3. Add the claim to `docs/internal/claims.md` with its tier and denial test. **No new claim
   without a row** — that discipline is the moat; do not break it for your own feature.

**Exit test:** a real off-the-shelf MCP server runs wrapped, and its out-of-scope write dies
in `open(2)`.

---

## Chunk 6 — The platform decision, executed  *(blocked on D1)*

Review gap #3 / change #3. Shape depends entirely on your D1 answer:

- **If CI-first:** ship a `berth-action` GitHub Action + `docs/ci-quickstart.md`; move the
  Mac/Colima path to a clearly-labeled "local development" appendix. Cheapest, and Linux
  runners enforce out of the box.
- **If Mac-must-work:** one-command Lima/Firecracker VM with a Landlock-capable kernel,
  shipped as an artifact so no user ever types four Colima flags. Real work, weeks not days.
- **If Mac is demo-only:** say so in the README's first paragraph and stop investing in
  `doctor --fix`.

**Exit test:** a new user on the chosen platform reaches a real kernel denial without
reading `mac-enforcement.md`.

---

## Chunk 7 — Publish to npm  *(BLOCKED: the `@berth` scope is not yours)*

Review change #4 / gap #7. The pipeline already exists (`publish-npm.yml`, manual-only,
dry-run default, SBOM, provenance). **But the plan as originally written cannot run.**

### The blocker, found 2026-08-29

`npm view @berth/cli` returns **0.1.1**, published **2026-03-02** — five months before this
repo's first commit. It is not yours:

| Field | Value |
|---|---|
| maintainer | `schwimmbeck <dominik.schwimmbeck@outlook.de>` |
| repo | `github.com/berth-mcp/berth` |
| description | "The safe runtime & package manager for MCP servers" |
| state | 0 stars, 0 forks, last push 2026-03-03; tarball is a stub — no README, no dependencies |

Two separate problems, and the second is worse than the first:

1. **The `@berth` npm scope is unavailable.** Every `@berth/*` name in this repo is
   unpublishable. Unscoped `berth` is also taken (deprecated, different owner).
2. **The name collides with an adjacent project in the same problem space.** "Safe runtime
   for MCP servers" is approximately the repositioning Chunk 2 and Chunk 5 propose. Their
   project is abandoned, so this is not a competitive threat — it is a *search and
   attribution* problem: two Apache-2.0 projects called Berth, both about safely running
   MCP servers, and theirs owns the npm name.

### Availability, checked

| Name | Status |
|---|---|
| npm `@berth/*` | taken (above) |
| npm `berth` | taken, deprecated |
| npm `@berthos/*` · `berthos` · `berth-os` · `@berth-os/*` | **available** |
| PyPI `berth-sdk`, `berth-agents` (the repo's current names) | **available** |
| PyPI `berth` | taken |

### Resolution — new decision D5

**Recommended: publish npm as `@berthos/*`.** It matches the GitHub repo (`Ash20pk/BerthOS`),
needs no product rename, leaves the `berth` command name intact, and the Python names are
already free. Cost is a scope rename across ~16 package.json files, the lockfile, every doc
that shows an install line, and the `publish-npm.yml` provenance config.

Alternatives, for completeness:
- **Rename the product.** Cleanest long-term if you ever want the unscoped name, most
  expensive now, and there is no evidence yet that the name carries value worth protecting.
- **Ask them for the scope.** Free upside, unbounded latency, no leverage. Worth one email
  in parallel; not worth blocking on. npm's dispute process rarely reassigns an actively
  owned scope, abandoned or not.

### Then, once D5 is answered

1. Rename the scope repo-wide; `pnpm install` to resettle the lockfile.
2. Confirm the published set is the **core keep-set only**. Mark every demoted package
   `"private": true` so `pnpm -r publish` skips it — the workflow already honors that.
3. Run with `dry_run=true`; verify no `experimental/` package appears in the pack list.
4. One-time prerequisite the workflow cannot do itself: the `NPM_TOKEN` automation token
   for the **new** scope. That is on you.
5. Publish `0.1.0`, then delete the README's "isn't on npm yet" caveat.
6. Add a one-line disambiguation note in the README — there is another Berth on npm, and a
   confused user finding a dead stub is a worse first impression than no npm package at all.

**Exit test:** `npm install -g @berthos/cli && berth doctor` works on a clean machine.

---

## Chunk 8 — Design partners  *(runs in parallel with everything, gated on D4)*

Review change #5. The only chunk that tests whether any of the rest matters.

1. Three named candidates with a real agent in production, or a compliance requirement.
2. The ask is not "try my framework" — it is *"run your existing agent under this and tell
   me whether the boundary is where you'd want it."*
3. What to listen for: do they care about kernel enforcement, or only about the audit trail
   and attestation? **If it's the latter, the product is a compliance/evidence tool and the
   whole Landlock story is a feature, not the thesis.** That would be the most valuable
   thing you learn all quarter, and it would rewrite this plan.

---

## Suggested order

```
Chunk 0 (your decisions)  ─┐
Chunk 1 (competitive doc) ─┴─> GATE: is the argument winnable?
                                 │ no  -> stop, rethink product
                                 │ yes -> continue
Chunk 2 (reposition docs)
Chunk 3 (daemons off by default) -> milestones green
Chunk 4 (experimental/ move)     -> the one-way door
Chunk 5 (berth wrap)
Chunk 6 (platform decision)
Chunk 7 (npm publish)
Chunk 8 (design partners) ......... in parallel throughout
```

Chunks 1–4 are the ones that change whether this product makes sense. 5–7 are execution.
8 is the only one that produces evidence, which is why it should not wait for the others.

## What this plan deliberately does not do

- **Does not touch `docs/internal/claims.md` tiers or any milestone test's assertions.**
  The evidence discipline is the asset; the restructure must not weaken a single claim.
- **Does not delete anything.** Freezing is reversible; deleting is not, and nobody has yet
  told you which subsystem they need.
- **Does not add features** beyond `berth wrap`, which exists only to make the repositioning
  executable rather than rhetorical.
