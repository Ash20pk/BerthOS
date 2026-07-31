# Berth

Berth is the operating system and framework that treats the AI agent as the primary user — and humans as administrators.

> Agents are not functions. They are workers. Workers need desks.

Berth gives an agent a real, isolated computer to work in — a filesystem, a browser, installable tools, persistent state — instead of a bag of API calls. Developers build **resident apps**: persistent, stateful processes that live on the agent's computer, declare capability-scoped permissions, and collaborate through a shared context bus.

This repository currently implements **Phase 1 — Framework Shell** (CLI, resident app SDK, manifest format, a Docker-based stand-in for the Agent OS), **Phase 2 — Context Bus** (a Rust daemon giving resident apps shared semantic memory, so they react to each other without explicit orchestration), and **Phase 3 — Capability Tokens** (a custom init, `agent-init`, applying a kernel-enforced Landlock policy derived from `berth.yml` before any resident app runs). See [manifest reference](./docs/manifest-reference.md), [context bus reference](./docs/context-bus-reference.md), and [capability tokens reference](./docs/capability-tokens-reference.md) for details.

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
  adapters/            deploy adapters (E2B, Daytona)
  cli/                 the `berth` CLI (init, dev, test, publish, deploy)
apps/
  browser-native/      first-party resident app — headless Chromium + VNC
  filesystem/          first-party resident app — reads/writes /workspace, publishes fs.file_created
  code-editor/         first-party resident app — reacts to fs.file_created via the context bus
examples/
  hello-world/         minimal resident app
  github-assistant/     the PRD's example manifest, made runnable
```

## Status

Phases 1–3 of 5. Semantic filesystem (Phase 4) and the app registry (Phase 5) are designed for but not yet implemented. Phase 3's Landlock-based enforcement is implemented and runs correctly end-to-end, but hasn't been verified to actually deny a disallowed write on this repo's dev machine (Docker Desktop for Mac's kernel doesn't have Landlock active in its LSM stack) — see [capability tokens reference](./docs/capability-tokens-reference.md) before relying on it in production.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
