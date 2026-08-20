# Agents have no IAM

*Draft for publication — the category argument, from STRATEGY §1–2.*

---

Nobody ships to AWS production without IAM. Declared policy, enforced by the
platform — not by the application — with an audit trail compliance can run
on. It is so load-bearing that we forget it was ever a choice.

Now look at what we're doing with agents. Every product on the "agent" shelf
answers a different question:

| Category | Question it answers |
|---|---|
| **Frameworks** (LangGraph, CrewAI, the labs' SDKs) | How does the agent *think and orchestrate*? |
| **Sandboxes** (E2B, Modal, Daytona) | *Where* does agent code run? Isolation **around** the box |
| **Guardrails** (Lakera, Guardrails AI) | Is the *text* going in or out acceptable? |
| **Observability** (LangSmith, Langfuse) | What *did* the agent do — after the fact, self-reported |

None of them answer the IAM question: **what is this agent allowed to do,
who enforces that at the moment of action, and who can prove it afterward?**

- Frameworks trust the model. A tool-use loop's "permissions" are a system
  prompt, and a system prompt is a suggestion.
- Sandboxes are permission-blind *inside* the box. An E2B sandbox happily
  lets the agent read every env var and call any API — isolation from your
  laptop is not authorization.
- Guardrails filter words, not actions. The agent that says the right things
  and does the wrong ones sails through.
- Observability reports what the agent says it did, after it did it.

For humans and services, we solved this decades ago and gave the solution
three parts: a **policy** you declare, an **enforcement point** you don't
control from inside the application, and a **trail** (CloudTrail) that
doesn't depend on the actor's honesty.

Agents have none of the three. That's not a missing feature. It's a missing
*layer*.

## The agent trust layer

Call it what it is: IAM for agents. The layer between an agent's intentions
and the world's resources.

> **Declare what your agent may touch; the kernel enforces it; the run
> carries proof.**

Here is what that maps to concretely, in the implementation we've been
building ([Berth](https://github.com/Ash20pk/BerthOS)):

| IAM concept | Agent trust layer equivalent |
|---|---|
| The policy document | [`berth.yml`](https://github.com/Ash20pk/BerthOS/blob/main/docs/manifest-reference.md) — `filesystem:write:/workspace`, `network:connect:api.github.com:443`, `app:invoke:<sibling>` |
| The enforcement point | [`agent-init`](https://github.com/Ash20pk/BerthOS/tree/main/packages/agent-init): Landlock + seccomp + capability drop, applied in the kernel before the agent's code runs; egress and GitHub API brokers for what the kernel can't express |
| CloudTrail | [`@berth/audit`](https://github.com/Ash20pk/BerthOS/blob/main/docs/audit-reference.md) — hash-chained records with a *verified* actor, not a self-reported one |
| *(no AWS equivalent yet)* | **Attestation** — per-run proof the policy was actually enforced on the host that ran it. In progress; not shipped, and we won't claim it until the verifier exists. |

The word "kernel" in the middle row is the part that makes it a layer rather
than a library. A `try/catch` is the application checking itself. A proxy is
better. Landlock is the same kernel that enforces file permissions on every
Linux box you've ever trusted, saying `EACCES` to a write the manifest
doesn't cover — the demo is a
[three-minute quickstart](https://github.com/Ash20pk/BerthOS/blob/main/docs/mcp-quickstart.md),
and the test suite behind the claim runs in
[public CI](https://github.com/Ash20pk/BerthOS/blob/main/.github/workflows/capability-enforcement.yml).

## The uncomfortable half of the analogy

IAM earned its trust by being *checkable* — and by being honest about scope.
So, in the same spirit, what this layer does **not** yet give you (all
tracked publicly in the repo's
[threat model](https://github.com/Ash20pk/BerthOS/blob/main/docs/threat-model.md)
and [remediation log](https://github.com/Ash20pk/BerthOS/blob/main/docs/internal/REMEDIATION.md)):

- It is strong against a prompt-injected agent; it is not yet a boundary
  against an attacker who already has arbitrary code execution inside the
  container and targets the pre-enforcement daemons.
- Enforcement is a property of the *host kernel*. `berth doctor` exists
  because Docker Desktop on a Mac cannot enforce Landlock, and a tool that
  reported green there would be worse than no tool.
- The audit chain is tamper-*evident*, not tamper-proof, until the chain head
  leaves the writer's reach.

Every one of those sentences will be deleted the day its fix ships with a
test that proves it — and not one day earlier. If IAM for agents is going to
mean anything, the honesty has to be part of the spec, not the marketing.

## Where this goes

The endgame isn't a product, it's a *grammar*: a capability manifest spec and
an attestation record spec that any runtime can implement, with a conformance
suite that requires implementations to declare their enforcement tier —
kernel, broker, or merely recorded. The cloud got CloudTrail because AWS was
big enough to impose it. Agents might get their IAM the other way: as an open
grammar whose reference implementation anyone can red-team.

That's the bet. The repo is the argument:
[github.com/Ash20pk/BerthOS](https://github.com/Ash20pk/BerthOS).
