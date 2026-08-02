# Berth

**Berth is a framework for building AI agents that get a real computer, not a bag of stateless API calls.** `createAgent()`/`runAgent()` give your agent a persistent, permissioned, multi-app sandbox — a **Berth OS** — to act on, instead of you hand-wiring a Python subprocess or a raw sandbox VM yourself.

> Agents are not functions. They are workers. Workers need desks.

You don't boot into Berth, and nobody installs it as their laptop's OS. It's a library and CLI you `pnpm add`, same as you would any other agent framework — it just happens to give the agent it's driving a real, isolated computer to work on: a filesystem, a browser, installable tools, persistent state. We call that computer a **Berth OS**; see [What is a Berth OS?](#what-is-a-berth-os) below. You can extend what one can do by building your own **resident app** — see [Resident apps](#resident-apps) — but you don't have to: every first-party one (filesystem, browser, notes, terminal, ...) is ready to load into an agent from the moment you `pnpm add @berth/agents`.

This README is written for the person deciding whether to build on Berth. If you're already building and need the technical walkthrough, skip to [Quickstart](#quickstart).

## The problem

Most agent frameworks give you a loop and a tool registry. The actual "computer" the agent acts on is whatever you wire up yourself — a Python subprocess, a raw sandbox VM, a pile of API clients — and none of it persists, remembers what other tools did, or stops the agent from doing something you didn't intend.

That gap shows up as the same handful of problems on every team that ships an agent past a demo:

- **No permission boundary.** The agent either has full shell access or none. There's no middle ground like "this tool can write to `/workspace` and nothing else" that's actually enforced, rather than just requested nicely in a system prompt.
- **No persistence between runs.** Every session starts from zero. State the agent built up — files, notes, browser context — has to be re-derived or manually snapshotted and stitched back in.
- **No way for tools to know about each other.** A search tool and a file-writer tool that need to coordinate either get glued together by hand in your orchestration code, or don't coordinate at all.
- **No shared, watchable workspace.** When something goes wrong, you're reading logs after the fact instead of watching the agent's browser or terminal live.

Berth exists to make those four things load-bearing infrastructure instead of homework every team redoes.

## Why Berth

| | What you get |
|---|---|
| **One call to a working agent, instant reconnects while you iterate** | `runAgent({ apps: "apps/filesystem", task: "..." })` auto-detects your LLM provider and cleans up after itself — no boilerplate. `berth os up` boots the sandbox once; `connect: "<name>"` reattaches in milliseconds instead of rebuilding on every dev-loop run. |
| **Enforced permissions, not requested ones** | Every resident app declares `namespace:action:scope` capabilities in its manifest (`filesystem:write:/workspace`, `browser:navigate:*.github.com`). A Landlock policy, derived from that manifest, is applied to the process *before your code runs* — an undeclared write isn't caught by a try/catch, the syscall itself is refused by the kernel. |
| **State that survives the session** | A semantic filesystem (queryable by intent, not just path) plus `berth snapshot create/restore` mean an agent's work — files, tags, context — outlives any one run. |
| **Apps that talk to each other without you wiring it** | The context bus is pub/sub between resident apps in the same Berth OS. A filesystem app writes a file, a code-editor app reacts to it — neither one imports or calls the other. |
| **A workspace a human can watch, not just log-tail — and you decide per app** | In local `berth dev`, `apps/browser-native` exposes a live noVNC view of the sandboxed Chromium instance and `apps/terminal` exposes a live, typeable `ttyd` session — you watch the actual session, not a transcript of it. It's opt-out per app: set `expose: { browser: false }` / `{ terminal: false }` in `berth.yml` to keep the capability while running headless/unwatched (e.g. in CI). Not yet available when deployed to E2B/Daytona/K8s — see [Resident apps](#resident-apps). |
| **Bring your own LLM, own your deploy target** | `@berth/agents` wires any LLM provider (Anthropic, OpenAI, a custom endpoint via `{provider, apiKey, baseURL}`, or your own `LLMProvider`) to a Berth OS's resident apps as tools, and `berth deploy --fleet=e2b\|daytona\|k8s` ships the same sandbox definition to whichever provider you already run on. |

## How Berth compares

Berth isn't a replacement for a sandbox provider or an LLM orchestration library — it's the layer most teams end up hand-building on top of one or both. Here's where it sits relative to the tools people typically reach for first:

| | **Berth** | Orchestration frameworks (LangChain, CrewAI, AutoGen) | Raw sandbox providers (E2B, Daytona) used directly | Hosted agent platforms (OpenAI Assistants/Operator) |
|---|---|---|---|---|
| **Execution environment** | Real container per agent (a Berth OS), with resident apps as long-lived processes on it | None provided — you supply your own execution environment | A VM/container, but no app model on top of it | Fully hosted, opaque to you |
| **Permission model** | Kernel-enforced (Landlock) capability tokens, declared per app, denied by default | None built in — usually whatever access your glue code has | All-or-nothing root access inside the sandbox | Vendor-controlled, not configurable |
| **State across runs** | Persistent semantic FS + explicit snapshot/restore | Not built in — DIY vector store or memory object | Ephemeral by default; resets unless you build persistence yourself | Vendor-managed, limited control |
| **Inter-tool/app coordination** | Context bus (pub/sub) — apps react to each other with zero direct wiring | Manual — you wire tool outputs into the next call yourself | None — it's a shell, not an app model | None exposed |
| **Live human visibility** | Watch/join the same browser (VNC) or terminal (ttyd) session the agent is using, opt-out per app — local `berth dev` only today, not yet on deployed fleets | Not applicable — no environment to watch | Only if you build a viewer yourself | None |
| **Where it runs** | Local Docker for dev, then E2B / Daytona / Kubernetes for deploy — your choice | Wherever you host your own code | Whichever single provider you picked | Vendor's infrastructure only |
| **Self-hostable / open source** | Yes — Apache-2.0 | Usually yes | Yes (the sandbox itself) | No |

If you're already happy hand-rolling permissions, persistence, and inter-tool coordination on top of a raw sandbox, Berth mostly saves you from rebuilding that layer. If you're using an orchestration framework today, Berth is what you'd point it at instead of a bare subprocess or a single stateless sandbox call.

## Use cases

**A browser agent a human can babysit.** `apps/browser-native` gives an agent a real, sandboxed Chromium instance for research, QA, or form-filling — scoped to `browser:navigate:*.example.com` so it can't wander off-domain. In local `berth dev`, a support engineer can open the noVNC URL and watch (or take over) the exact session the agent is driving, instead of reconstructing what happened from a log; set `expose: { browser: false }` in `berth.yml` for the same agent running headless, e.g. in CI. (Deployed to E2B/Daytona/K8s, this app still runs and is still capability-scoped — there's just no watch URL yet.)

