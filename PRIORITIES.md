# What actually needs fixing

> **Which document is authoritative for what.** `REMEDIATION.md` — defects: what
> is broken, the evidence, and what would prove it closed. `LAUNCH_PLAN.md` —
> execution order: which of those defects gate a launch and in what sequence.
> `PRIORITIES.md` — an opinionated filter over REMEDIATION, kept for its
> reasoning; superseded on *ordering* by LAUNCH_PLAN. `ROADMAP.md` — the public
> "is X real yet" page. `gaps.md` — **archived**; it validated that the substrate
> is usable from a framework, and is not a roadmap.

Written 2026-08-15, after reading [REMEDIATION.md](./REMEDIATION.md) (25 items still open), [ROADMAP.md](./ROADMAP.md), and the README's positioning, against the state of the agent-runtime and agent-framework categories as of now.

`REMEDIATION.md` is the exhaustive list: every defect found, ordered by phase, each with evidence and a verification step. It is deliberately complete. **This file is the opposite — an opinionated filter over it.** It answers a different question: of the 25 open items, which ones decide whether this product survives, which ones are ordinary engineering that can wait, and which ones should be *deleted* rather than fixed.

The two files will disagree in places. Where they do, `REMEDIATION.md` is right about *what is broken* and this file is right about *what to do about it*. Nothing here contradicts a finding; it re-prioritizes them.

## The one-paragraph argument

Phases 0–2 are closed, which means the security thesis is now true and verified rather than claimed. That thesis — manifest-declared capabilities compiled into a Landlock domain plus two seccomp filters, per-app uids with kernel-established caller identity across sibling RPC, TLS-terminating brokers doing verb-and-path scoping — is not available anywhere else. The sandbox providers (E2B, Daytona, Modal, Cloudflare, Vercel) compete on cold-start latency and treat the whole VM as the blast radius; none of them draw boundaries *inside* the sandbox. Meanwhile the README leads with "a real agent framework," and Phase 4 documents that the framework lacks context management, cancellation, `tool_choice`, prompt caching, usage reporting, image parts, and tool events in the stream — table stakes in the AI SDK, the Claude Agent SDK, LangGraph and Mastra, all of which have full-time teams. **The product is strongest where the market is thinnest and weakest where it is most crowded.** Every priority below follows from that one sentence.

## Tiers

- **Tier 1 — Existential.** The product is misaimed or unadoptable without these. Weeks 1–4. **Done, except the one step that isn't code — see below.**
- **Tier 2 — Credibility.** The differentiator only sells to a buyer who will reject the product on these. Weeks 5–8.
- **Tier 3 — Hygiene.** Real defects, ordinary priority, do them alongside.
- **Tier 4 — Do not fix.** Open items that should be deprecated instead of closed.

## Tier 1 status

| Item | State |
|---|---|
| T1.1 — reposition the README | Done. Opens on the manifest-to-Landlock boundary and the adapter path; `@berth/agents` is presented as the reference consumer it is |
| T1.2 — framework adapters | Done. `toAiSdkTools`, `toLangChainTools`, `toToolSpecs`, optional peer deps, tested against the real packages, plus `examples/agents/with-vercel-ai-sdk` |
| T1.3 — publish to npm | **Blocked on you, not on code.** The workflow, packaging and dry run all work end to end across all twelve packages; publishing needs the `NPM_TOKEN` secret and a human choosing `dry_run=false` |
| T1.4 — 4.1 / 4.2 / 4.8 | Done. Error taxonomy, cancellation + timeouts, context compaction with trim-and-retry |
| T1.5 — the two amber items | Done. 3.7 closed in Python (and found a live 3.1 bug there); 3.5 reclassified ⚪ won't-fix with its reasoning recorded |

Three things surfaced while doing the work that weren't visible when this file was written, and are now recorded in `REMEDIATION.md` rather than here: **3.2 has no Python half at all** (no `stop_reason`, no `TruncatedResponseError` — a truncated response still returns as a final answer to a Python caller), **`google.py` has no `base_url`** so the Gemini adapter can't be stood behind a test server, and **`otel-tracer.ts` classified any non-`llm-turn` event as a tool call**, which the new compaction events would have surfaced in every backend as phantom calls to a tool named "unknown".

**Tier 2 is now the top of the list.** T2.1 (audit trail) is done — see `REMEDIATION.md` 5.1 and `docs/audit-reference.md`. T2.2 (TLS) is done — see `REMEDIATION.md` 5.3 and `docs/tls-reference.md`. **T2.3 (secrets) is what's left in this tier.**

