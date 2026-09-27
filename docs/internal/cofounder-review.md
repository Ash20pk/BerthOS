# Co-founder review — gaps and proposed changes

Date: 2026-08-29. Snapshot: 613 commits in 29 days, ~20 packages, 9 apps, 1 star, 0 forks, `@berth/*` not on npm.

## Verdict

The thesis (kernel-enforced permissions, not prompt-level guardrails) is correct and the
evidence discipline (claims inventory, `berth doctor`, attestation that says `NOT_ENFORCED`)
is a real moat. The shape is wrong: a solo founder building five years of surface area in
month one, with zero external signal. Direction right; shape wrong. The fix is subtraction.

## What to keep

- The thesis: permissions enforced by the kernel, not the prompt.
- The honesty discipline: claims inventory tiers, negative controls, doctor refusing to
  claim enforcement it didn't observe, attestation verdicts derived from measurements.
- `agent-init` (Rust) + the milestone tests. This is the actual product.

## Gaps

1. **Surface area vs. users.** ~20 packages, 9 apps, zero users. Agents framework (7.5k
   lines) is bigger than the enforcement layer. Mesh, A2A, K8s/E2B/Daytona fleet deploy,
   snapshots, semantic FS, context bus, grants server, registry server, Crews — each is a
   maintenance liability with unproven demand.
2. **`@berth/agents` is the wrong bet.** Competes with LangGraph / Anthropic & OpenAI agent
   SDKs / Vercel AI SDK on their turf. Dilutes the message: trust layer or another framework?
3. **Mac activation cliff.** Core value (kernel denial) does not work on Docker Desktop for
   Mac. "Replace your Docker runtime with Colima + four flags" is where most first runs die.
   Honest non-zero exit does not reduce the cliff.
4. **No named buyer.** "IAM for agents" implies a platform/security buyer; the artifact is a
   dev tool requiring your image, init process, and manifest format. Platform teams already
   run gVisor/Firecracker + seccomp; app devs don't feel the pain until an incident.
5. **Landlock alone is a thin moat.** FS + TCP scoping is a few hundred lines of Rust. The
   durable value is the policy layer (manifest → FS/net/egress/API-verb brokers + audit +
   attestation) and someone else's agent running under your manifest. Buried under a framework.
6. **Marketing ahead of proof.** Per-API brokers (GitHub) don't generalize — one broker per
   API is the unacknowledged scaling problem. Semantic FS, snapshots, mesh, K8s adapter:
   no evidence of demand.
7. **Not on npm** after 613 commits.
8. **No "why not gVisor / Firecracker / E2B + seccomp" doc.** If that argument can't be won
   crisply, the product has no reason to exist.

## Changes

1. **Cut to one artifact:** `berth.yml` + `agent-init` + `berth mcp` + `berth doctor` +
   `berth attest`. Move `@berth/agents`, `agents-python`, mesh-daemon/coordinator,
   registry-server, grants-server, semantic-fs-daemon, context-bus-daemon, A2A, fleet deploy
   into `experimental/` (or a separate repo). Freeze them.
2. **Reposition as the runtime under other people's agents.** "Same agent, kernel-enforced
   permissions, audit trail." MCP is the product. Target shape:
   `berth wrap <any-mcp-server> --allow filesystem:write:/workspace`.
3. **Solve Mac for real or pick Linux/CI as home.** Options: ship a one-command
   Landlock-capable VM (Lima/Firecracker image); or position CI-first ("agents in your
   pipeline with kernel-enforced scopes") where Linux is universal and buyers think in
   permissions; or declare Mac demo-only and stop optimizing for it.
4. **Publish `@berth/*` to npm this week.**
5. **Three design partners before another feature.** Teams with a real agent incident or a
   compliance requirement. Nothing in the repo is evidence of demand either way yet.
6. **Write the competitive doc:** why not gVisor / Firecracker / E2B + seccomp. The likely
   answer — declarative, per-app, audit + attestation, works inside the box they give you —
   must be written down and tested against real objections.
7. **Acknowledge the broker-per-API scaling problem** in the threat model / roadmap rather
   than letting `github-assistant` imply generality.

## Will it ever make sense?

As a company: yes, only if the buyer is a platform/security team and the product is the
policy + evidence layer other frameworks and sandbox vendors run on — sell trust, not a
framework. As currently shaped (full agent OS with own framework, mesh, eight subsystems,
solo, no users): no — an impressive repo nobody adopts.