**A coding agent that reacts to its own file changes.** `apps/filesystem` and `apps/code-editor` show the pattern: the filesystem app writes a file and publishes `fs.file_created` on the context bus; the code-editor app picks it up and opens it — with zero direct calls between them. Wire in more resident apps (a linter, a test runner) the same way, and each new one only has to know the topic name, not every other app in the Berth OS.

**A support/ops agent with a real, watchable shell.** `apps/terminal` hands the agent a `tmux` session it drives with `run_command`/`read_screen`/`send_keys`. In local `berth dev`, a human can watch (and type into) that identical session live via `ttyd` — same `expose: { terminal: false }` opt-out as the browser case above when you don't want it reachable from the host. Good fit for anything where you want an on-call engineer able to step in mid-task rather than kill and restart the agent.

**An assistant that remembers between conversations.** `apps/notes` persists state to `/workspace` and publishes lifecycle events; `apps/activity-feed` fans those events (plus `fs.file_created`) into one queryable history. Paired with `berth snapshot create/restore`, an agent's working memory survives a container restart instead of resetting every session.

**A multi-agent crew split across isolated computers.** `Crew.networked()` runs each agent on its own Berth OS, joined over a real Docker network, so a "planner" agent and a "browser" agent can collaborate without sharing a filesystem or a Landlock policy — useful when you want a compromised or misbehaving agent's blast radius contained to its own sandbox. Local `berth dev` only today: `Computer.boot()` calls `@berth/docker-orchestrator` directly, so a networked crew doesn't yet run against a `berth deploy` fleet — see [agents reference](./docs/agents-reference.md). `apps/github-assistant` is a deployed, milestone-tested example of a single scoped agent (repo-read/issue-write, nothing wider) doing real work against the GitHub API through the [egress-scoped broker](./docs/github-api-scoping-reference.md).

## Quickstart

### Prerequisites

- Node.js 22+ (`nvm use` picks up `.nvmrc`)
- Docker, running locally
- `corepack enable` (ships with Node 22, manages pnpm for you)

### Install and build

