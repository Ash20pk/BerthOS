# Berth

Berth is the operating system and framework that treats the AI agent as the primary user — and humans as administrators.

> Agents are not functions. They are workers. Workers need desks.

Berth gives an agent a real, isolated computer to work in — a filesystem, a browser, installable tools, persistent state — instead of a bag of API calls. Developers build **resident apps**: persistent, stateful processes that live on the agent's computer, declare capability-scoped permissions, and collaborate through a shared context bus.

This repository currently implements **Phase 1 — Framework Shell** (CLI, resident app SDK, manifest format, a Docker-based stand-in for the Agent OS), **Phase 2 — Context Bus** (a Rust daemon giving resident apps shared semantic memory, so they react to each other without explicit orchestration), **Phase 3 — Capability Tokens** (a custom init, `agent-init`, applying a kernel-enforced Landlock policy derived from `berth.yml` before any resident app runs), **Phase 4 — Semantic FS** (a Go/FUSE daemon giving resident apps a filesystem queryable by intent, not just path), and **Phase 5 — App Ecosystem** (a local app registry for publish/discover/install, and a self-contained `@berth/sdk` build genuinely external developers can depend on). See [manifest reference](./docs/manifest-reference.md), [context bus reference](./docs/context-bus-reference.md), [capability tokens reference](./docs/capability-tokens-reference.md), [semantic FS reference](./docs/semantic-fs-reference.md), [app registry reference](./docs/app-registry-reference.md), and [multi-app sandbox reference](./docs/multi-app-reference.md) (multiple resident apps sharing one sandbox, each with real independent Landlock enforcement, via `--apps`) for details.

## Quickstart

```bash
corepack enable
pnpm install
pnpm build

cd examples/hello-world
pnpm exec berth dev
```

See [docs/getting-started.md](./docs/getting-started.md) for the full walkthrough, including the browser-native example app with a live VNC view.

## Repository layout

```
packages/
  manifest-schema/     berth.yml schema, validation, capability parsing
  sdk/                 resident app SDK — defineApp(), lifecycle hooks, context bus client
  docker-orchestrator/ Alpine-based "OS stand-in" container lifecycle
  context-bus-daemon/  Rust daemon — shared semantic memory for apps in one sandbox
  agent-init/          Rust — applies a kernel-enforced (Landlock) capability policy before exec-ing the runtime
  semantic-fs-daemon/  Go/FUSE daemon — filesystem queryable by intent, backed by a SQLite metadata index
  registry-server/     local app registry — publish/discover/install (Fastify + SQLite)
  grants-server/       human-approval service for capability grants (Fastify + SQLite)
  adapters/            deploy adapters (E2B, Daytona, Kubernetes)
  cli/                 the `berth` CLI (init, dev, test, publish, deploy)
  sdk-python/          Python resident-app SDK — wire-protocol-compatible with @berth/sdk
apps/
  browser-native/      first-party resident app — headless Chromium + VNC
  filesystem/          first-party resident app — reads/writes /workspace, publishes fs.file_created
  code-editor/         first-party resident app — reacts to fs.file_created via the context bus
  github-assistant/    first-party resident app — the PRD's example manifest, deployed and milestone-tested
  hello-world-py/      minimal Python resident app — proves the Python SDK's RPC wire compatibility
examples/
  hello-world/         minimal resident app
```

## Status

All 5 phases of the roadmap are implemented. Phase 3's Landlock-based enforcement (write-path always, read-path and network ports opt-in when declared) is confirmed via CI on a real Linux kernel (`.github/workflows/capability-enforcement.yml`) — it cannot be verified on this repo's own dev machine (Docker Desktop for Mac's kernel doesn't have Landlock active in its LSM stack). Phase 3's human-approval workflow (`@berth/grants-server` + `berth grants list/approve/deny`) is also implemented, opt-in via `--grants-server=<url>` — approval takes effect on an app's next restart, not live, since Landlock rulesets can't be widened once applied. See [capability tokens reference](./docs/capability-tokens-reference.md) for the CI verification gap and what's still deferred (domain-scoped network filtering, per-syscall audit logging). Phase 5's registry is a local, single-node implementation (no hosted service, no billing/usage metering — the PRD's "first external revenue" metric isn't in scope here) — see [app registry reference](./docs/app-registry-reference.md).

Post-Phase-5: `berth mcp --app=<name>` bridges a local dev container's declared exports to real MCP tools for any MCP client — see [MCP bridge reference](./docs/mcp-bridge-reference.md) for what's real vs. deferred (auth, remote/fleet-hosted apps, multi-app aggregation).

Post-Phase-5: `--fleet=k8s` deploys to a real Kubernetes cluster via `@berth/adapter-k8s` (the PRD lists K8s as an infra backend but never assigns it a build phase) — see [K8s adapter reference](./docs/k8s-adapter-reference.md) for the FUSE/Pod-Security-Admission caveat and what's deferred (registry-push auth).

Post-Phase-5: path/verb-level GitHub API scoping (`github:read:<scope>` vs `github:write:<scope>`) is enforced via a real TLS-terminating broker (`github-api-broker.cjs`) — see [GitHub API scoping reference](./docs/github-api-scoping-reference.md) for how it wires into `apps/github-assistant` and what's deferred (multi-app containers, a general path/verb grammar beyond GitHub).

Post-Phase-5: `berth snapshot create/restore/list` is a real (not simulated) MVP of the PRD's "Computer Snapshots" primitive — a genuine `docker commit()` + semantic-fs context-data archive round trip, not a build-phase item in the PRD itself. See [computer snapshots reference](./docs/computer-snapshots-reference.md) for what's deferred (browser tabs/sessions, active tokens, fork-and-run-in-parallel).

Post-Phase-5: `packages/sdk-python` is a real second-language SDK, wire-protocol-compatible with `@berth/sdk` (same manifest shape, same RPC framing, and — Slice 2 — the same context-bus daemon via a compiled-protobuf client) — proven by real container boots, a real RPC round trip, and a real cross-language pub/sub round trip (a Python app publishing, a TypeScript app reacting), not unit tests in isolation. See [Python SDK reference](./docs/sdk-python-reference.md) and [Python SDK context-bus reference](./docs/sdk-python-context-bus-reference.md) for what's reused vs. rewritten, and what's still deferred (multi-app wiring, production images).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