Three things surfaced while doing those two that weren't visible when this file was written.

The `decided_by` fix could not stop at "record the name properly": the name arrived in the request body, so making it trustworthy meant replacing the single shared operator secret with named tokens and dropping `berth grants approve --by` — a small CLI break, and the first place the product has anything resembling a per-human credential.

Payload capture turned out to need a switch rather than a decision: 5.4 (nothing encrypted at rest) is still open, so writing tool arguments into a plaintext file by default would have made the audit trail the leak. It is opt-in in both the sink and the Agent, which means the strongest forensic setting is one a deployment has to choose.

And the mTLS half is cheap to build and impossible to use. The server side is a few lines of Fastify config, but no first-party client can present a certificate, because issuing one needs a CA and an identity to bind it to — which is 5.2, the item this file explicitly defers until someone asks. So mTLS ships as server-side support with no client, and that is worth knowing before promising it to a reviewer who asks for it by name.

---

## Tier 1 — Existential

### T1.1 — Reposition: substrate, not framework

**Not in REMEDIATION.md, and it is the most important item here.**

The README's first line is "A real agent framework — with a real computer under every agent it runs." The differentiator is line 45, in a supporting table. § "How Berth fits with what you already use" — the paragraph that states the correct positioning outright — is paragraph 80.

Lead with the substrate: *kernel-enforced least privilege and durable state for whatever agent framework you already use.* Keep `@berth/agents` as the reference consumer that proves the substrate is usable, not as the headline.

This is a documentation change with no code in it, and it changes which of the remaining 24 items matter. Do it first, because it is the thing that makes T1.2 obviously correct and Tier 4 obviously safe.

**Done when** a reader who already uses LangGraph or the Claude Agent SDK can tell, from the first screen, what Berth gives them without switching frameworks.

### T1.2 — Adapters into the frameworks people already use

**Not in REMEDIATION.md.** The highest-leverage work available, and roughly three days.

`berth mcp` already exposes a resident app's exports as MCP tools. That is the wedge and it is already built: MCP reaches Claude Code, Cursor, the Agent SDK, and every framework that speaks the protocol, at zero adoption cost to the user. It is currently documented as a side feature.

Add two more:

- A `getTools()` returning Vercel AI SDK `tool()` objects from a booted `Computer`.
- A LangGraph/LangChain tool export doing the same.

Both are thin wrappers over the export list `Computer.boot()` already produces. Together with MCP they turn "switch to our framework" into "keep yours, get a sandbox with real boundaries."

**Done when** an example exists showing a LangGraph agent whose filesystem tool is Landlock-scoped, with no `@berth/agents` import anywhere in it.

### T1.3 — Publish to npm

**`ROADMAP.md` § Known gaps.** Nothing under `@berth/*` is published; today you build from source.

Every item above is unreachable while the only install path is `git clone && pnpm build`. This is the single largest adoption tax the project carries and it is not on any remediation phase, because it isn't a defect — which is exactly why it keeps not happening.

**Done when** `npm i @berth/agents` works and the quickstart doesn't start with a clone.

### T1.4 — The three Phase 4 items that bite real users

Of Phase 4's eight, exactly three are worth doing. All three are failures a user hits in normal operation, not missing configuration knobs.

- **4.1 — context-window management.** `agent.ts:172` only ever appends; `session.ts` states outright there is no trimming. A long-lived session eventually fails every subsequent `run()` with no recovery path. Needs a token budget, a trim/summarize hook before the model call, and detection of context-length errors with trim-and-retry. **3d.**
- **4.2 — cancellation and timeouts.** Zero `AbortSignal` in either package. No per-tool timeout, no wall-clock deadline, `server.ts` never listens for client disconnect so a closed browser tab keeps burning tokens, and `approval.ts` blocks ten minutes uncancellably. **2d.**
- **4.8 — error taxonomy.** Max-turns, missing checkpoint, and unknown tool are all bare `Error`. `createFallbackProvider` therefore falls through on *any* error with no retriable classification — a fallback provider that can't distinguish a rate limit from a bug is a liability, not a feature. **1d.**

Skip 4.3, 4.4, 4.5, 4.6, 4.7 — see Tier 4.

### T1.5 — Finish what's half-done, or write down why it can't be

Two 🟡 items are load-bearing for claims the product already makes.

