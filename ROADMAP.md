# Roadmap

> **Which document is authoritative for what.** `REMEDIATION.md` — defects: what
> is broken, the evidence, and what would prove it closed. `LAUNCH_PLAN.md` —
> execution order: which of those defects gate a launch and in what sequence.
> `PRIORITIES.md` — an opinionated filter over REMEDIATION, kept for its
> reasoning; superseded on *ordering* by LAUNCH_PLAN. `ROADMAP.md` — the public
> "is X real yet" page. `gaps.md` — **archived**; it validated that the substrate
> is usable from a framework, and is not a roadmap.

Berth was built against an original 5-phase plan. All five phases have at least an initial, milestone-tested implementation today, plus several things beyond the original scope. This page is the one place to check "is X real yet" instead of piecing it together from commit history.

"Milestone-tested" below means there's a Docker-backed integration test (`packages/*/test/*-milestone.mjs`) wired into its own CI workflow under `.github/workflows/`, not just a unit test. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to run them locally.

## Original 5 phases — all shipped, varying depth

| Phase | What it is | Status |
|---|---|---|
| 1 | Base runtime: `berth init` → `berth dev`, resident app model, manifest schema | Shipped. This is the pilot workflow — see the [Workflow feedback](./.github/ISSUE_TEMPLATE/workflow_feedback.md) template if you hit friction here |
| 2 | Context bus: pub/sub between resident apps in one Berth OS | Shipped, milestone-tested. [docs/context-bus-reference.md](./docs/context-bus-reference.md) lists known Phase 2 scope limits |
| 3 | Capability tokens: kernel-enforced (Landlock) permissions, denied by default | Shipped, milestone-tested — **with a caveat**: Landlock enforcement needs a real Linux LSM stack. Docker Desktop for Mac's linuxkit VM doesn't have it active, so a green local run isn't proof of enforcement. Read [docs/capability-tokens-reference.md](./docs/capability-tokens-reference.md)'s verification section before trusting this in any environment you haven't checked `cat /sys/kernel/security/lsm` in |
| 4 | Semantic filesystem: search `/context` by what a file is *for*, not just by path | Shipped, milestone-tested — the search ranks over the `task`/`relatedApps`/`path` text you tag a file with, not over file content, and does a full table scan per query. [docs/semantic-fs-reference.md](./docs/semantic-fs-reference.md#query-semantics--hybrid-keyword--embedding-similarity) states both limits |
| 5 | App registry: publish/discover/install resident apps (`berth publish`) | Shipped. `packages/cli/test/registry-milestone.mjs` is a real integration test, but unlike the phases above, it isn't wired into any `.github/workflows/*.yml` — it doesn't run in CI yet. Not yet paired with a public hosted registry either — `berth publish --registry=<url>` targets a registry you run yourself today |

## Beyond the original plan

Built after the initial 5 phases. Most have their own milestone test and CI workflow; one exception is called out below.

- **WireGuard mesh networking** (`network:peer:<name>`) — real mesh, not simulated, coordinated by `mesh-coordinator` and reconciled by `mesh-daemon`. A crash-resilience test (`mesh-coordinator-resilience-milestone.mjs`, proves the tunnel survives a coordinator SIGKILL) is CI-wired too, sharing `.github/workflows/mesh-milestone.yml` with the main mesh test rather than getting its own workflow
- **Egress broker** — scoped outbound HTTP/browser access by hostname pattern, at the host level
- **Grants server** — human-in-the-loop approval for capability requests, instead of just declare-and-deny
- **Governance gate** — any app declaring `governs: true` can review other apps' tool calls before they execute
- **Snapshot / restore** — checkpoint a whole Berth OS (files, semantic-fs tags, context) and restore it, including after a hard crash (`snapshot-crash-milestone.mjs` kills the container with a real `SIGKILL` mid-write)
- **Deploy adapters** — E2B, Daytona, and Kubernetes, behind one `DeployAdapter` interface
- **MCP bridge** (`berth mcp`) — expose a resident app's exports as MCP tools
- **Python SDK** — wire-compatible with the TypeScript SDK
- **`@berth/agents`** — the agent-facing layer (`Computer`, `createAgent`, `runAgent`, `Crew`). `Computer`'s milestone tests run in CI credential-free; `Crew`'s (`crew-manager-`, `crew-networked-`, `provider-swap-milestone.mjs`) need real LLM API keys and are intentionally not run there — see `docs/agents-reference.md`
- **`bootNetworkedAgent({fleet})`** — a `Crew.networked()` peer deployed to a remote E2B/Daytona/K8s instance instead of a local Docker container, dispatched over a new per-boot-authenticated HTTP RPC bridge (`@berth/sdk`'s `startHttpRpcServer`) rather than the mesh or the local Docker-network path. Protocol-level and mocked-adapter coverage only, no live-account or `kind`-cluster milestone test yet — see `docs/agents-reference.md`'s "Networked Crew over a remote fleet" section for exactly what's verified versus reasoned-but-untested
- **Framework interop** (`toAiSdkTools`, `toLangChainTools`, `toToolSpecs`) — a booted Computer's tools handed to the Vercel AI SDK, LangChain/LangGraph, or any other loop, so Berth's sandbox is reachable without adopting `@berth/agents`. Both libraries are optional peer dependencies imported dynamically; both adapters are unit-tested against the real package, and the AI SDK one drives a full `generateText` tool-calling loop. `berth mcp` covers the out-of-process case
- **`berth os up`/`down`/`status`** — long-lived Berth OS with instant reconnect, instead of a fresh boot every dev-loop iteration. No milestone test or CI workflow exists for this one yet, unlike the rest of this list

## Known gaps

- Nothing under `@berth/*` is published to npm yet. Today you build from source (see [Quickstart](./README.md#quickstart)).
- Landlock verification has a real gap outside a genuine Linux LSM environment — see Phase 3 above. CI runs on `ubuntu-latest`, which has it; your local Docker Desktop on Mac likely doesn't.
- No hosted/public app registry — `berth publish` targets a self-run instance.
- Single maintainer, so review latency varies — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Where contributions help most right now

Resident apps. The core (phases 1–5 plus the extensions above) is deliberately more built-out than the app catalog on top of it. See [CONTRIBUTING.md's wishlist](./CONTRIBUTING.md#resident-apps-wed-love-to-see) for concrete starting points.
