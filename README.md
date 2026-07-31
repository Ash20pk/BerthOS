# Berth

Berth is the operating system and framework that treats the AI agent as the primary user — and humans as administrators.

> Agents are not functions. They are workers. Workers need desks.

Berth gives an agent a real, isolated computer to work in — a filesystem, a browser, installable tools, persistent state — instead of a bag of API calls. Developers build **resident apps**: persistent, stateful processes that live on the agent's computer, declare capability-scoped permissions, and collaborate through a shared context bus.

This repository currently implements **Phase 1 — Framework Shell**: the CLI, resident app SDK, manifest format, and a Docker-based stand-in for the Agent OS. See [the PRD](./docs) and [manifest reference](./docs/manifest-reference.md) for the full roadmap.

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
  adapters/            deploy adapters (E2B, Daytona)
  cli/                 the `berth` CLI (init, dev, test, publish, deploy)
apps/
  browser-native/      first-party resident app — headless Chromium + VNC
examples/
  hello-world/         minimal resident app
  github-assistant/     the PRD's example manifest, made runnable
```

## Status

Phase 1 of 5. Context bus (Phase 2), kernel-enforced capability tokens (Phase 3), semantic filesystem (Phase 4), and the app registry (Phase 5) are designed for but not yet implemented — see the interfaces in `packages/sdk/src/context-bus` and `packages/manifest-schema/src/capability.ts` for the seams they'll plug into.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
