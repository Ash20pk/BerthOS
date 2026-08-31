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
| [claims.md](./claims.md) | **Every enforcement claim, tagged by tier** (kernel / broker / recorded / unenforced) with the test that proves it or an explicit `UNPROVEN`. Machine-checked: `redteam/claims-linter.mjs` fails CI on a citation that no longer resolves. | You want to know whether a specific claim is backed by something that can fail, and what that something is. |
| [audit-pack.md](./audit-pack.md) | **The self-serve audit starting point** — reading order, what is runnable, what is known not covered, and how to report. | You are auditing Berth from outside, or preparing to be audited. |
| [verification/](./verification/) | **What was actually run, once, on a named machine.** One record per milestone: the command, the real output, the negative control, and the residuals. | You want to check a claim against the run that produced it rather than against a summary of it. |
| [writeups/](./writeups/) | **Publishable drafts.** One per shipped milestone, each with a pre-publish checklist naming what must be re-verified before it goes out. | You are publishing, or want the narrative behind a milestone. |
| [design/](./design/) | **Designs written before the code.** Kept when the reasoning outlived the change. | You are about to redo something the design already rejected, and want to know why. |

`ROADMAP.md` is deliberately *not* here: it is the public "is X real yet" page
and lives at the repo root.

## The `BUILD_PLAN M<n>` and `REMEDIATION <n.n>` labels you will see in prose

Both documents are **gone**, deleted once the work queue they held was empty.
Their identifiers survive across the docs — "BUILD_PLAN M1.2", "REMEDIATION
1.13", "*1.14*" — because they are how a change, its threat-model row, its
verification record and its commit message all refer to the same piece of work,
and rewriting them would break that thread for no gain.

Read them as **stable work-item names, not as live citations.** What each one
actually did is recorded where it can be checked:

| Label | Where the substance lives now |
|---|---|
| `BUILD_PLAN M<n>.<n>` | the [verification record](./verification/) dated to that milestone, and the [writeup](./writeups/) beside it |
| `REMEDIATION <n>.<n>` / `*n.n*` | the [threat model](../threat-model.md) row that names it, and [claims.md](./claims.md)'s evidence column |

If you are adding a *new* item, do not invent a new `M<n>` — there is no plan
to add it to. Name the claim in `claims.md` and write the verification record.

## Rules that apply to edits in this directory

1. **Never weaken an honesty caveat to make something look done.** If
   enforcement or test status is unclear, say so explicitly. An overclaimed
   closure is worse than an open item, because it spends credibility that the
   open item merely defers.
2. **A closure names its verification artifact**, not just a passing build — and
   ideally names the negative control that proves the test can fail. Several
   entries here exist because a test passed against the unfixed code.
3. **Verify status against `main`, not against a branch.** More than one status
   line here has described something as shipped while it sat on an unmerged
   branch; `git merge-base --is-ancestor <sha> main` settles it.
4. **A status marker is a claim about the code.** If you change one, say which
   file you read.
