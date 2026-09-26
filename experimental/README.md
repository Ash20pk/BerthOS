# `experimental/` — frozen, not abandoned

Everything in this directory works, is tested, and still runs in CI. It is here
because it is **not part of the core artifact**, not because it is broken.

The core artifact is the substrate: a `berth.yml` capability manifest compiled
into a kernel-enforced Landlock/seccomp policy applied before an app's first
line runs, plus the evidence that it happened — the hash-chained audit trail and
the per-run attestation. That is `packages/`:

```
packages/
  agent-init/           the Rust process that applies the policy — the product
  manifest-schema/      the berth.yml grammar and capability parsing
  sdk/                  the resident-app SDK, and the policy compiler
  docker-orchestrator/  container lifecycle, brokers, boot evidence
  audit/                the hash chain and the attestation record
  tls/                  certificate plumbing the brokers need
  cli/                  berth dev / mcp / doctor / attest / os / snapshot
  context-bus-daemon/   Rust, image-embedded
  semantic-fs-daemon/   Go, image-embedded (off with BERTH_NO_SEMANTIC_FS=1)
  mesh-daemon/          Rust, image-embedded (starts only for network:peer:)
  sdk-python/           the resident-app SDK in Python — same substrate role
```

## Why these are here

`@berthos/cli` used to depend on `@berthos/agents` and on all three cloud adapters
at runtime. Installing the thing that holds the kernel boundary therefore pulled
in an LLM framework, three provider SDKs, and their transitive trees — the
substrate depending on the layers above it. Both are now optional peers loaded
on demand, and the packages themselves live here.

| Package | What it is | Why it is not core |
|---|---|---|
| `agents` | A full agent framework: providers, Agent, Crew, sessions, guardrails, tracing, A2A, MCP client, evals | Competes with LangGraph and the vendor agent SDKs on their own ground. Berth's claim is what its tools are *made of*, so adopting a framework should never be the price of reaching the boundary |
| `agents-python` | Python parity for the above | Same, doubled |
| `adapters/*` | Deploy adapters for E2B, Daytona, Kubernetes, plus their shared core | Each carries a cloud SDK. A CLI used for local sandboxing needs none of them |
| `grants-server` | Human-approval service for capability grants | Moves with `agents`, which is its only consumer |
| `registry-server` | Local app registry: publish, discover, install | No demand demonstrated yet |
| `mesh-coordinator` | Mutual-consent coordination for the WireGuard mesh | The mesh is opt-in and unproven; `mesh-daemon` stays image-embedded but starts only for an app declaring `network:peer:` |
| `seam-*` | Adapters exposing Berth tools to the Claude Agent SDK and OpenAI Agents | Thin, useful, and not load-bearing |

## What "frozen" means here, precisely

- **Still built, still linted, still tested.** These are workspace members; `pnpm
  build`, `pnpm lint` and `pnpm test` cover them exactly as before.
- **Their milestone workflows still run.** `agents-milestone`,
  `k8s-adapter-milestone`, `http-rpc-bridge-milestone` and the Python ones were
  repointed at these paths, not disabled. Freezing a subsystem means its tests
  keep proving it; it means they should no longer *gate* the core.
- **Nothing was deleted.** Reversing any of this is a `git mv`.
- **Publishability is unchanged by the move.** Whether these ship to npm is a
  separate decision (see `EXECUTION_PLAN.md`, Chunk 7 and decision D3).

## If you depend on one of these

Nothing changed for you. The package names are the same, the APIs are the same,
and they are still workspace members. `npm install @berthos/agents` alongside
`@berthos/cli` is now an explicit step rather than something that happened to you.
