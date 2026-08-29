# Research status — what we know, what is still open

Companion to [COFOUNDER_REVIEW.md](./COFOUNDER_REVIEW.md) (the gaps) and
[EXECUTION_PLAN.md](./EXECUTION_PLAN.md) (the sequenced plan). This file is the evidence
ledger: what has actually been established, by whom, and what remains unresearched.

Status as of 2026-08-29. The Chunk 1 gate workflow (`wf_1a4957fb-642`) was stopped partway
to save tokens; 14 of ~30 agents returned before the stop. Everything below marked
**[verified]** came from an agent that read the code or a primary source and cited it.

---

## Part 1 — What we researched, and what it found

### 1.1 The repo, statically (done by me, direct)

| Fact | Detail |
|---|---|
| Scale | ~20 packages, 9 resident apps, 613 commits in 29 days (18 in Jul, 595 in Aug) |
| Traction | 1 star, 0 forks, repo created 2026-07-31 |
| Core keep-set is separable | `berth mcp`/`doctor`/`attest` import only `docker-orchestrator` + `manifest-schema` |
| CLI↔framework coupling is tiny | 5 runtime symbols across 3 files (`eval.ts`, `agent/run.ts`, `crew/run.ts`); oclif already loads commands lazily by directory |
| Languages | `agent-init` + `context-bus-daemon` + `mesh-daemon` in Rust, `semantic-fs-daemon` in Go — image-embedded, not npm packages |
| CI | 34 workflows; 9 cover subsystems the plan proposes to freeze |
| Docs | 22 of 35 files in `docs/` reference the agents framework |

### 1.2 The npm name (done by me, direct) — **blocker**

- `@berth/cli@0.1.1` is published, owned by `schwimmbeck`, repo `github.com/berth-mcp/berth`,
  described "The safe runtime & package manager for MCP servers", published **2026-03-02** —
  five months before this repo's first commit.
- That project is abandoned: 0 stars, 0 forks, last push 2026-03-03, tarball is a stub with
  no README and no dependencies. But it owns the scope.