- **3.5 — checkpoint `save()` atomicity.** Correctly diagnosed as unfixable at the current seam: there is no rename primitive in the `write_context_file`/`read_context_file`/`tag_context_file` contract, so temp-file-plus-rename needs a new resident-app export *and* FUSE rename support in `semantic-fs-daemon`. Either add the primitive or move the entry to a permanent "won't fix, here's the mitigation" section. Leaving it 🟡 indefinitely is the worst of the three options. **2d if fixed.**
- **3.7 — Python provider adapters have no unit tests.** The TypeScript half is done and `mock-server.ts` is the pattern; the Python side is 618 lines with zero tests, and the doc justification for that no longer exists. The three bugs the TS tests caught (3.1, 3.2, 3.6) all have Python analogues that nothing would catch. **2d.**

---

## Tier 2 — Credibility

The security work is only worth anything to a team that cares about blast radius. That team is regulated, security-conscious, or enterprise — and `REMEDIATION.md` Phase 5 documents that such a team currently gets no identity, no tenancy, no RBAC, no TLS anywhere, conversation history plaintext at 0644, secrets visible in `docker inspect`, and no audit trail with a verifiable actor.

**This is the central contradiction in the product.** The differentiator is aimed at the only buyer who cannot pass a review with it.

Phase 5 is estimated at 4–6 weeks in full and `REMEDIATION.md` says to start it last. That ordering was right when the security claims weren't true yet. They are now, so the two cheapest items in that phase are worth more than all of Phase 4:

### T2.1 — 5.1, audit trail with a verifiable actor (1w)

Governance denials are logged **nowhere** — `governance.ts:159-161` throws silently, and the only log line in the file is the fail-open warning. A governance gate whose denials leave no record is a demo, not a control. `AgentStepEvent` records tool names but never arguments, outputs, or an actor. `decided_by` on a grant is free text from the request body, so an approval attributes itself to whatever name the caller typed.

1.4's peer-socket work already established a caller identity the kernel guarantees. This item is largely about *writing it down*: a structured sink with an actor field, denials included, plus fixing the `[agent-init] {...}` prefix that makes otherwise-good JSON lines unparseable.

### T2.2 — 5.3, TLS (3d)

Every server is plain HTTP with no `https` option. The CLI hardcodes `http://127.0.0.1:4874` and sends the operator token in cleartext. `berth deploy --grants-server` requires a URL reachable *from the fleet* — so capability approvals cross a network in the clear. `http-rpc.ts:49` binds plain HTTP.

1.7 already made every published port loopback-by-default, which contains the local case. The deployed case is still open and is the one an enterprise reviewer will ask about first.

### T2.3 — 5.5, secrets (1w)

Fleet credentials in `~/.berthrc` at 0644. API keys passed as `Env` on `createContainer`, so permanently visible in `docker inspect` — including `BERTH_HTTP_RPC_TOKEN`. `berth snapshot create` copies the whole container environment to `~/.berth/snapshots/.../env.json` with no mode, directly contradicting its own comment claiming secrets aren't captured. `~/.berth/os/<name>.json` holds the RPC bearer token at 0644.

`grants-server/src/operator-token.ts:19` already does this correctly with `mode: 0o600`. Apply that pattern everywhere first (hours, not a week), then add the secret-store seam.

**Defer the rest of Phase 5.** 5.2 (identity/tenancy/RBAC, 2w) is real but is a product decision about whether Berth is multi-tenant at all; don't build it before someone asks. 5.4, 5.6, 5.7, 5.8 are correct findings and can wait.

---

## Tier 3 — Hygiene

Real defects. Do them alongside Tier 1 and 2 rather than in a block.

- **6.9 — `berth os up` rebuilds instead of restarting**, destroying `/var/berth`: the entire semantic FS and its index, so every checkpoint, session and trace, plus the mesh owner token (which makes re-registration 401 permanently). This is data loss in the headline "instant reconnect" workflow. **Arguably Tier 1.** 1d.
- **6.3 — CI runs one Node, one Python, one OS.** No macOS runner despite the docs referencing Docker Desktop for Mac throughout — which is exactly how 0.1 (the framework being unrunnable on macOS at all) went unnoticed for as long as it did. 4h, and it prevents a repeat of the worst bug in the file.
- **6.5 — no `berth doctor`, no Docker preflight, no troubleshooting docs.** `Computer.boot()` constructs `new Docker()` bare with no `docker.ping()` anywhere, so a first run with Docker stopped fails on a raw socket error. Build time is never stated, so a first-timer can't tell a slow cold build from a hang. This is the first-five-minutes experience and it is currently hostile. 1d.
- **6.2 — `providers/auto.ts` is untested**, while `README.md:128` sells auto-detection as the quickstart's defining move ("Notice we never pass `llm`"). Precedence across six providers is unverified in both languages. 4h.
- **6.6 — supply chain.** Pin actions by SHA (`pypa/gh-action-pypi-publish@release/v1` is a mutable *branch* ref on the workflow holding `id-token: write`), digest-pin base images, add SBOM. `.github/dependabot.yml` currently claims actions are "pinned for supply-chain safety" when they're pinned to tags. **This one becomes Tier 1 the moment T1.3 ships**, because publishing to npm is what makes the release workflow worth attacking. 1d.
- **6.7 / 6.8 — fleet commands that cannot work.** `berth fleet scale` silently drops the alias's env and region, so scaled instances get neither API keys nor the right region with no warning. `berth deploy --fleet=daytona` cannot work as written, by its own source comment — `target.imageRef` is a local Docker tag Daytona's `image` param can't resolve, and no registry-push step exists anywhere in the deploy path. Either fix or mark unsupported; a documented feature that cannot function is worse than an absent one. 1.5d.