```bash
git clone <this-repo>
cd agentOS
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package in dependency order via Turborepo — `@berth/manifest-schema` first, then `@berth/sdk`, `@berth/docker-orchestrator`, the deploy adapters, and finally `@berth/cli`.

### Run an agent

[`examples/agents/simple-agent`](./examples/agents/simple-agent) boots a Berth OS from `apps/filesystem` and runs one task against it — `llm` isn't even passed, it auto-detects whichever of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set:

```bash
cd examples/agents/simple-agent
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

That's `runAgent({ apps: "apps/filesystem", task: "..." })` under the hood — see [Building a Berth Agent](#building-a-berth-agent) for the full API, including the fuller form, multi-agent `Crew`s, and how to skip the boot cost entirely on every dev-loop run with `berth os up`.

### Run a resident app directly

Want to build or inspect a resident app on its own, without an agent attached — e.g. while authoring one? `berth dev` boots it with hot reload:

```bash
cd examples/resident-apps/hello-world
pnpm exec berth dev
```

```
Building dev image for "hello-world"...
Container started. Watching .../examples/resident-apps/hello-world/src and berth.yml for changes...
[berth:dev] "hello-world" declares no browser:* capability — no VNC/CDP ports exposed
[berth:dev] [berth:runtime] "hello-world" ready
```

Edit `src/index.ts` and save — the container restarts automatically (`on_install` hooks are skipped on warm restarts, so this is fast).

Want a live browser you can watch? `apps/browser-native` declares `browser:navigate:*`, so `berth dev` there prints a noVNC URL you can open in a tab to watch the sandboxed Chromium instance live:

```bash
cd apps/browser-native
pnpm exec berth dev
```

### Scaffold your own resident app

```bash
pnpm exec berth init my-app
cd my-app
pnpm exec berth dev
```