- Unscoped `berth` on npm: taken, deprecated, different owner. PyPI `berth`: taken.
- **Available:** npm `@berthos/*`, `berthos`, `berth-os`, `@berth-os/*`; PyPI `berth-sdk` and
  `berth-agents` (the repo's existing Python names).
- Recorded as decision **D5** in the plan. Recommendation: `@berthos/*`.

### 1.3 What Berth actually enforces — four grounding agents **[verified]**

This is where the research stopped being strategic and started finding real defects.

**CORRECTED 2026-08-29 — the headline finding was overstated.** An agent reported that
`ALLOWED_WRITE_PATH_PREFIXES` makes the manifest meaningless and that four `docker run` flags
match Berth's guarantee. I checked the code directly and that is **wrong**:

- `main.rs:622` matches with `path == *prefix || path.starts_with(&format!("{prefix}/"))` — a
  **prefix** match. So `filesystem:write:/workspace/out` is declarable and valid.
- `baselineWritePaths()` in `generate-capability-policy.ts` is only
  `["/dev/null", appTmpDir, appRunDir]` — it does **not** include `/workspace`.
- `generate-capability-policy.ts:249` puts the declared scope straight into `writePaths`.

Therefore **sub-path write scoping genuinely works, and the manifest line really is the
boundary**: an app declaring `filesystem:write:/workspace/out` gets a Landlock grant on
`/workspace/out` and `/workspace/secrets` stays unwritable. Four `docker run` flags cannot
express that — the same adversarial agent's own "what it would still lack" list conceded
sub-path scoping as a docker gap, which contradicts its headline.

**The real, much narrower limitation:** a `berth.yml` cannot declare a writable root *outside*
`/workspace`, `/context`, `/tmp`, `/app` — so `/data` or `/var/lib/foo` are not expressible.
That is a deliberate, documented safety choice (the README's own MCP denial message states
it verbatim) and a defensible one, not a hole. It is worth revisiting only if a design
partner needs a custom mount root.

**Kernel tier, other verified gaps:**
- `AccessFs::Execute` and `IoctlDev` are unhandled, so the Execute *right* is unrestricted —
  but **[corrected]** this is deliberate, documented at `main.rs:668-676` as "a real gap …
  tracked separately", and materially mitigated: with read scoping on, `execve()` of a file
  outside every read rule already fails `EACCES`. Real, known, lower severity than reported.
- `network:connect:*` does not widen port scoping, it **removes** the
  `handle_access(AccessNet::from_all(V4))` call entirely — no kernel network boundary at all
  (`restrict_network = !policy.network_unrestricted`, `main.rs:688-694`). **[confirmed by me,
  as stated.]** `apps/browser-native` declares it.
- The compiled ruleset is **not** derived from the manifest alone:
  `generate-capability-policy.ts:177 fetchApprovedCapabilities()` widens it from an
  **unauthenticated plain-HTTP** grants server.
- Read-path grants are silently skipped when the path is absent at boot, denying those reads
  for the process lifetime.
- In a `berth dev` boot, `BERTH_REQUIRE_ENFORCEMENT=1` is set only in the `prod` Dockerfile
  stage — **none of agent-init's refusals fire in the default dev loop**.
- `K22`/`B16` (the two newest claims) do not exist on the current checkout.
- gVisor is mutually exclusive with the entire kernel tier (`runsc` returns ENOSYS for
  `landlock_create_ruleset`).

**Default boot — the surface-area audit (this was also Chunk 3's investigation):**
- The **semantic-fs sidecar container starts unconditionally** (`container.ts:375`), holding
  `CapAdd: ["SYS_ADMIN"]`, `/dev/fuse`, and `apparmor:unconfined`. The README claims "no
  `CAP_SYS_ADMIN` anywhere in the sandbox". **These two statements conflict.**
- `context-bus-daemon` also starts unconditionally (`entrypoint.sh:558`, `:783`).
- `semantic-fs-daemon` keeps uid 0 forever and applies **no Landlock at all**.
- `mesh-daemon` keeps uid 0 + `CAP_NET_ADMIN` for wg0's lifetime and is **not run under
  agent-init**, so the M1.2 confinement work does not cover it.
- Exactly **one of four** daemon launch decisions (mesh) actually reads a capability.
- Neither daemon *authorizes* anything — `SO_PEERCRED` identity is **recorded, not enforced**.
- `context-bus` has a silent root fallback with no denial test (`entrypoint.sh:505-510`).
- There is currently **no way to express the opt-in** the plan's Chunk 3 assumes.

**Broker tier:**
- The app holds the `GITHUB_TOKEN`, **not** the broker (`apps/github-assistant/src/index.ts`)
  — so the broker is a convention the app could bypass.
- **No resource-instance scoping**: the route table's scope functions discard owner and repo
  (`scope: () => "repos"`), so `github:read:repos` means *all* repos, not a named one.
- **Two API brokers cannot coexist in one app** — undici's `setGlobalDispatcher` is
  process-global and single-valued.
- Upstream-proxy mode **drops the address deny-list** (skips `isBlockedAddress`).
- IPv6 is unreachable rather than checked (`dns.resolve4` only).
- "The broker is the only exit" is a convention, not a kernel property — Landlock network
  scoping is port-only.
- Per-API coupling is spread across **at least nine hand-edited files with no registry**.

**Audit + attestation:**
- **Confirmed bug:** once rotation prunes the oldest segment, `berth audit verify` reports
  BROKEN and `berth attest` refuses to emit. A real install either keeps every byte forever
  or loses the ability to attest — and a genuine gap looks identical to tampering.
- **Wholesale rewrite is invisible by construction** — `resumeChain` returns
  `CHAIN_GENESIS` when the file is absent.
- Audit is **opt-in and nothing records that it was off**. Failures are silently swallowed.
- Attestation's `policies[].sha256` is re-run at attest time with **nothing binding it to
  what agent-init actually read**.
- `doctorProbe` is a **cached verdict from a different container** in an operator-writable
  file, with no `probedAt`. **Editing that one file forges half of an `ACTIVE` verdict.**
- No root of trust, no signature at any layer, no trusted time. Nothing maps onto SOC 2
  CC7.2/CC6.1, ISO 27001 A.8.15, or RFC 9334, where unsigned evidence "is not an attestation
  at all: it is a self-report with a checksum."
- The 34-test audit suite does pass (agent ran it).

### 1.4 Competitive survey — 6 of 8 alternatives **[verified, with sources]**

| Alternative | Can it say "write /workspace only"? | In-box audit | Adoption cost |
|---|---|---|---|
| **Raw Landlock / plain `docker run`** | **Yes — 4 flags** | none | ~zero |
| **K8s admission (PSA/VAP/OPA/Kyverno)** | Yes, at pod granularity, one layer removed | API-request log only, not tamper-evident | ~zero *if already run* |
| **gVisor (runsc)** | Yes, mount-point subtree, fixed at creation | observational only | low (`apt install runsc`) |
| **Firecracker** | **No** — nothing inside the box | sectors/packets only | high (component, not platform) |
| **E2B** | **No** — permission surface is network-only | provider-held, short retention | architectural rewrite |
| **Modal / Daytona** | **No** — root on writable rootfs, no tier buys it | Modal: "container runtime activity is not audited" | execution-model rewrite |
| **MCP gateways / agent authz** | **No** — vocabulary is (identity × server × tool) | rich but not tamper-evident | **~zero, a URL swap** |

**The four adversarial replication verdicts that came back:**
- **Raw Landlock / docker flags: "Berth loses — on the core guarantee exactly as stated."**
- **E2B: "Berth loses on the substrate and survives only on positioning."**
- Modal/Daytona: Berth wins the literal guarantee, "but the founder should not read that as
  a moat."
- Firecracker: Berth wins, "but the win is narrower than the pitch."

Where Berth genuinely and defensibly wins, per those same agents: **multi-app least privilege
inside one box** (per-app uid, cross-app `kill(2)` EPERM, per-app secret scoping, sibling
socket denial), **verb/path-scoped API mediation**, **a capability grammar as a versioned
shared interface**, and **a per-run evidence artifact keyed to a run rather than an API
caller**. None of those is the filesystem story the README leads with.

---

## Part 2 — What still needs to be researched

### 2.1 Unfinished in the stopped workflow

| # | Open item | Why it matters |
|---|---|---|
| R1 | **The adversarial refute phase never ran** (7 differentiators × 3 hostile lenses = 21 agents) | This was the actual gate. We have 4 replication verdicts but no systematic test of which differentiators survive |
| R2 | **`docker + seccomp/AppArmor/SELinux` survey** did not return | The incumbent zero-cost answer; the one row most likely to beat Berth |
| R3 | **The synthesized `docs/why-not-existing-sandboxes.md` was never written** | Chunk 1's deliverable. Nothing was written to the repo |
| R4 | No completeness-critic pass | Unknown unknowns in the comparison |

Resumable: `Workflow({scriptPath: ".../berth-competitive-gate-wf_1a4957fb-642.js", resumeFromRunId: "wf_1a4957fb-642"})` — the 14 finished agents return from cache.

### 2.2 New research the findings created

| # | Question | Why now |
|---|---|---|
| R5 | **Is the hardcoded `ALLOWED_WRITE_PATH_PREFIXES` a design constraint or an accident?** Can the manifest be made the real boundary (arbitrary declared subtrees), and what breaks? | This single answer decides whether the core pitch is true or marketing. Everything else is secondary |
| R6 | **Is the unconditional `SYS_ADMIN` sidecar removable?** What does semantic-fs lose without FUSE? | The README makes a claim the boot contradicts. Either the boot changes or the claim does |
| R7 | **Can the audit rotation bug be fixed without breaking the chain contract?** | It is a confirmed functional bug in the flagship evidence feature |
| R8 | **What would a real root of trust cost?** (TPM/KMS signing, key custody separable from host) | Decides whether attestation can ever be compliance evidence or stays engineering tooling |
| R9 | **Who actually buys "multi-app least privilege inside one box"?** | This is where the agents said Berth genuinely wins — but it is not the current pitch, and no buyer has been identified |
| R10 | **Does the MCP-gateway category already own the repositioning?** Their adoption cost is a URL swap; Berth's is a runtime change | Directly threatens Chunk 2 and Chunk 5 |
| R11 | Fix the claims-inventory drift: `K22`/`B16` cited but absent from this checkout | The evidence discipline is the asset; a stale row damages it more than a missing feature |

### 2.3 Not yet started (from the plan)

Chunks 2–8 are all unstarted: reposition the message, daemons off by default, the
`experimental/` move, `berth wrap`, the platform decision, npm publish (blocked on D5),
design partners. Chunk 3's *investigation* is now done (see 1.3) but no code has changed.

### 2.4 Decisions still open

**D1** Mac vs Linux/CI · **D2** freeze in-tree vs separate repo · **D3** publish timing ·
**D4** design-partner names · **D5** npm scope rename. Plus one the research forced:

**D6 — [revised after the correction above] The thesis survives.** The manifest *is* the
boundary, with real sub-path granularity, inside four permitted roots. So "make the thesis
true" (R5) is largely unnecessary — it is already true, and R5 reduces to the optional
question of whether a custom mount root is ever needed. What still needs deciding is
narrower: whether to keep leading with the filesystem story (defensible, but its nearest
competitor is cheap) or to lead with the things no competitor has at all — multi-app least
privilege inside one box, verb-scoped API mediation, per-run evidence.

---

## The honest one-line summary

**[revised]** The kernel thesis holds up better than the first pass of research claimed — the
manifest really is the boundary, with genuine sub-path granularity. What does not hold up is
a specific set of fixable defects around it: `network:connect:*` silently disabling the
kernel network boundary, an unconditional `CAP_SYS_ADMIN` sidecar that contradicts the
README, an attestation cache one `sed` away from forging half an `ACTIVE` verdict, and an
audit chain that self-breaks on normal log rotation. None of those is thesis-fatal; all are
credibility-fatal while they ship undocumented. Fix them, then argue positioning.

**Process note worth keeping:** one adversarial agent produced a confident, well-cited
headline that direct code reading falsified. Its supporting detail was accurate; its
conclusion inverted the facts. Verify before acting on a finding like that — this file has
been corrected in place rather than rewritten, so the error stays visible.
