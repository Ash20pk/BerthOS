# Berth

Berth is the operating system and framework that treats the AI agent as the primary user — and humans as administrators.

> Agents are not functions. They are workers. Workers need desks.

Berth gives an agent a real, isolated computer to work in — a filesystem, a browser, installable tools, persistent state — instead of a bag of API calls. You build **resident apps**: persistent, stateful processes that live on the agent's computer, declare capability-scoped permissions, and collaborate with each other through a shared context bus.

This README is written for developers building on Berth. If you're looking for roadmap/phase status instead, see [Status](#status) below.

## Prerequisites

- Node.js 22+ (`nvm use` picks up `.nvmrc`)
- Docker, running locally
- `corepack enable` (ships with Node 22, manages pnpm for you)

## Install and build

```bash
git clone <this-repo>
cd agentOS
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package in dependency order via Turborepo — `@berth/manifest-schema` first, then `@berth/sdk`, `@berth/docker-orchestrator`, the deploy adapters, and finally `@berth/cli`.

## Run an example

```bash
cd examples/hello-world
pnpm exec berth dev
```

```
Building dev image for "hello-world"...
Container started. Watching .../examples/hello-world/src and berth.yml for changes...
[berth:dev] "hello-world" declares no browser:* capability — no VNC/CDP ports exposed
[berth:dev] [berth:runtime] "hello-world" ready
```

Edit `src/index.ts` and save — the container restarts automatically (`on_install` hooks are skipped on warm restarts, so this is fast).

Want a live browser you can watch? `apps/browser-native` declares `browser:navigate:*`, so `berth dev` there prints a noVNC URL you can open in a tab to watch the sandboxed Chromium instance live:

```bash
cd apps/browser-native
pnpm exec berth dev
```

## Scaffold your own app

```bash
pnpm exec berth init my-app
cd my-app
pnpm exec berth dev
```

`berth init` prompts for a name and a starting template (`hello-world` or `browser-native`), scaffolds `berth.yml` + SDK boilerplate, runs `pnpm install`, and validates the manifest before handing control back to you. Pass `--template` to skip the prompt.

## Anatomy of a resident app

Every app has two things at its root: a `berth.yml` manifest and an entry file that calls `defineApp()`.

**`berth.yml`** — what the app is called, what it's allowed to do, and what it exposes:

```yaml
name: hello-world
version: 0.1.0

capabilities: []

exports:
  - name: ping
    output: { message: string }

on_install: []
on_agent_ready:
  - "register_with_context_bus"
```

**`src/index.ts`** — the code behind those exports:

```ts
import { defineApp } from "@berth/sdk";
import { z } from "zod";

export default defineApp((app) => {
  app.export({
    name: "ping",
    output: z.object({ message: z.string() }),
    handler: () => ({ message: "pong" }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "hello-world" });
  });
});
```

A few things that will bite you if you skip them:

- **Exports must match on both sides.** Every `app.export({ name })` call needs a matching entry in `berth.yml`'s `exports:` list, and vice versa — a mismatch is a hard boot failure, not a warning.
- **Capabilities are declared up front.** `capabilities:` is a list of `namespace:action:scope` strings (`filesystem:write:/workspace`, `browser:navigate:*.github.com`, `network:connect:8090`). The kernel enforces this list via Landlock before your app's code ever runs — see [capability tokens reference](./docs/capability-tokens-reference.md). Undeclared capabilities are denied, not just unenforced.
- **`on_install` vs `app.onInstall(fn)`.** Use `on_install` in `berth.yml` for shell setup (`pip install -r requirements.txt`); use the SDK's `onInstall` for setup that's easier to express in TypeScript. Both run once per cold build, skipped on warm dev restarts.
- **Network is deny-by-default.** If your app needs to reach the outside world, route it through the egress broker rather than requesting a wide-open `network:connect:*` — see [egress broker reference](./docs/egress-broker-reference.md) and `apps/browser-native`'s `berth.yml` for the pattern.

Full manifest schema: [docs/manifest-reference.md](./docs/manifest-reference.md). Full SDK surface (`defineApp`, `ContextBusClient`, `SemanticFsClient`, `requestCapability`): [docs/sdk-reference.md](./docs/sdk-reference.md). Building in Python instead of TypeScript: [docs/sdk-python-reference.md](./docs/sdk-python-reference.md).

## Talking to other apps

Apps in the same sandbox share two things, both reachable from `AppContext` in `onAgentReady`:

- **Context bus** (`ctx.contextBus`) — `register`, `publish(topic, payload)`, `subscribe(topic, handler)`. A Rust daemon gives you real pub/sub between apps without explicit orchestration — one app writes a file, another reacts to `fs.file_created` without either knowing the other exists. See [docs/context-bus-reference.md](./docs/context-bus-reference.md).
- **Semantic FS** (`ctx.semanticFs`) — `register`, `tag(path, meta)`, `query(text, limit)`. A filesystem mounted at `$BERTH_CONTEXT_MOUNT` (default `/context`) that's queryable by intent, not just path — write a file, tag it with `task`/`relatedApps`, and any app can find it later by describing what it needs. See [docs/semantic-fs-reference.md](./docs/semantic-fs-reference.md).

`apps/filesystem` and `apps/code-editor` are a working example of this: the former publishes `fs.file_created`, the latter reacts to it.

Want more than one app in a single sandbox, each still under independent Landlock enforcement? See [docs/multi-app-reference.md](./docs/multi-app-reference.md) and pass `--apps` to `berth dev`.

## Building an agent on top

Most frameworks wire `agent -> tool`. `@berth/agents` inverts it: `computer -> agent -> tool` — boot a real sandbox loaded with resident apps, and every export becomes a tool for any LLM provider you plug in:

```ts
import { createAgent, createAnthropicProvider } from "@berth/agents";