`berth init` prompts for a name and a starting template (`hello-world` or `browser-native`), scaffolds `berth.yml` + SDK boilerplate, runs `pnpm install`, and validates the manifest before handing control back to you. Pass `--template` to skip the prompt. See [Resident apps](#resident-apps) for the full anatomy of what gets scaffolded.

## Building a Berth Agent

Most frameworks wire `agent -> tool`. `@berth/agents` inverts it: `computer -> agent -> tool` — boot a Berth OS loaded with resident apps, and every export becomes a tool for any LLM provider you plug in. The dead-simple form needs nothing but an app directory and a task — `llm` auto-detects whichever of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set, and `runAgent()` boots, runs, and cleans up in one call:

```ts
import { runAgent } from "@berth/agents";

const result = await runAgent({
  apps: "apps/filesystem",
  task: "write a file called hello.txt with the text 'hi', then read it back",
});
```

The fuller form keeps the `Agent`/`Computer` handles around for more than one turn, and can hand `createAgent()` an already-built `Computer` (from `Computer.boot()`/`Computer.connect()`, letting one Berth OS back several agents at once):

```ts
import { createAgent, createAnthropicProvider } from "@berth/agents";

const { agent, computer } = await createAgent({
  apps: ["apps/filesystem"],
  llm: createAnthropicProvider(), // optional — omit to auto-detect, pass createOpenAIProvider()/your own LLMProvider, or a config object: { provider: "openai", apiKey, baseURL } for a custom/self-hosted endpoint
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

`Crew.withManager()`/`Crew.sequential()` compose multiple agents; `Crew.networked()` composes agents running on entirely separate Berth OS instances, joined over a real Docker network. See [docs/agents-reference.md](./docs/agents-reference.md).

### What is a Berth OS?

Every `runAgent()`/`createAgent()` call above needs somewhere for its tools to actually run — that's a **Berth OS**: a real, sandboxed computer (a Docker container today) loaded with one or more resident apps, each independently kernel-enforced, collaborating through a shared context bus and semantic filesystem. It's what the `Computer` class represents in code.

**Full explanation, separate from this README:** [docs/berth-os.md](./docs/berth-os.md) — what's actually inside one, and how it relates to a resident app.

**Cold start.** By default, every `createAgent()`/`runAgent()` call boots a fresh, throwaway Berth OS — real seconds of latency you feel on every single dev-loop iteration. `berth os up` pays that cost once, keeps the sandbox running, and lets agent code reconnect to it in milliseconds instead of rebuilding and rebooting:

```bash
berth os up my-agent --apps=apps/filesystem,apps/notes   # or --config=<path to a small YAML>
```

```ts
const result = await runAgent({ connect: "my-agent", task: "..." }); // reconnects instantly — no build, no boot
```

`berth os down my-agent` tears it down when you're done. See [docs/berth-os-reference.md](./docs/berth-os-reference.md) for the full command/API reference, including scoping one agent to a subset of a shared OS's loaded apps.

## Resident apps

A resident app is what you build to extend what a Berth OS can do — a persistent, stateful process, loaded from a directory containing a `berth.yml` manifest and code, that declares capability-scoped permissions and exposes exports that become an agent's tools. Every first-party one (`apps/filesystem`, `apps/browser-native`, `apps/notes`, ...) is built this same way — there's no special first-party-only mechanism.

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
- **Granting a capability isn't the same as exposing it.** Declaring `browser:navigate:*`/`terminal:attach:*` is what lets `berth dev` publish the noVNC/CDP or ttyd port to the host — add an `expose:` block to opt out per app (`expose: { browser: false }`) and keep the capability while running headless/unwatched. Both default to `true`. See [manifest reference](./docs/manifest-reference.md) — this only affects local `berth dev`; deploy targets don't publish these ports yet either way.
- **`on_install` vs `app.onInstall(fn)`.** Use `on_install` in `berth.yml` for shell setup (`pip install -r requirements.txt`); use the SDK's `onInstall` for setup that's easier to express in TypeScript. Both run once per cold build, skipped on warm dev restarts.
- **Network is deny-by-default.** If your app needs to reach the outside world, route it through the egress broker rather than requesting a wide-open `network:connect:*` — see [egress broker reference](./docs/egress-broker-reference.md) and `apps/browser-native`'s `berth.yml` for the pattern.

### Available capabilities

`namespace:action:scope` is an open grammar — you can declare a capability in a namespace nobody's used before, and `requestCapability()` will honestly report `granted: false` for it, since nothing backs it. The table below is what actually has real enforcement or brokering behind it today — the full list of permissions a resident app in a Berth OS can be given:

| Capability | Enforced by | Notes |
|---|---|---|
| `filesystem:write:<path>` (e.g. `filesystem:write:/workspace`) | Kernel (Landlock) — always on | Restricts write/create/delete/rename to the declared path(s) plus a `/tmp` baseline. Declare none and your app can still only write to `/tmp`. |
| `filesystem:read:<path>` (e.g. `filesystem:read:/context`) | Kernel (Landlock) — opt-in | Declaring at least one turns on read scoping: a fixed baseline (`/usr`, `/lib`, `/etc`, `/proc`, `/dev`, `/tmp`, your app's own working dir) plus whatever you declared. Declare none and reads stay fully open, unchanged. |
| `network:connect:<port>` or `network:connect:*` | Kernel (Landlock) — deny-by-default | No capability at all means zero outbound TCP, full stop. Scoping is by port only, not domain — `*` is an explicit, audited escape hatch for apps that need arbitrary hosts (e.g. `browser-native`). |
| `network:peer:<name>` or `network:peer:*` | `mesh-coordinator` (mutual consent) + a real WireGuard mesh | Joins the mesh with any other app whose own `network:peer:<pattern>` names this app back — a one-sided declaration is never introduced to its target. See [mesh reference](./docs/mesh-reference.md). |
| `browser:navigate:<pattern>` (e.g. `browser:navigate:*.github.com`) | Egress broker — host-level, not the kernel | The broker reads the CONNECT target's hostname off the (cleartext) proxy handshake and matches it against your pattern. Also needs `network:connect:<broker's port>` (`8090` by default) declared, since Landlock only sees ports. See [egress broker reference](./docs/egress-broker-reference.md). |
| `browser:screenshot:*` | Recorded/reported only | Not independently kernel- or broker-enforced. Declaring any `browser:*` capability is what makes `berth dev` publish the noVNC/CDP port — opt out with `expose: { browser: false }`. |
| `terminal:attach:*` | Recorded/reported only | Not kernel-enforced on its own. Declaring it is what makes `berth dev` publish the ttyd port — opt out with `expose: { terminal: false }`. |
| `github:read:<scope>` / `github:write:<scope>` (e.g. `github:read:repos`, `github:write:issues`) | GitHub API broker — real TLS-terminating MITM, verb+path-level | GET/HEAD map to `read`, everything else to `write`; scope is the path segment after `/repos/<owner>/<repo>/`. Also needs `network:connect:<broker's port>` (`8092` by default) declared. See [GitHub API scoping reference](./docs/github-api-scoping-reference.md). |

Granting a capability and exposing its session to a human watcher are separate decisions either way — see `expose:` above.

Full manifest schema: [docs/manifest-reference.md](./docs/manifest-reference.md). Full SDK surface (`defineApp`, `ContextBusClient`, `SemanticFsClient`, `requestCapability`): [docs/sdk-reference.md](./docs/sdk-reference.md). Building in Python instead of TypeScript: [docs/sdk-python-reference.md](./docs/sdk-python-reference.md).

### Talking to other apps

Apps in the same Berth OS share two things, both reachable from `AppContext` in `onAgentReady`:

- **Context bus** (`ctx.contextBus`) — `register`, `publish(topic, payload)`, `subscribe(topic, handler)`. A Rust daemon gives you real pub/sub between apps without explicit orchestration — one app writes a file, another reacts to `fs.file_created` without either knowing the other exists. See [docs/context-bus-reference.md](./docs/context-bus-reference.md).
- **Semantic FS** (`ctx.semanticFs`) — `register`, `tag(path, meta)`, `query(text, limit)`. A filesystem mounted at `$BERTH_CONTEXT_MOUNT` (default `/context`) that's queryable by intent, not just path — write a file, tag it with `task`/`relatedApps`, and any app can find it later by describing what it needs. See [docs/semantic-fs-reference.md](./docs/semantic-fs-reference.md).

`apps/filesystem` and `apps/code-editor` are a working example of this: the former publishes `fs.file_created`, the latter reacts to it.

Want more than one app in a single Berth OS, each still under independent Landlock enforcement? See [docs/multi-app-reference.md](./docs/multi-app-reference.md) and pass `--apps` to `berth dev`, or `--apps` to `berth os up`.

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
| `berth os up\|down\|status` | Boot a long-lived Berth OS once, then reconnect to it instantly instead of rebuilding on every dev iteration |

Run `berth <command> --help` for flags. Docs for the less obvious ones: [MCP bridge](./docs/mcp-bridge-reference.md), [app registry](./docs/app-registry-reference.md), [computer snapshots](./docs/computer-snapshots-reference.md), [capability tokens / grants](./docs/capability-tokens-reference.md), [K8s adapter](./docs/k8s-adapter-reference.md), [what is a Berth OS](./docs/berth-os.md), [`berth os` command reference / cold start](./docs/berth-os-reference.md).

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
  docker-orchestrator/ Alpine-based container lifecycle for a Berth OS
  context-bus-daemon/  Rust daemon — shared semantic memory for apps in one Berth OS
  agent-init/          Rust — applies a kernel-enforced (Landlock) capability policy before exec-ing the runtime
  semantic-fs-daemon/  Go/FUSE daemon — filesystem queryable by intent, backed by a SQLite metadata index
  registry-server/     local app registry — publish/discover/install (Fastify + SQLite)
  grants-server/       human-approval service for capability grants (Fastify + SQLite)
  adapters/            deploy adapters (E2B, Daytona, Kubernetes)
  cli/                 the `berth` CLI (init, dev, test, publish, deploy, os)
  sdk-python/          Python resident-app SDK — wire-protocol-compatible with @berth/sdk
  agents/              computer -> agent -> tool — boots a Berth OS from resident apps, drives it with any LLM provider, composes multi-agent Crews
apps/
  browser-native/      first-party resident app — headless Chromium + VNC
  filesystem/          first-party resident app — reads/writes /workspace, publishes fs.file_created
  code-editor/         first-party resident app — reacts to fs.file_created via the context bus
  github-assistant/    first-party resident app — the PRD's example manifest, deployed and milestone-tested
  hello-world-py/      minimal Python resident app — proves the Python SDK's RPC wire compatibility
  terminal/            first-party resident app — a shared shell (tmux + ttyd), driven by the agent and watchable live over the web
  activity-feed/       first-party resident app — fans in fs.file_created/notes.* into one queryable feed
  notes/               first-party resident app — stateful notes (add/list/complete), persisted to /workspace
examples/
  resident-apps/       resident app examples, run with `berth dev` (e.g. hello-world/, minimal/zero-capability)
  agents/              agent examples, depend on @berth/agents as a real (workspace:*) package dependency (simple-agent/: computer -> agent -> tool; agent-server/: the agent served over HTTP instead of driving something itself)
```

## Something not working?

File a [bug report](./.github/ISSUE_TEMPLATE/bug_report.md) or [workflow feedback](./.github/ISSUE_TEMPLATE/workflow_feedback.md) — "what was confusing" reports are exactly what we need right now.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
