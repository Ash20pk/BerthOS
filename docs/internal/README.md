# Internal working documents

These are **working documents, not product documentation.** They are kept in the
repository because Berth's claim is verified honesty, and that claim is worth
less if the evidence behind it lives in someone's head. They are not written for
someone evaluating Berth — that is [the README](../../README.md), the reference
docs in [`docs/`](../), and [the threat model](../threat-model.md).

Expect them to be blunt about what is broken. That is their job.

## Which document is authoritative for what

| Document | Authoritative for | Read it when |
|---|---|---|
| [REMEDIATION.md](./REMEDIATION.md) | **Defects.** Every known correctness/security/credibility problem, with `file:line` evidence, the fix, and what would prove it closed. | You want to know whether something is actually broken, and what closing it would take. |
| [LAUNCH_PLAN.md](./LAUNCH_PLAN.md) | **Execution order.** Which defects gate a public launch, in what sequence, and what is explicitly out. | You are picking up work and need to know what to do next. |
| [PRIORITIES.md](./PRIORITIES.md) | **The reasoning behind the filter** — why the substrate is the product and the framework is a reference consumer. Superseded on *ordering* by LAUNCH_PLAN. | You want to understand why the plan is shaped the way it is, or are tempted to argue with it. |
| [gaps.md](./gaps.md) | **Nothing — archived.** It validated that the substrate is usable from a real agent framework, by building one. It is not a roadmap. | You are looking for historical context on `@berth/agents`. Never for planning. |

`ROADMAP.md` is deliberately *not* here: it is the public "is X real yet" page
and lives at the repo root.

## Rules that apply to edits in this directory

1. **Never weaken an honesty caveat to make something look done.** If
   enforcement or test status is unclear, say so explicitly. An overclaimed
   closure is worse than an open item, because it spends credibility that the
   open item merely defers.
2. **A closure names its verification artifact**, not just a passing build — and
   ideally names the negative control that proves the test can fail. Several
   entries here exist because a test passed against the unfixed code.
3. **Verify status against `main`, not against a branch.** WS0.2 exists because
   LAUNCH_PLAN once described three items as shipped while they sat on an
   unmerged branch. `git merge-base --is-ancestor <sha> main` settles it.
4. **A status marker is a claim about the code.** If you change one, say which
   file you read.