const { agent, computer } = await createAgent({
  apps: ["apps/filesystem"],
  llm: createAnthropicProvider(), // or createOpenAIProvider(), or your own LLMProvider
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

`Crew.withManager()`/`Crew.sequential()` compose multiple agents; `Crew.networked()` composes agents running on entirely separate computers, joined over a real Docker network. See [docs/agents-reference.md](./docs/agents-reference.md).

## CLI reference

| Command | What it does |
|---|---|
| `berth init <name>` | Scaffold a new resident app from a template |
| `berth dev` | Build a dev image, run it, hot-reload on source changes |
| `berth test` | Build the production image, validate exports against `berth.yml`, invoke each with a schema-valid stub, run your own `npm test` |
| `berth deploy --fleet=<e2b\|daytona\|k8s>` | Deploy to a remote sandbox provider |
| `berth logs <app>` | Stream logs from an already-running dev or fleet container |
| `berth rpc <app> --export=<name> --input=<json>` | Call a resident app's export directly from the host |
| `berth mcp --app=<name>` | Bridge a running app's exports to MCP tools, for Claude Desktop/Code or any MCP client |
| `berth publish --registry=<url>` | Build and publish the app to a running app registry |
| `berth snapshot create\|list\|restore` | Checkpoint and restore a container + its semantic-fs context data |
| `berth grants list\|approve\|deny` | Review and resolve pending human-approval capability requests |
| `berth fleet status` | Check the state of a configured remote fleet |

Run `berth <command> --help` for flags. Docs for the less obvious ones: [MCP bridge](./docs/mcp-bridge-reference.md), [app registry](./docs/app-registry-reference.md), [computer snapshots](./docs/computer-snapshots-reference.md), [capability tokens / grants](./docs/capability-tokens-reference.md), [K8s adapter](./docs/k8s-adapter-reference.md).

## Testing and deploying

```bash
pnpm exec berth test              # build prod image, validate exports, run stub invocations + your own tests
pnpm exec berth test --json       # CI-friendly output

berth deploy --fleet=e2b          # or --fleet=daytona, --fleet=k8s, or an alias from ~/.berthrc
```

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
  agents/              computer -> agent -> tool — boots a Computer from resident apps, drives it with any LLM provider, composes multi-agent Crews
apps/
  browser-native/      first-party resident app — headless Chromium + VNC
  filesystem/          first-party resident app — reads/writes /workspace, publishes fs.file_created
  code-editor/         first-party resident app — reacts to fs.file_created via the context bus
  github-assistant/    first-party resident app — the PRD's example manifest, deployed and milestone-tested
  hello-world-py/      minimal Python resident app — proves the Python SDK's RPC wire compatibility
  terminal/            first-party resident app — a full shell for the OS, run_command executes arbitrary commands via bash
  activity-feed/       first-party resident app — zero-capability, reacts to notes.added/notes.completed over the context bus
  notes/               first-party resident app — stateful notes (add/list/complete), persisted to /workspace
examples/
  hello-world/         minimal resident app
```

## Something not working?

File a [bug report](./.github/ISSUE_TEMPLATE/bug_report.md) or [workflow feedback](./.github/ISSUE_TEMPLATE/workflow_feedback.md) — "what was confusing" reports are exactly what we need right now.

## Status

All 5 phases of the roadmap are implemented: **Phase 1 — Framework Shell** (CLI, resident app SDK, manifest format, Docker-based OS stand-in), **Phase 2 — Context Bus**, **Phase 3 — Capability Tokens** (kernel-enforced Landlock policy derived from `berth.yml`), **Phase 4 — Semantic FS**, and **Phase 5 — App Ecosystem** (local registry + a self-contained `@berth/sdk` build external developers can depend on).

Things worth knowing before you build on this:

- Landlock enforcement (write-path always, read-path and network ports opt-in when declared) is verified in CI on a real Linux kernel — it cannot be verified on this repo's own dev machine (Docker Desktop for Mac's kernel doesn't expose Landlock). See [capability tokens reference](./docs/capability-tokens-reference.md) for the CI gap and what's deferred (domain-scoped network filtering, per-syscall audit logging).
- The human-approval workflow (`berth grants list/approve/deny`, opt-in via `--grants-server=<url>`) takes effect on an app's next restart, not live — Landlock rulesets can't be widened once applied.
- The app registry ([reference](./docs/app-registry-reference.md)) is local/single-node — no hosted service, no billing/usage metering.
- Post-Phase-5 additions, each with a reference doc covering what's real vs. deferred: [MCP bridge](./docs/mcp-bridge-reference.md), [K8s fleet adapter](./docs/k8s-adapter-reference.md), [GitHub API scoping](./docs/github-api-scoping-reference.md), [computer snapshots](./docs/computer-snapshots-reference.md), [Python SDK](./docs/sdk-python-reference.md) and its [context-bus support](./docs/sdk-python-context-bus-reference.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
