# Berth

**Give your agent a real computer, not a bag of stateless API calls.**

Most agent code looks the same underneath: a loop, a tool registry, and a pile of glue you wrote yourself so the agent can actually do something useful. Berth replaces that glue. Call `createAgent()` or `runAgent()` and your agent gets a persistent, permissioned sandbox we call a **Berth OS**: a real filesystem, a real browser, a real shell, loaded with whatever the agent needs.

> Agents are not functions. They are workers. Workers need desks.

You don't install Berth as your laptop's operating system, and nobody expects you to understand container internals to use it. It's a library and CLI you add to your project like any other agent framework. It just happens to hand the agent it's driving a real, isolated computer to work on instead of a pile of disconnected API calls. We call that computer a Berth OS (more on exactly what that means in [What is a Berth OS?](#what-is-a-berth-os)), and you extend what one can do by building your own resident app (see [Resident apps](#resident-apps)), though you rarely need to. Every first-party app (filesystem, browser, notes, terminal) is ready to load into an agent the moment you `pnpm add @berth/agents`.

This README is written for the person deciding whether to build on Berth. Already building? Jump straight to [Quickstart](#quickstart).

## The problem

Every agent framework gives you a loop and a tool registry. What it doesn't give you is a computer for the agent to actually stand on. That part is on you: a Python subprocess here, a raw sandbox VM there, a pile of API clients holding the whole thing together. None of it remembers what happened last time. None of it stops the agent from doing something you didn't mean for it to do.

That gap turns into the same four problems on every team that ships an agent past a demo.

- **No permission boundary.** Your agent has full shell access or none. There's no middle ground where a tool can write to `/workspace` and nowhere else, enforced for real instead of politely requested in a system prompt.
- **No memory between runs.** Every session starts from zero. Whatever the agent built up, files, notes, browser state, has to be re-derived or manually stitched back together.
- **No way for tools to talk to each other.** A search tool and a file writer that need to coordinate get glued together by hand in your orchestration code, or they don't coordinate at all.
- **No way to watch it work.** When something breaks, you're reading logs after the fact instead of watching the agent's browser or terminal live, right as it happens.

Berth exists so these four things are infrastructure you get for free, not homework every team rebuilds from scratch.

## Why Berth

| | What you get |
|---|---|
| **One call to a working agent, instant reconnects while you iterate** | `runAgent({ apps: "apps/filesystem", task: "..." })` figures out your LLM provider on its own and cleans up after itself. No boilerplate. `berth os up` boots the sandbox once, then `connect: "<name>"` reattaches in milliseconds instead of rebuilding it on every dev loop run. |
| **Permissions that are enforced, not just requested** | Every resident app declares `namespace:action:scope` capabilities in its manifest, things like `filesystem:write:/workspace` or `browser:navigate:*.github.com`. A Landlock policy built from that manifest applies before your code even runs. An undeclared write isn't caught by a try/catch. The kernel refuses the syscall outright. |
| **State that survives the session** | A semantic filesystem you can query by intent, not just by path, plus `berth snapshot create/restore`, means an agent's work (files, tags, context) outlives any single run. |
| **Apps that talk to each other without you wiring it** | The context bus is pub/sub between resident apps in the same Berth OS. A filesystem app writes a file, a code editor app reacts to it. Neither one imports or calls the other. |
| **A workspace you can actually watch, and you decide how much** | In local `berth dev`, `apps/browser-native` opens a live noVNC view of the sandboxed Chromium instance, and `apps/terminal` opens a live, typeable `ttyd` session. You're watching the real thing, not a transcript of it. Set `expose: { browser: false }` or `{ terminal: false }` in `berth.yml` to keep the capability while running headless in CI. Not available yet on E2B, Daytona, or K8s, see [Resident apps](#resident-apps). |
| **Bring your own LLM, own your deploy target** | `@berth/agents` wires any LLM provider (Anthropic, OpenAI, a custom endpoint through `{provider, apiKey, baseURL}`, or your own `LLMProvider`) into a Berth OS's resident apps as tools. `berth deploy --fleet=e2b\|daytona\|k8s` ships the same sandbox definition to whatever provider you already run on. |

## How Berth compares

Berth isn't trying to replace your sandbox provider or your orchestration library. It's the layer most teams end up hand-building on top of one or both anyway. Here's where it sits next to the tools you'd normally reach for first.

| | **Berth** | Orchestration frameworks (LangChain, CrewAI, AutoGen) | Raw sandbox providers (E2B, Daytona) used directly | Hosted agent platforms (OpenAI Assistants/Operator) |
|---|---|---|---|---|
| **Execution environment** | A real container per agent (a Berth OS), with resident apps running as long-lived processes on it | None provided. You supply your own execution environment | A VM or container, but no app model on top of it | Fully hosted and opaque to you |
| **Permission model** | Kernel-enforced (Landlock) capability tokens, declared per app, denied by default | Nothing built in. Usually whatever access your glue code happens to have | All-or-nothing root access inside the sandbox | Vendor-controlled, not configurable |
| **State across runs** | Persistent semantic FS plus explicit snapshot and restore | Not built in. You bring your own vector store or memory object | Ephemeral by default. Resets unless you build persistence yourself | Vendor-managed, limited control |
| **Inter-tool/app coordination** | Context bus (pub/sub). Apps react to each other with zero direct wiring | Manual. You wire tool outputs into the next call yourself | None. It's a shell, not an app model | None exposed |
| **Live human visibility** | Watch or join the same browser (VNC) or terminal (ttyd) session the agent is using, opt out per app. Local `berth dev` only today | Not applicable. No environment to watch | Only if you build a viewer yourself | None |
| **Where it runs** | Local Docker for dev, then E2B, Daytona, or Kubernetes for deploy. Your choice | Wherever you host your own code | Whichever single provider you picked | Vendor's infrastructure only |
| **Self-hostable / open source** | Yes. Apache-2.0 | Usually yes | Yes, the sandbox itself | No |

If you're already happy hand-rolling permissions, persistence, and coordination on top of a raw sandbox, Berth mostly saves you from rebuilding that layer yourself. If you're using an orchestration framework today, Berth is what you'd point it at instead of a bare subprocess or a single stateless sandbox call.

## Use cases

Each of these is a real job people give an agent. What actually makes it shippable is what the Berth OS underneath enforces or provides, not how much you trust the agent to behave.

**A coding agent with real filesystem and shell access, without handing it your whole machine.** Give it `apps/filesystem` and `apps/terminal` and it can write files, run tests, and drive a real shell. Here's what makes that safe to ship: `filesystem:write:/workspace` and `terminal:attach:*` are enforced by the kernel (Landlock), so a prompt-injected "ignore previous instructions, delete everything" never even reaches the syscall. The file it writes can also trigger a linter or test-runner app over the context bus, with zero orchestration code from you.

**A browser agent a human can actually supervise.** It researches, fills out forms, does QA, scoped to `browser:navigate:*.example.com` by the egress broker rather than a system prompt instruction it could be talked out of. Open the live noVNC session in `berth dev` and you can watch, or take over, the exact browser it's driving instead of piecing together what happened from a log afterward. Flip `expose: { browser: false }` and the same, identically scoped agent runs headless in CI.

**An assistant that actually remembers you.** `apps/notes` gives it real persisted state instead of a context window that resets every session, and `apps/activity-feed` gives it one queryable history across everything that happened. `berth snapshot create/restore` checkpoints the whole Berth OS, files, tags, context and all, so a container restart doesn't wipe what the agent knows.

**A team of agents, each scoped to only what it needs, sharing one sandbox.** Boot one shared Berth OS with `berth os up team --apps=apps/filesystem,apps/notes,apps/terminal`, then connect a writer agent to just `{ apps: ["filesystem"] }` and a notetaker to just `["notes"]` using `Computer.connect({ name, apps })`. One running sandbox, least privilege per agent, nothing to rebuild in between. Need harder isolation than tool-list scoping, a genuinely separate blast radius per agent? `Crew.networked()` runs each one on its own Berth OS instead, joined over a real Docker network.

**An agent behind a real API, not a one-shot script.** [`examples/agents/agent-server`](./examples/agents/agent-server) boots once and answers `POST /task` requests against the same `Agent` for as long as the process runs. Pair it with `berth os up` and `BERTH_OS_CONNECT`, and restarting the server during development reconnects to the sandbox in milliseconds instead of rebuilding it on every code change.

**An agent scoped to exactly one third-party API action, nothing wider.** `apps/github-assistant` can read repos and open issues, and only that. `github:read:repos` and `github:write:issues` are enforced verb-and-path level by a real TLS-terminating broker, not just "has an API key with these OAuth scopes." It's a deployed, milestone-tested example of least-privilege access for any agent that needs to touch a real external API. See the [GitHub API scoping reference](./docs/github-api-scoping-reference.md).

Convinced, or just curious? Let's get something running.

## Quickstart

### Prerequisites

- Node.js 22+ (`nvm use` picks up your `.nvmrc`)
- Docker, running locally
- `corepack enable` (ships with Node 22 and manages pnpm for you)

### Install and build

```bash
git clone <this-repo>
cd agentOS
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package in dependency order through Turborepo: `@berth/manifest-schema` first, then `@berth/sdk`, `@berth/docker-orchestrator`, the deploy adapters, and finally `@berth/cli`.

### Run an agent

[`examples/agents/simple-agent`](./examples/agents/simple-agent) boots a Berth OS from `apps/filesystem` and runs one task against it. Notice we never pass `llm`. It checks whether you have `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set and picks accordingly.

```bash
cd examples/agents/simple-agent
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

That one call is `runAgent({ apps: "apps/filesystem", task: "..." })` under the hood. Head to [Building a Berth Agent](#building-a-berth-agent) for the full API, multi-agent `Crew`s, and how to skip the boot cost entirely on every dev loop run with `berth os up`.

### Run a resident app directly

Want to build or inspect a resident app on its own, with no agent attached? Maybe you're authoring one. `berth dev` boots it with hot reload.

```bash
cd examples/resident-apps/hello-world
pnpm exec berth dev
```

```
Building dev image for "hello-world"...
Container started. Watching .../examples/resident-apps/hello-world/src and berth.yml for changes...
[berth:dev] "hello-world" declares no browser:* capability: no VNC/CDP ports exposed
[berth:dev] [berth:runtime] "hello-world" ready
```

Edit `src/index.ts` and save. The container restarts on its own (`on_install` hooks skip on warm restarts, so this stays fast).

Want a live browser you can actually watch? `apps/browser-native` declares `browser:navigate:*`, so `berth dev` prints a noVNC URL you can open in a tab and watch the sandboxed Chromium instance live.

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

`berth init` asks for a name and a starting template (`hello-world` or `browser-native`), scaffolds `berth.yml` plus SDK boilerplate, runs `pnpm install`, and validates the manifest before handing control back to you. Pass `--template` to skip the prompt. Check [Resident apps](#resident-apps) for the full anatomy of what just got scaffolded.

## Building a Berth Agent

Most frameworks wire agent straight to tool. `@berth/agents` flips that around: computer, then agent, then tool. Boot a Berth OS loaded with resident apps, and every export it has becomes a tool for whatever LLM provider you plug in. The simplest version needs nothing but an app directory and a task. `llm` figures itself out from whichever of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, and `runAgent()` boots, runs, and cleans up in one call.

```ts
import { runAgent } from "@berth/agents";

const result = await runAgent({
  apps: "apps/filesystem",
  task: "write a file called hello.txt with the text 'hi', then read it back",
});
```

Need more than one turn? Keep the `Agent` and `Computer` handles around with the fuller form.

```ts
import { createAgent, createAnthropicProvider } from "@berth/agents";

const { agent, computer } = await createAgent({
  apps: ["apps/filesystem"],
  llm: createAnthropicProvider(), // optional: omit it to auto-detect, pass createOpenAIProvider() or your own LLMProvider, or a plain object like { provider: "openai", apiKey, baseURL } for a custom endpoint
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

### Build the computer, then the agent

Both forms above build the Computer for you behind the scenes, from whatever you pass as `apps`. Sometimes you want to build it yourself first: to limit which apps a specific agent is allowed to see, to mix in your own custom resident app alongside first-party ones, or to reuse one Computer across several agents. `createAgent()` takes an already-built `Computer` directly.

First, build the computer. Load whichever resident apps this agent needs, first-party and custom mixed freely, there's no separate mechanism reserved for either one.

```ts
import { Computer, createAgent } from "@berth/agents";

const computer = await Computer.boot({
  apps: ["apps/filesystem", "./my-custom-app"],
});
```

Then pass that same `computer` straight into `createAgent()`, instead of `apps`.

```ts
const { agent } = await createAgent({
  computer,
  llm: { provider: "anthropic", apiKey: "..." }, // omit llm entirely to auto-detect, or pass a real LLMProvider
});
```

Want to limit a specific agent to only some of a shared OS's apps? Build the computer with `Computer.connect()` instead of `Computer.boot()`, and pass an `apps` filter. Everything else about wiring it into `createAgent()` stays exactly the same.

```ts
// team-os was started once with `berth os up team-os --apps=apps/filesystem,apps/notes,apps/terminal`
const writerComputer = await Computer.connect({ name: "team-os", apps: ["filesystem"] });
const { agent: writer } = await createAgent({ computer: writerComputer, llm: { provider: "anthropic", apiKey: "..." } });
```

`computer` comes back from `createAgent()` too, however you built it, so you can keep using it after the `Agent` is created: call tools directly, snapshot it, or hand that same instance to a second `createAgent()` call. You own its lifecycle regardless of who built it. `createAgent()` never calls `stop()` on a `Computer` you handed it.

`Crew.withManager()` and `Crew.sequential()` compose multiple agents. `Crew.networked()` composes agents running on entirely separate Berth OS instances, joined over a real Docker network. Full details live in [docs/agents-reference.md](./docs/agents-reference.md).

### What is a Berth OS?

Every `runAgent()` or `createAgent()` call above needs somewhere for its tools to actually live and run. That's a Berth OS: a real, sandboxed computer (a Docker container today) loaded with one or more resident apps, each independently enforced by the kernel, all able to collaborate through a shared context bus and semantic filesystem. In code, that's the `Computer` class.

Want the full picture? [docs/berth-os.md](./docs/berth-os.md) walks through what's actually inside one and how it relates to a resident app.

Here's the part that matters for your day to day: by default, every `createAgent()` or `runAgent()` call boots a fresh, throwaway Berth OS. That's fine for a one-off script, but you'll feel it as real seconds of latency on every single dev loop iteration. `berth os up` pays that cost once, keeps the sandbox running, and lets your agent code reconnect in milliseconds instead of rebuilding and rebooting.

```bash
berth os up my-agent --apps=apps/filesystem,apps/notes   # or --config=<path to a small YAML>
```

```ts
const result = await runAgent({ connect: "my-agent", task: "..." }); // reconnects instantly, no build, no boot
```

`berth os down my-agent` tears it down when you're done. [docs/berth-os-reference.md](./docs/berth-os-reference.md) has the full command and API reference, including how to scope one agent to a subset of a shared OS's loaded apps.

## Resident apps

A resident app is what you build to extend what a Berth OS can do: a persistent, stateful process, loaded from a directory with a `berth.yml` manifest and some code, that declares capability-scoped permissions and exposes exports that become an agent's tools. Every first-party app (`apps/filesystem`, `apps/browser-native`, `apps/notes`) is built exactly this way. There's no separate, more privileged mechanism reserved for us.

Every app has two things at its root: a `berth.yml` manifest and an entry file that calls `defineApp()`.

**`berth.yml`** tells Berth what the app is called, what it's allowed to do, and what it exposes:

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

**`src/index.ts`** is the code behind those exports:

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

A few things worth knowing up front, because they'll bite you otherwise:

- **Exports have to match on both sides.** Every `app.export({ name })` call needs a matching entry in `berth.yml`'s `exports:` list, and the reverse is true too. A mismatch is a hard boot failure, not a warning.
- **You declare capabilities up front.** `capabilities:` is a list of `namespace:action:scope` strings, things like `filesystem:write:/workspace`, `browser:navigate:*.github.com`, or `network:connect:8090`. The kernel enforces this list through Landlock before your app's code ever runs, see the [capability tokens reference](./docs/capability-tokens-reference.md). Anything you didn't declare gets denied, not just left unenforced.
- **Granting a capability and exposing it aren't the same thing.** Declaring `browser:navigate:*` or `terminal:attach:*` is what lets `berth dev` publish the noVNC/CDP or ttyd port to the host. Add an `expose:` block to opt out per app (`expose: { browser: false }`) and keep the capability while running headless. Both default to `true`. See the [manifest reference](./docs/manifest-reference.md); this only affects local `berth dev`, since deploy targets don't publish these ports yet either way.
- **`on_install` and `app.onInstall(fn)` aren't interchangeable.** Use `on_install` in `berth.yml` for shell setup like `pip install -r requirements.txt`. Use the SDK's `onInstall` when it's easier to express in TypeScript. Both run once per cold build and skip on warm dev restarts.
- **Network access is denied by default.** If your app needs to reach the outside world, route it through the egress broker instead of requesting a wide-open `network:connect:*`. See the [egress broker reference](./docs/egress-broker-reference.md) and `apps/browser-native`'s `berth.yml` for the pattern.

### Available capabilities

The `namespace:action:scope` grammar is wide open. You can declare a capability in a namespace nobody's used before, and `requestCapability()` will honestly tell you `granted: false`, because nothing actually backs it. The table below is what has real enforcement or brokering behind it today, the full list of permissions a resident app in a Berth OS can actually be given.

| Capability | Enforced by | Notes |
|---|---|---|
| `filesystem:write:<path>` (say, `filesystem:write:/workspace`) | Kernel (Landlock), always on | Restricts write, create, delete, and rename to the paths you declared, plus a `/tmp` baseline. Declare nothing and your app can still only write to `/tmp`. |
| `filesystem:read:<path>` (say, `filesystem:read:/context`) | Kernel (Landlock), opt in | Declare at least one and read scoping turns on: a fixed baseline (`/usr`, `/lib`, `/etc`, `/proc`, `/dev`, `/tmp`, your app's own working directory) plus whatever you added. Declare none and reads stay fully open, same as always. |
| `network:connect:<port>` or `network:connect:*` | Kernel (Landlock), denied by default | Declare no capability at all and you get zero outbound TCP, full stop. Scoping is by port only, not domain. `*` is an explicit, audited escape hatch for apps that genuinely need arbitrary hosts (`browser-native`, for example). |
| `network:peer:<name>` or `network:peer:*` | `mesh-coordinator` (mutual consent) plus a real WireGuard mesh | Joins the mesh with any other app whose own `network:peer:<pattern>` names this app back. A one-sided declaration never gets introduced to its target. See the [mesh reference](./docs/mesh-reference.md). |
| `browser:navigate:<pattern>` (say, `browser:navigate:*.github.com`) | The egress broker, at the host level rather than the kernel | The broker reads the CONNECT target's hostname straight off the (cleartext) proxy handshake and checks it against your pattern. You'll also need `network:connect:<broker's port>` declared (`8090` by default), since Landlock only sees ports. See the [egress broker reference](./docs/egress-broker-reference.md). |
| `browser:screenshot:*` | Recorded and reported only | Nothing kernel- or broker-enforced here on its own. Declaring any `browser:*` capability is what makes `berth dev` publish the noVNC/CDP port. Opt out with `expose: { browser: false }`. |
| `terminal:attach:*` | Recorded and reported only | Not kernel-enforced by itself. Declaring it is what makes `berth dev` publish the ttyd port. Opt out with `expose: { terminal: false }`. |
| `github:read:<scope>` / `github:write:<scope>` (say, `github:read:repos`, `github:write:issues`) | A real TLS-terminating GitHub API broker, verb-and-path level | GET and HEAD map to `read`, everything else maps to `write`. Scope is the path segment right after `/repos/<owner>/<repo>/`. You'll also need `network:connect:<broker's port>` declared (`8092` by default). See the [GitHub API scoping reference](./docs/github-api-scoping-reference.md). |

Granting a capability and exposing its session to a human watcher are two separate decisions either way, see `expose:` above.

Full manifest schema lives in [docs/manifest-reference.md](./docs/manifest-reference.md). Full SDK surface (`defineApp`, `ContextBusClient`, `SemanticFsClient`, `requestCapability`) lives in [docs/sdk-reference.md](./docs/sdk-reference.md). Building in Python instead of TypeScript? See [docs/sdk-python-reference.md](./docs/sdk-python-reference.md).

### Talking to other apps

Apps sharing a Berth OS get two things for free, both reachable from `AppContext` inside `onAgentReady`:

- **Context bus** (`ctx.contextBus`): `register`, `publish(topic, payload)`, `subscribe(topic, handler)`. A Rust daemon gives you real pub/sub between apps with no explicit orchestration. One app writes a file, another reacts to `fs.file_created`, and neither one knows the other exists. See [docs/context-bus-reference.md](./docs/context-bus-reference.md).
- **Semantic FS** (`ctx.semanticFs`): `register`, `tag(path, meta)`, `query(text, limit)`. A filesystem mounted at `$BERTH_CONTEXT_MOUNT` (`/context` by default) that you can query by intent instead of by path. Write a file, tag it with `task` and `relatedApps`, and any app can find it later just by describing what it needs.

`apps/filesystem` and `apps/code-editor` show this in action: the first publishes `fs.file_created`, the second reacts to it.

Want more than one app in a single Berth OS, each still independently enforced by Landlock? Check [docs/multi-app-reference.md](./docs/multi-app-reference.md) and pass `--apps` to `berth dev`, or to `berth os up`.

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
| `berth snapshot create\|list\|restore` | Checkpoint and restore a container plus its semantic-fs context data |
| `berth grants list\|approve\|deny` | Review and resolve pending human-approval capability requests |
| `berth fleet status` | Check the state of a configured remote fleet |
| `berth os up\|down\|status` | Boot a long-lived Berth OS once, then reconnect to it instantly instead of rebuilding on every dev iteration |

Run `berth <command> --help` to see the flags. A few of these deserve their own doc: [MCP bridge](./docs/mcp-bridge-reference.md), [app registry](./docs/app-registry-reference.md), [computer snapshots](./docs/computer-snapshots-reference.md), [capability tokens and grants](./docs/capability-tokens-reference.md), [K8s adapter](./docs/k8s-adapter-reference.md), [what is a Berth OS](./docs/berth-os.md), and [the `berth os` command reference for cold start](./docs/berth-os-reference.md).

## Testing and deploying

```bash
pnpm exec berth test              # build prod image, validate exports, run stub invocations + your own tests
pnpm exec berth test --json       # CI-friendly output

berth deploy --fleet=e2b          # or --fleet=daytona, --fleet=k8s, or an alias from ~/.berthrc
```

## Repository layout

```
packages/
  manifest-schema/     berth.yml schema, validation, and capability parsing
  sdk/                 resident app SDK: defineApp(), lifecycle hooks, context bus client
  docker-orchestrator/ Alpine-based container lifecycle for a Berth OS
  context-bus-daemon/  Rust daemon for shared semantic memory across apps in one Berth OS
  agent-init/          Rust binary that applies a kernel-enforced (Landlock) capability policy before exec-ing the runtime
  semantic-fs-daemon/  Go/FUSE daemon, a filesystem queryable by intent, backed by a SQLite metadata index
  registry-server/     local app registry for publish, discover, and install (Fastify + SQLite)
  grants-server/       human approval service for capability grants (Fastify + SQLite)
  adapters/            deploy adapters for E2B, Daytona, and Kubernetes
  cli/                 the `berth` CLI: init, dev, test, publish, deploy, os
  sdk-python/          Python resident app SDK, wire-protocol compatible with @berth/sdk
  agents/              computer, then agent, then tool: boots a Berth OS from resident apps, drives it with any LLM provider, composes multi-agent Crews
apps/
  browser-native/      first-party resident app: headless Chromium plus VNC
  filesystem/          first-party resident app that reads and writes /workspace, publishes fs.file_created
  code-editor/         first-party resident app that reacts to fs.file_created through the context bus
  github-assistant/    first-party resident app, the PRD's example manifest, deployed and milestone-tested
  hello-world-py/      minimal Python resident app proving the Python SDK's RPC wire compatibility
  terminal/            first-party resident app: a shared shell (tmux + ttyd), driven by the agent and watchable live over the web
  activity-feed/       first-party resident app that fans in fs.file_created and notes.* into one queryable feed
  notes/               first-party resident app for stateful notes (add, list, complete), persisted to /workspace
examples/
  resident-apps/       resident app examples you run with `berth dev` (hello-world/ is the minimal, zero-capability one)
  agents/              agent examples that depend on @berth/agents as a real (workspace:*) package dependency (simple-agent/ is computer, agent, tool; agent-server/ serves the agent over HTTP instead of driving something itself)
```

## Something not working?

Found a [bug](./.github/ISSUE_TEMPLATE/bug_report.md), or just something confusing about the [workflow](./.github/ISSUE_TEMPLATE/workflow_feedback.md)? Tell us. Those reports are exactly what we need right now.

## License

Apache-2.0. See [LICENSE](./LICENSE).
