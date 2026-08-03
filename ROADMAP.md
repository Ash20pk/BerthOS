# Roadmap

Berth was built against an original 5-phase plan. All five phases have at least an initial, milestone-tested implementation today, plus several things beyond the original scope. This page is the one place to check "is X real yet" instead of piecing it together from commit history.

"Milestone-tested" below means there's a Docker-backed integration test (`packages/*/test/*-milestone.mjs`) wired into its own CI workflow under `.github/workflows/`, not just a unit test. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to run them locally.

## Original 5 phases — all shipped, varying depth

| Phase | What it is | Status |
|---|---|---|
| 1 | Base runtime: `berth init` → `berth dev`, resident app model, manifest schema | Shipped. This is the pilot workflow — see the [Workflow feedback](./.github/ISSUE_TEMPLATE/workflow_feedback.md) template if you hit friction here |
| 2 | Context bus: pub/sub between resident apps in one Berth OS | Shipped, milestone-tested. [docs/context-bus-reference.md](./docs/context-bus-reference.md) lists known Phase 2 scope limits |
| 3 | Capability tokens: kernel-enforced (Landlock) permissions, denied by default | Shipped, milestone-tested — **with a caveat**: Landlock enforcement needs a real Linux LSM stack. Docker Desktop for Mac's linuxkit VM doesn't have it active, so a green local run isn't proof of enforcement. Read [docs/capability-tokens-reference.md](./docs/capability-tokens-reference.md)'s verification section before trusting this in any environment you haven't checked `cat /sys/kernel/security/lsm` in |
| 4 | Semantic filesystem: query `/context` by intent, not just by path | Shipped, milestone-tested |
| 5 | App registry: publish/discover/install resident apps (`berth publish`) | Shipped, milestone-tested. Not yet paired with a public hosted registry — `berth publish --registry=<url>` targets a registry you run yourself today |

## Beyond the original plan

Built after the initial 5 phases, each with its own milestone test and CI workflow:

- **WireGuard mesh networking** (`network:peer:<name>`) — real mesh, not simulated, coordinated by `mesh-coordinator` and reconciled by `mesh-daemon`
- **Egress broker** — scoped outbound HTTP/browser access by hostname pattern, at the host level
- **Grants server** — human-in-the-loop approval for capability requests, instead of just declare-and-deny
- **Governance gate** — any app declaring `governs: true` can review other apps' tool calls before they execute
- **Snapshot / restore** — checkpoint a whole Berth OS (files, semantic-fs tags, context) and restore it, including after a hard crash
- **Deploy adapters** — E2B, Daytona, and Kubernetes, behind one `DeployAdapter` interface
- **MCP bridge** (`berth mcp`) — expose a resident app's exports as MCP tools
- **Python SDK** — wire-compatible with the TypeScript SDK
- **`@berth/agents`** — the agent-facing layer (`Computer`, `createAgent`, `runAgent`, `Crew`)
- **`berth os up`/`down`/`status`** — long-lived Berth OS with instant reconnect, instead of a fresh boot every dev-loop iteration

## Known gaps

- Nothing under `@berth/*` is published to npm yet. Today you build from source (see [Quickstart](./README.md#quickstart)).
- Landlock verification has a real gap outside a genuine Linux LSM environment — see Phase 3 above. CI runs on `ubuntu-latest`, which has it; your local Docker Desktop on Mac likely doesn't.
- No hosted/public app registry — `berth publish` targets a self-run instance.
- Single maintainer, so review latency varies — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Where contributions help most right now

Resident apps. The core (phases 1–5 plus the extensions above) is deliberately more built-out than the app catalog on top of it. See [CONTRIBUTING.md's wishlist](./CONTRIBUTING.md#resident-apps-wed-love-to-see) for concrete starting points.
