# Strategy — the category, and what "best" means in it

> **Which document is authoritative for what.** `STRATEGY.md` — the category
> Berth competes in, what winning it means, and the post-launch workstreams
> that ladder up to it. `LAUNCH_PLAN.md` — execution order to a public launch;
> its workstreams (WS0–WS4) are the on-ramp to this document's (WS5–WS7).
> `REMEDIATION.md` — defects. `PRIORITIES.md` — the original reasoning that
> the substrate is the product; this file extends that reasoning into a
> market thesis and supersedes nothing in it.

Written 2026-08-20. This is a thesis, and it is falsifiable — §8 names the
evidence that would prove it wrong and what to do then. Everything else in
this file is downstream of one decision: **which category Berth competes in.**
Pick the wrong shelf and Berth is the worst product on it; pick the right one
and it is currently the only product on it.

## 1. The map, and the empty seat

Every "agent" product on the market sits in one of four categories:

| Category | Question it answers | State |
|---|---|---|
| **Frameworks** (LangGraph, CrewAI, AI SDK, the labs' agent SDKs) | How does the agent *think and orchestrate*? | Crowded; features replicate in a week |
| **Sandboxes** (E2B, Modal, Daytona) | *Where* does agent code run? Isolation **around** the box | Well-funded; a capital game; becoming a commodity the platforms will ship natively |
| **Guardrails / evals** (Lakera, Guardrails AI) | Is the *text* going in or out acceptable? | Crowded; shallow moat |
| **Observability** (LangSmith, Langfuse) | What *did* the agent do — after the fact, self-reported | Crowded |

What none of them answer: **what is this agent *allowed to do*, who enforces
that at the moment of action, and who can prove it afterward?** Frameworks
trust the model. Sandboxes are permission-blind inside the box — an E2B
sandbox happily lets the agent read every env var and call any API.
Guardrails filter words, not actions. Observability reports what the agent
*says* it did.

## 2. The category: the agent trust layer

The cloud already solved this exact problem for humans and services, and the
solution has a name every platform engineer reveres: **IAM.** Declared
policy, enforced by the platform — not by the application — with an audit
trail (CloudTrail) that compliance runs on. Nobody ships to AWS production
without it.

**Agents have no IAM.** That is the category. Call it the **agent trust
layer**: the layer between an agent's intentions and the world's resources.

Berth is already, structurally, this product:

| IAM concept | Berth today |
|---|---|
| The policy | `berth.yml` capability manifest |
| The enforcement point | `agent-init`: Landlock + seccomp + capability drop; the egress and GitHub brokers |
| CloudTrail | `@berth/audit` — hash-chained, actor-attributed (REMEDIATION 5.1) |
| *(no AWS equivalent)* | **Attestation** — per-run proof the policy was actually enforced. Not built. §5, axis 2. |

The one-line product definition every decision in this repo should be tested
against:

> **The agent trust layer: declare what your agent may touch; the kernel
> enforces it; the run carries proof.**

### Why this category and not the adjacent ones

- **"Agent framework"** — Berth would be #40 on features, competing on the
  one axis (feature velocity) that AI-era coding has commoditized for
  everyone. PRIORITIES already made this call; this file ratifies it from
  market logic rather than resource constraint: `@berth/agents` is not in the
  product's category, so it is a demo, not the product.
- **"Agent sandbox"** — a capital game against funded incumbents, and
  isolation-around-the-box is a commodity the platforms (Docker, Apple, the
  labs) will ship natively. Berth's differentiation is *inside* the box,
  which the sandbox category has no language for.
- **"Agent OS"** — evocative, unfalsifiable, and nobody budgets for an OS.
  Keep the metaphor in the docs; do not compete in it.
- **IAM-for-agents** — a category every platform engineer already knows they
  need, can explain to their boss in one sentence, and in which Berth has the
  only kernel-enforced implementation in existence.

### Why a solo founder can win this category

Feature moats are dead — for both sides. What cannot be replicated in a week:
**trust, verification culture, a category definition, and a standard.** Those
compound slowly and reward rigor over headcount, which is the game this repo
is already playing (the milestone-test culture, the negative controls, the
honest threat model). The incumbents' advantages — funding, teams, feature
velocity — buy nothing on these axes. And infrastructure history is on the
side of the layer, not the framework: the frameworks on top churn every three
years; the primitive underneath (the container, the kernel, the protocol)
becomes the empire. Frameworks are Rails. Berth should be Docker.

One more structural advantage, stated plainly because it is also the best
story in the category: **this repo's workforce is AI agents**
(LAUNCH_PLAN is written to be executed by them), building the containment
layer those agents run under. "Built by agents, contained by Berth" is a
flywheel no incumbent org chart can copy — and it is dogfooding, not
marketing, once Berth's own CI agents run inside Berth policies (§6, WS7.3).

## 3. Who buys trust

In order of how soon they feel the pain:

1. **The developer shipping an autonomous agent this quarter** — computer
   use, long-running tasks, agent swarms. Their unanswered question is "how
   do I let this run without watching it?" They arrive through MCP and the
   framework adapters, and they convert on axis 4 (time-to-first-denial).
2. **The platform/security engineer** asked to approve #1's deployment. They
   convert on axes 1–2 (enforcement strength, provability) and they are the
   audience PRIORITIES said to go find. They read the threat model first.
3. **The regulated buyer** (fintech, health, anyone with a compliance
   function) — the only buyer who *pays* for security. They convert on
   attestation: a per-run artifact their auditor accepts. No product on the
   market offers this today.

The sequence matters: 1 brings volume, 2 brings credibility, 3 brings
revenue. Skipping to 3 without 1–2 produces an enterprise product nobody has
heard of.

## 4. The window

Every lab is shipping computer-use and long-running autonomy now, and each
launch widens the gap between what agents *can* do and what anyone can
*prove* they were allowed to do. Incidents are inevitable; the first
well-publicized agent incident creates the category overnight, and the
question is only whether Berth is the obvious answer already sitting there
when it happens. That argues for **tempo over polish**: launch with what
exists (the kernel demo is real and unique today), and close the remaining
holes *in public* as content — "watch me remove CAP_SYS_ADMIN from the agent
sandbox" is a better growth loop than a finished product nobody watched being
built. The honesty culture makes this safe: Berth's docs already say what
isn't protected, so shipping-while-open costs no credibility.

## 5. The five axes, and what "best" means on each

Once the category is trust, competition stops being features-per-week and
becomes these five. Each row names where Berth is today (verified against
`main`, per this directory's rules) and what best-in-category means.

### Axis 1 — Enforcement strength
*How much of the policy is actually enforced, at what layer, against what attacker.*

- **Today:** kernel-enforced filesystem/network scoping is real and tested
  (Landlock ABI 3+/4, seccomp, capability drop — threat-model tier table).
  Already ahead of every sandbox on this axis, because they don't have the
  axis. But the threat model's own summary holds: *strong against a
  prompt-injected agent; not yet a boundary against an attacker with code
  execution inside the container.* The three named holes: container-wide
  `CAP_SYS_ADMIN` (REMEDIATION 1.3 remainder), the root daemons outside every filter
  (B4), no per-app secret scoping (secrets-reference "still open").
- **Best:** the honest one-liner upgrades to "strong against code execution
  inside the box." Concretely: mount `/context` in an init step and drop
  `SYS_ADMIN` before any app process exists; give each daemon its own uid and
  Landlock domain; per-app secret declarations in `berth.yml`. Plus an
  optional gVisor/Kata runtime class (one `HostConfig.Runtime` field + a
  doctor check) as defense-in-depth for the container-escape tier currently
  answered with "Docker is trusted."

### Axis 2 — Provability
*Can a third party verify the claim? This is where the category is won, because it cannot be copied in a week.*

- **Today:** the strongest verification culture in the category — milestone
  tests with negative controls, an audit trail with actor attribution, a
  behavioural kernel probe — but no *artifact* a third party can check
  without running the repo.
- **Best:** **attestation.** Every agent run emits a signed record binding
  what the agent did (audit trail) to proof the kernel was enforcing at the
  time (ruleset status, policy hash, boot ID, chained). `berth attest
  <runId>` produces the artifact; a verifier that isn't Berth checks it. The
  pieces exist (REMEDIATION 5.1's chain, doctor's behavioural probe); the product is
  their composition. Honesty constraint carried over from the audit work:
  this is tamper-*evident*, not tamper-proof, until the chain head lives
  somewhere the writer can't reach — say so in the doc from day one.
  Alongside it: the claims inventory and red-team suite (LAUNCH_PLAN WS4) and
  a standing public break-out box (§6, WS6.3).

### Axis 3 — Universality
*Does it work under whatever the developer already uses? Trust layers win by being under everything, never by demanding migration.*

- **Today:** MCP front door (WS1.5, landed), `toAiSdkTools` /
  `toLangChainTools` / `toToolSpecs` (landed), Python SDK.
- **Best:** Berth appears in *other products'* docs as the `sandbox:` /
  `permissions:` option. Next seams, in order of audience size: OpenAI
  Agents SDK, Claude Agent SDK sandbox backend, then "Berth policies inside
  their VMs" (an E2B/Daytona instance whose init is `agent-init`) so even the
  sandbox vendors become distribution rather than competition.

### Axis 4 — Time-to-first-denial
*The category's DX metric. Not time-to-hello-world: time until a developer sees the kernel refuse something and understands why.*

- **Today:** the `/etc` denial with the exact `berth.yml` fix line is the
  best first-five-minutes in the category — and unreachable: nothing is on
  npm, and a default Mac needs the Colima recipe by hand.
- **Best:** `npm i -g @berth/cli` → `claude mcp add berth` → a labelled
  kernel denial, under three minutes, on a default Mac. Requires: 1.1
  (publish — the single highest-leverage unshipped item in the repo), and
  `berth doctor --fix` offering to stand up the Colima host it already knows
  how to verify.

### Axis 5 — The standard
*Whoever writes the policy grammar and attestation record that others adopt owns the category permanently.*

- **Today:** the manifest schema is versioned with a migration chain
  (`manifest-schema`) but written as an implementation detail, for this repo.
- **Best:** two published specs, written for adoption by people who aren't
  us — the **capability manifest** (the policy grammar) and the
  **attestation record** (the proof format) — versioned, with a conformance
  test suite, proposed publicly. The win condition is asymmetric: if a lab or
  framework implements the spec, even in a competing product, the category
  speaks Berth's language. Standards are how small players beat giants;
  features are how they lose to them.

## 6. Workstreams (post-launch; extends LAUNCH_PLAN's numbering)

LAUNCH_PLAN's WS0–WS4 are the on-ramp and remain authoritative for the
launch gate. These start after (or, for WS5.1, during) launch week.
**Task-level breakdown, sequencing, and the metric board live in
[BUILD_PLAN.md](./BUILD_PLAN.md)** (its M1–M3 implement WS5–WS7); this
section stays the workstream-level definition of done. Row
numbers below are workstream items (WS5.1, WS6.2, …), not REMEDIATION
numbers — REMEDIATION references are always written out as such.

### WS5 — Close the boundary (axis 1)

| # | Task | Done when |
|---|------|-----------|
| 5.1 | **Drop container-wide `CAP_SYS_ADMIN`** (REMEDIATION 1.3 remainder): mount `/context` from an init step, drop the cap before any app process exists. | `docker inspect` shows no `SYS_ADMIN` in CapAdd; semantic-fs milestone still passes; a `docker exec` mount(2) attempt fails. |
| 5.2 | **Confine the daemons** (B4): context-bus, semantic-fs, mesh each get their own uid and Landlock domain. | A compromised-daemon simulation (write outside its domain from the daemon's uid) is denied by the kernel; milestone suite green. |
| 5.3 | **Per-app secret scoping**: `secrets:` declarations in `berth.yml`; a companion app no longer sees the primary's keys. | A two-app milestone proves app B cannot read app A's declared secret, by /proc and by env. |
| 5.4 | **Optional hardened runtime**: `runtime: gvisor` (or Kata) passthrough + doctor check. | Boot under gVisor passes the enforcement milestone; doctor reports the runtime class. |

### WS6 — Prove it (axis 2, extends WS4)

| # | Task | Done when |
|---|------|-----------|
| 6.1 | **Attestation MVP**: per-run record binding audit chain + enforcement status + policy hash; `berth attest <runId>`; independent verifier script. | A run on an enforcing host attests ACTIVE; the same policy on Docker Desktop attests NOT ENFORCED — the negative control is the feature. |
| 6.2 | **Containment benchmark**: generalize the milestone suite to run against any harness (plain Docker, E2B, Daytona, Berth); publish the scored table. | The suite runs against ≥3 harnesses; results reproducible from a public repo; Berth is the only green column *and every red cell is honest* — a cell Berth fails stays red. |
| 6.3 | **Public break-out box**: a standing Berth sandbox with a flag no capability grants; break-outs get listed (bounty if fundable). | Box live with published rules; uptime and attempt log public. |

### WS7 — Own the language (axes 3 + 5)

| # | Task | Done when |
|---|------|-----------|
| 7.1 | **Publish the two specs**: capability manifest grammar + attestation record format, versioned, with conformance tests, in their own repo. | A third party can implement either spec from the document alone; conformance suite passes against Berth's own implementation. |
| 7.2 | **Next adapter seams**: OpenAI Agents SDK; Claude Agent SDK sandbox backend. | Each has a runnable example and a milestone test; PR or integration doc submitted upstream. |
| 7.3 | **Dogfood in public**: Berth's own CI agents run inside Berth policies; the run links its attestation. | A merged PR whose checks include an attestation artifact produced by the agent that wrote it. |

## 7. Non-goals (the discipline half, restated from market logic)

- **No framework features** — `@berth/agents` stays frozen (WS3). It is a
  demo of the category, not a competitor in a different one.
- **No hosted infrastructure yet.** The eventual business is likely a hosted
  attestation/verification plane (the part a customer *wants* someone else to
  run, because self-hosted proof of your own compliance convinces nobody) —
  but not before axis-2 exists in open source and someone asks.
- **No multi-tenancy / RBAC (REMEDIATION 5.2), no k8s `restricted`-PSA work, no vector
  DBs** until a named user asks. Every hour there is an hour off the axes.
- **No claim ahead of its verification artifact.** The category is trust;
  one overclaim spends more than a year of feature work earns. This rule
  outranks every deadline in this file.

## 8. How we'll know the thesis is wrong

This strategy is a bet, and the launch (WS1) is its experiment. Evidence that
would falsify it, and the response:

- **Only framework-seekers show up** after the writeup and launch — no
  platform/security engineers, no one reads the threat model. Then the trust
  category is too early, PRIORITIES' warning was right in the other
  direction, and the move is to sit *inside* an existing channel (deepen the
  MCP/Agent-SDK seams where the users actually are) rather than to unfreeze
  the framework.
- **The platforms ship the primitive natively** (Docker or a lab ships
  manifest-declared, kernel-enforced agent permissions). Then the specs (WS7)
  become the whole strategy overnight: the win is Berth's grammar in their
  implementation. This is why WS7 is not deferrable garnish.
- **Attestation finds no buyer** — regulated users accept "it ran in a VM"
  and auditors don't ask for more. Then axis 2 contracts to the benchmark and
  break-out box (credibility tools, not products) and the revenue thesis
  needs rework before any hosted plane is built.

What does *not* falsify it: slow stars, a quiet launch week, or an incumbent
announcing a competing feature. The axes were chosen because they compound;
the judgment window is quarters, not days.

## 9. The founder cadence

The scarce resource is not code — this repo produces verified code at a rate
no team matches. It is **cycles of contact with reality**: publish, demo, be
run by someone else, be wrong in public, adjust. Operating rules:

- **Ship weekly, in public.** Every WS5/WS6 item is also a writeup. The
  removal of `SYS_ADMIN` is content; the benchmark is content; a failed
  break-out attempt is the best content of all.
- **Launch weeks, not launch quarters.** WS1.1 (npm publish) is the only
  true gate left, and it needs the human once (`NPM_TOKEN`). Everything else
  in LAUNCH_PLAN is done or fast-follow.
- **Measure the axes, not activity**: time-to-first-denial on a default Mac;
  number of external harnesses the benchmark covers; days the break-out box
  has survived; count of third-party spec implementations. Four numbers, one
  per contested axis.