---

## Tier 4 — Do not fix; deprecate

Every item here is a genuine defect in `REMEDIATION.md`. Fixing them spends scarce solo weeks defending territory that is already lost, on surface that duplicates what the frameworks Berth should be plugging into already do better.

- **4.3, 4.4, 4.5, 4.6, 4.7** — parallel tool calls, `tool_choice`/temperature/reasoning budget, prompt caching and cost tracking, image content parts, streaming tool events. These are the AI SDK's and the Agent SDK's core competency, shipped, maintained by teams. Reaching parity is roughly a month and the target moves. 4.4 is the tempting one because the missing `tool_choice` forces structured output through a prose-and-reparse loop — take that as an argument for T1.2 (let the caller's framework do structured output) rather than for building it here.
- **6.1 — `network.ts` / `Crew.networked` has zero tests** across 415 lines, and its only milestone is credential-gated and not CI-wired. Don't write those tests. `Crew.networked` is the most elaborate feature in the package and the least differentiated: it is multi-agent orchestration, which is precisely what LangGraph exists for. Mark it experimental, or cut it.
- **A2A, evals, guardrails, sessions** — all present, all commodity, all duplicated by every framework in the category, and all listed in 6.4 as documented-with-no-runnable-example. Freeze rather than complete.
- **6.4's remaining eleven missing examples** — write examples for the substrate story (a scoped GitHub agent, a code interpreter with no network, a governance gate) and let the commodity-surface examples stay unwritten. An example is a maintenance commitment; only make it for surface you intend to keep.

---

## Sequencing

1. **Week 1** — T1.1 (reposition), T1.3 (npm), 6.5 and 6.9. Cheap, and each one removes a reason a first-time user bounces.
2. **Week 2** — T1.2 (adapters), 6.3, 6.2, 6.6. Ends with Berth reachable from the tools people already run, on CI that would have caught 0.1.
3. **Weeks 3–4** — T1.4 (4.1, 4.2, 4.8) and T1.5 (3.5, 3.7). The loop stops failing in normal use; nothing 🟡 is left unexplained.
4. **Weeks 5–8** — Tier 2, starting with 5.1 and 5.3. This is what makes the security work sellable rather than merely true.
5. **Ongoing** — Tier 3 alongside. Tier 4 never.

## The thing that isn't on this list

Nothing in `REMEDIATION.md`, `ROADMAP.md`, or `gaps.md` mentions a user. Not one, anywhere, across a document that closes fifteen critical security items with reproduced exploits and negative controls.

The engineering rigor in that file is unusual — better than most funded companies produce, and 1.4's negative control (where the exploit as written turned out to have been closed by accident, by a umask, and the entry had been wrong from the moment it was written) is the kind of finding most teams never surface even to themselves. That work is a genuine asset and the best distribution material the project has.

It is also the largest risk here, because it was all done without contact with anyone who felt the pain. **The highest-value action available is not on this list and takes a day:** ship T1.3, publish the Landlock/seccomp work as a writeup, and find out who shows up.

If they're agent builders who want a framework, this document is wrong and Tier 4 should be Tier 1. If they're platform and security engineers asking whether they can run this under their own orchestrator, then Tier 1 is right and the next year is clear.

## A note on process

`REMEDIATION.md`'s closing note worries that two independently-closed features can break each other, and proposes that a closure name the features it interacts with. Right instinct, wrong target.

The larger risk is that every closure is forty lines of prose. That standard is precisely why the security layer is trustworthy, and it is also why Phase 4 has not started. **Keep it for security boundaries, where a wrong closure is a vulnerability. Drop it everywhere else**, where a wrong closure is a bug report.
