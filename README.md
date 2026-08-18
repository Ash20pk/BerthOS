# Berth

**Give your agent a real computer, with permissions the kernel actually enforces.**

Your agent needs to write files, run code, drive a browser. Berth gives it a persistent, sandboxed computer to do that on — a **Berth OS** — where what it's allowed to touch is a line in a manifest compiled into a [Landlock](https://docs.kernel.org/userspace-api/landlock.html) policy, applied before the app's own code runs. `filesystem:write:/workspace` means a write anywhere else dies on `EACCES` in the kernel, not in a `try/catch` and not in a system prompt the model can be talked out of.

> Agents are not functions. They are workers. Workers need desks.

**Keep the agent framework you already have.** A Berth OS's tools drop into whatever loop you're running:

```ts
import { Computer, toAiSdkTools } from "@berth/agents";

const computer = await Computer.boot({ apps: ["apps/filesystem"] });
const result = await generateText({          // Vercel AI SDK — or LangGraph, or your own loop
  model: openai("gpt-4o"),
  tools: await toAiSdkTools(computer.tools),
  prompt: "summarize every file in /workspace",
});
```

`toLangChainTools()` does the same for LangChain and LangGraph, `toToolSpecs()` for anything else, and `berth mcp` exposes a resident app over [MCP](https://modelcontextprotocol.io) to Claude Code, Cursor, and every other MCP client. See [Use it from your existing framework](#use-it-from-your-existing-framework) and [`examples/agents/with-vercel-ai-sdk`](./examples/agents/with-vercel-ai-sdk), whose second prompt asks the model to write outside its declared scope and prints what the kernel says back.

**Or use the agent framework in the box.** `@berth/agents` is a full one — bring your own LLM provider, define agents, compose them into multi-agent crews, one call to `runAgent()` for the simple case. It's the reference consumer of everything above, and it's optional. See [Building a Berth Agent](#building-a-berth-agent).

You don't install Berth as your laptop's operating system, and nobody expects you to understand container internals to use it — it's a library and CLI you add to your project. Every first-party app (filesystem, browser, notes, terminal) is ready to load the moment you clone and build this repo — see [Quickstart](#quickstart). `@berth/*` isn't published to npm yet; today you build it from source.

This README is written for the person deciding whether to build on Berth. Already building? Jump straight to [Quickstart](#quickstart), or to [docs/getting-started.md](./docs/getting-started.md) for the longer, resident-app-focused walkthrough.

## The problem

Every agent framework gives you a loop and a tool registry. What it doesn't give you is a computer for the agent to actually stand on. That part is on you: a Python subprocess here, a raw sandbox VM there, a pile of API clients holding the whole thing together. None of it remembers what happened last time. None of it stops the agent from doing something you didn't mean for it to do.

That gap turns into the same four problems on every team that ships an agent past a demo.

- **No permission boundary.** Your agent has full shell access or none. There's no middle ground where a tool can write to `/workspace` and nowhere else, enforced for real instead of politely requested in a system prompt.
- **No memory between runs.** Every session starts from zero. Whatever the agent built up, files, notes, browser state, has to be re-derived or manually stitched back together.
- **No way for tools to talk to each other.** A search tool and a file writer that need to coordinate get glued together by hand in your orchestration code, or they don't coordinate at all.
- **No way to watch it work.** When something breaks, you're reading logs after the fact instead of watching the agent's browser or terminal live, right as it happens.

Berth exists so these four things are infrastructure you get for free, not homework every team rebuilds from scratch.

## Why `@berth/agents`

| | What you get |
|---|---|
| **One call to a working agent, instant reconnects while you iterate** | `runAgent({ apps: "apps/filesystem", task: "..." })` figures out your LLM provider on its own and cleans up after itself. No boilerplate. `berth os up` boots the sandbox once, then `connect: "<name>"` reattaches in milliseconds instead of rebuilding it on every dev loop run. |
| **Multi-agent by default, not bolted on** | `Crew.sequential()`/`Crew.withManager()` compose agents in-process; `Crew.networked()` goes further — each peer is a full, independently-LLM-driven agent on its own Berth OS, joined over a real Docker network, not just a delegated tool call. See [Multi-agent architecture](#multi-agent-architecture). |
| **A governance gate any app can become** | Declare `governs: true` and export `evaluate_action`, and every other app's tool calls route through your policy first — human approval, an ML classifier, whatever you want — before they execute. See [Governance and scoping](#governance-and-scoping). |
| **Bring your own LLM, own your deploy target** | `@berth/agents` wires any LLM provider (Anthropic, OpenAI, Gemini, Azure OpenAI, Bedrock, Ollama, a custom endpoint through `{provider, apiKey, baseURL}`, or your own `LLMProvider`) into a Berth OS's resident apps as tools. `berth deploy --fleet=e2b\|daytona\|k8s` ships the same sandbox definition to whatever provider you already run on. |
| **The whole MCP ecosystem, not just resident apps** | `createAgent({ mcpServers: [...] })` connects to any external [MCP](https://modelcontextprotocol.io) server (stdio or Streamable HTTP) and merges its tools in alongside your Computer's own — `createMcpClientTools()` in TypeScript, `create_mcp_client_tools()` in Python. `berth mcp --app=<name>` is the other direction: exposing a resident app's exports *to* an MCP client like Claude Desktop. |
| **Traces your existing observability stack already understands** | `trace: "otel"` emits real OpenTelemetry GenAI-semantic-convention spans for every LLM turn and tool call — Langfuse, Phoenix, Honeycomb, Datadog, or a plain OTel Collector all pick them up with no Berth-specific integration. `trace: "full"` stays available for durable, Semantic-FS-backed replay without any external backend at all. |
| **Guardrails on the model's own input and answer, not just its tool calls** | `inputGuardrails`/`outputGuardrails` gate what goes into and comes out of the model itself — a tripped one halts the run via `GuardrailTripwireError`, distinct from the governance gate (tool calls) and human-in-the-loop approval (a live decision) above. Built-in `createKeywordGuardrail()`/`createRegexGuardrail()`/`createLlmGuardrail()` cover the common cases; write your own for anything else. |
| **Conversation history across separate `run()` calls, not just one durable run** | `createAgent().run(input, { session })` shares message history across turns — a chat UI's turns, say — distinct from checkpointing's crash-resume of *one* run. `createInMemorySession()` for a dev loop, `createSemanticFsSession(computer, sessionId)` for durable history reached through the same resident-app exports checkpointing already uses. |
| **A real HTTP surface to serve an agent to a frontend, `useChat` included** | `serveAgent(agent, { port })` — `GET /health`, `POST /task`, and `POST /chat`, a [Vercel AI SDK](https://ai-sdk.dev) `useChat`-compatible streaming endpoint verified against the actual `ai` package's own client-side stream parser, not just written to match docs. `createAgentRequestHandler()` is the composable building block underneath, for mounting inside your own server instead. |
| **A2A interop — talk to agents outside Berth, and let them talk to yours** | `createA2aClientTool(agentCardUrl)` wraps any [A2A](https://a2a-protocol.org)-compliant agent (ADK, LangGraph, Microsoft Agent Framework, anything) as a `Tool`; `serveAgentAsA2a(agent, { port })` exposes a Berth Agent as a real A2A server those same frameworks can call into. Built on the official `@a2a-js/sdk` and verified against a real client+server round trip through it, not just written to match the spec text. |

What backs every one of those calls, in brief — full picture in [What is a Berth OS?](#what-is-a-berth-os):

| | What you get |
|---|---|
| **Permissions that are enforced, not just requested** | Every resident app declares `namespace:action:scope` capabilities in its manifest, things like `filesystem:write:/workspace` or `browser:navigate:*.github.com`. A Landlock policy built from that manifest applies before your code even runs, on a kernel that provides Landlock ([which hosts do](#kernel-enforcement-by-platform)). An undeclared *write* isn't caught by a try/catch — the kernel refuses the syscall outright. Outbound network is denied the same way. Other capabilities are enforced by a broker, or only recorded: which is which is [spelled out per capability](#available-capabilities), along with [what isn't enforced yet](#what-isnt-enforced-yet). |
| **State that survives the session** | A filesystem whose files carry *why they exist* — `created_by`, `task`, `related_apps` — searchable by that metadata rather than only by path, plus `berth snapshot create/restore`, means an agent's work (files, tags, context) outlives any single run. It searches what you tagged, [not file contents](./docs/semantic-fs-reference.md#query-semantics--hybrid-keyword--embedding-similarity). |
| **Apps that talk to each other without you wiring it** | The context bus is pub/sub between resident apps in the same Berth OS. A filesystem app writes a file, a code editor app reacts to it. Neither one imports or calls the other. |
| **A workspace you can actually watch, and you decide how much** | In local `berth dev`, `apps/browser-native` opens a live noVNC view of the sandboxed Chromium instance, and `apps/terminal` opens a live, typeable `ttyd` session. You're watching the real thing, not a transcript of it. Set `expose: { browser: false }` or `{ terminal: false }` in `berth.yml` to keep the capability while running headless in CI. Deployed to E2B or Daytona? Opt in with `expose: { preview: true }` and `berth deploy`/`berth fleet status` print that same live view as a real, platform-hosted URL — off by default, since a deployed fleet is potentially public-facing. On Kubernetes, that same opt-in only gets you the in-cluster DNS name; a real public URL there still needs your own Ingress/LoadBalancer. See [Resident apps](#resident-apps). |

## Multi-agent architecture

Most frameworks compose agents in-process: a manager calls a worker's function, all inside one Node process. `Crew.sequential(agents)` and `Crew.withManager({ manager, workers })` do exactly that here too — pipe outputs forward, or hand a manager one `Tool` per worker and let its own LLM decide when to delegate.

`Crew.networked()` goes further, because it can: each peer is a full Berth OS with its own `Agent` and its own LLM loop, not just a function call. `bootNetworkedAgent()` boots one independent `Computer` per peer — its own resident apps, its own synthesized agent-server companion — joined to a shared Docker network. A manager `Agent` then gets one delegation `Tool` per peer, over a real network, not an in-process call:

```ts
import { Agent, Crew, createOpenAIProvider, bootNetworkedAgent } from "@berth/agents";

const filer = await bootNetworkedAgent({ name: "filer", apps: ["apps/filesystem"], llm: { provider: "openai", apiKeyEnvVar: "OPENAI_API_KEY" } });
const notetaker = await bootNetworkedAgent({ name: "notetaker", apps: ["apps/notes"], llm: { provider: "openai", apiKeyEnvVar: "OPENAI_API_KEY" } });

const manager = new Agent({ name: "manager", llm: createOpenAIProvider(), tools: [] });
const crew = Crew.networked({ manager, peers: [filer, notetaker] });

const output = await crew.run("Ask notetaker to log this run, then ask filer to write the result to a file.");
```

Each peer keeps driving its own agent loop independently, on its own sandboxed computer — this is the architecture, not a demo trick, and it's why multi-agent here scales past "one process calling itself." Full API, and what's real vs. deferred today (host-mediated dispatch, a genuine container-to-container mesh as follow-up work): [docs/agents-reference.md](./docs/agents-reference.md).

Peers don't have to be local either. `bootNetworkedAgent({ fleet: { adapter, port } })` deploys a peer to a remote E2B/Daytona/K8s instance instead of a local Docker container, and `Crew.networked()` dispatches to it the same way — over a per-boot-authenticated HTTP RPC bridge instead of the Docker network. See [docs/agents-reference.md](./docs/agents-reference.md#networked-crew-over-a-remote-fleet-e2b-daytona-k8s) for what's verified end-to-end versus reasoned-but-not-live-tested.

## Governance and scoping

Capabilities (see [Available capabilities](#available-capabilities)) control what a single app can do, enforced by the kernel or a broker before the call happens. Governance controls what happens next: any app can put itself in front of every *other* app's tool calls in the same Berth OS and decide, per call, whether it's allowed to run at all.

Declare `governs: true` in your `berth.yml` and export a fixed-contract `evaluate_action({ app, export, input }) -> { allowed, reason }`. Load it alongside whatever else the Computer needs, and every other app's tool calls now route through it automatically — no other wiring required. Any app can opt out with `governance: { exempt: true }`.

Worth being precise about: this gates what goes through `Computer`/`Agent` — an LLM-driven agent's tool use, including MCP tools (as `mcp:<server>`) and delegation to another agent (as `agent:<name>`). It is **not** kernel-level like Landlock's per-syscall capability enforcement, and it doesn't cover `berth rpc`, `berth mcp`, the HTTP RPC bridge, or direct `invokeAppExport()` calls — separate transports with no governance app on their path. It fails **closed** by default: if `evaluate_action` errors or times out, the call is refused rather than run, because "the policy check didn't happen" should not quietly become "the policy check passed." Pass `governance: { mode: "fail-open" }` where availability matters more. Full contract in [docs/governance-reference.md](./docs/governance-reference.md).

## Use it from your existing framework

Berth's differentiator is what its tools are *made of*, and adopting a whole agent framework shouldn't be the price of reaching that. Boot a `Computer`, hand its tools to the loop you already run:

| Your stack | The call |
|---|---|
| Vercel AI SDK | `await toAiSdkTools(computer.tools)` → pass as `tools` to `generateText`/`streamText`/`useChat` |
| LangChain / LangGraph | `await toLangChainTools(computer.tools)` → pass to `createReactAgent({ tools })`, `ToolNode`, `bindTools` |
| Claude Code, Cursor, any MCP client | `berth mcp --app=<name>` — a real MCP server, no adapter at all |
| Anything else | `toToolSpecs(computer.tools)` — name, description, JSON Schema, and a call function |

Both library adapters are **optional peer dependencies**, imported dynamically: neither is on the import path of `Computer` or `Agent`, so you install only the one you use, or neither. Both are tested against the real package rather than a hand-written idea of its shape — the AI SDK's test drives a full `generateText` tool-calling loop with no Berth `Agent` anywhere in it.

What you get in that loop is the whole point: a filesystem tool whose write scope is enforced by the kernel, a shell whose blast radius is a manifest, a browser scoped by an egress broker, and state that survives the run. Cancellation composes too — an `abortSignal` from `generateText` reaches the resident-app call and stops it.

If you're already on E2B or Daytona directly, Berth is the app model and kernel-enforced permission layer on top of that.

## Use cases

Each of these is a real job people give an agent. What actually makes it shippable is what the Berth OS underneath enforces or provides, not how much you trust the agent to behave.

**A coding agent with real filesystem and shell access, without handing it your whole machine.** Give it `apps/filesystem` and `apps/terminal` and it can write files, run tests, and drive a real shell. Here's what narrows the blast radius: `filesystem:write:/workspace` is enforced by the kernel (Landlock), so a prompt-injected "ignore previous instructions, delete everything" is refused by the kernel rather than by a framework check it could talk its way past — `rm -rf /etc` from that shell dies on `unlink(2)` with `EACCES`. That's the write path specifically, and it's the boundary to plan around: `terminal:attach:*` grants the pty devices the shell needs, not any widening of what that shell may touch, so the filesystem and network scoping is inherited by everything it spawns. There are still [gaps open around the sandbox](#what-isnt-enforced-yet) that a determined in-container attacker can work with. The file it writes can also trigger `apps/code-editor` to react over the context bus — `apps/filesystem` publishes `fs.file_created`, `apps/code-editor` subscribes to it — with zero orchestration code from you.

**A browser agent a human can actually supervise.** It researches, fills out forms, does QA, scoped to `browser:navigate:*.example.com` by the egress broker rather than a system prompt instruction it could be talked out of. Open the live noVNC session in `berth dev` and you can watch, or take over, the exact browser it's driving instead of piecing together what happened from a log afterward. Flip `expose: { browser: false }` and the same, identically scoped agent runs headless in CI.

**An assistant that actually remembers you.** `apps/notes` gives it real persisted state instead of a context window that resets every session, and `apps/activity-feed` gives it one queryable history across everything that happened. `berth snapshot create/restore` checkpoints the whole Berth OS, files, tags, context and all, so a container restart doesn't wipe what the agent knows.

**A team of agents, each scoped to only what it needs, sharing one sandbox.** Boot one shared Berth OS with `berth os up team --apps=apps/filesystem,apps/notes,apps/terminal`, then get a writer agent scoped to just `apps/filesystem` and a notetaker scoped to just `apps/notes` with `createAgent({ connect: { name: "team", apps: ["filesystem"] } })` and `createAgent({ connect: { name: "team", apps: ["notes"] } })`. One running sandbox, least privilege per agent, nothing to rebuild between runs. Need each agent driving its own LLM loop on its own computer instead? See [Multi-agent architecture](#multi-agent-architecture).

**An agent behind a real API, not a one-shot script.** [`examples/agents/agent-server`](./examples/agents/agent-server) boots once and calls `serveAgent()`, answering `POST /task` and a `useChat`-compatible `POST /chat` against the same `Agent` for as long as the process runs. Pair it with `berth os up` and `BERTH_OS_CONNECT`, and restarting the server during development reconnects to the sandbox in milliseconds instead of rebuilding it on every code change.

**An agent scoped to exactly one third-party API action, nothing wider.** `apps/github-assistant` can read repos and open issues, and only that. `github:read:repos` and `github:write:issues` are enforced verb-and-path level by a real TLS-terminating broker, not just "has an API key with these OAuth scopes." It's a deployed, milestone-tested example of least-privilege access for any agent that needs to touch a real external API. See the [GitHub API scoping reference](./docs/github-api-scoping-reference.md).

**An agent that writes and runs its own code, without a bolted-on sandbox.** `apps/code-interpreter`'s `run_code` executes a Python, JavaScript, or shell snippet as a real subprocess and hands back stdout/stderr/exit code — the same primitive AutoGen ships a separate Docker executor for and OpenAI/CrewAI reach for E2B to get. Here it's just another resident app: the code it runs is already inside this agent's own kernel-enforced sandbox, so declaring no `network:connect:<port>` capability means that code gets no outbound network — no TCP (Landlock), and no UDP, ICMP, or raw sockets either (a seccomp filter, since Landlock has no access right for those) — the same deny-by-default guarantee every other app gets — not a second isolation boundary you have to configure separately.

**An agent that delegates to (or gets called by) agents built on something else entirely.** `createA2aClientTool(url)` lets a Berth agent hand off a task to any [A2A](https://a2a-protocol.org)-compliant agent — one built on ADK, LangGraph, Microsoft Agent Framework, or anything else that speaks the protocol — the same way it would delegate to a worker built on Berth itself. `serveAgentAsA2a(agent)` is the other direction: those same frameworks' agents can call into a Berth agent as a standard A2A peer, no Berth-specific glue on their side at all.

Convinced, or just curious? Let's get something running.

## Quickstart

### Prerequisites

- Node.js 22+ (`nvm use` picks up your `.nvmrc`)
- Docker, running locally
- `corepack enable` (ships with Node 22 and manages pnpm for you)

#### Kernel enforcement, by platform

Berth's capability scoping is enforced by [Landlock](https://docs.kernel.org/userspace-api/landlock.html), a Linux kernel feature. Whether your kernel provides it decides what you can run locally:

| Host | Landlock | What works |
|------|----------|------------|
| Linux, kernel 5.13+ | Enforced | Everything, with real kernel enforcement |
| Linux, kernel < 5.13 | Unavailable | `berth dev`; agent paths need the relaxed mode below |
| macOS / Windows (Docker Desktop) | Unavailable — the linuxkit VM returns `ENOSYS` for `landlock_create_ruleset` | `berth dev`; agent paths need the relaxed mode below |
| macOS, Docker daemon in Colima | Enforced — Colima's default Ubuntu 24.04 guest has Landlock ABI 4 in its active LSM stack | Everything, with real kernel enforcement — recipe and verification in [docs/mac-enforcement.md](docs/mac-enforcement.md) |

`berth dev` builds the dev image, which never required enforcement, so resident-app development works on any host. `Computer.boot()` builds the production image, which refuses to run its app unrestricted — on a host without Landlock it exits rather than pretending to be sandboxed. To iterate locally there anyway:

```bash
BERTH_ALLOW_UNENFORCED=1 pnpm start        # or, in code:
```
```ts
await Computer.boot({ apps: ["../../../apps/filesystem"], enforcement: "warn" });
```

Either one prints a warning on every boot. It is a local-iteration mode: the app runs with whatever the kernel managed to apply, which on Docker Desktop is nothing. Don't use it where the isolation boundary matters.

On macOS you do not have to settle for that: swapping Docker Desktop for Colima gets you a kernel that really refuses an undeclared write, with no custom kernel build — `./scripts/mac-enforcement.sh` sets it up and `berth doctor` confirms it. See [docs/mac-enforcement.md](docs/mac-enforcement.md), which records the full capability-denial milestone passing on that host.

### Install and build

```bash
git clone https://github.com/Ash20pk/BerthOS
cd BerthOS
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package in dependency order through Turborepo: `@berth/manifest-schema` first, then `@berth/sdk`, `@berth/docker-orchestrator`, `@berth/agents` and the deploy adapters, and finally `@berth/cli`.

### Run an agent

[`examples/agents/simple-agent`](./examples/agents/simple-agent) boots a Berth OS from `apps/filesystem` and runs one task against it. Notice we never pass `llm`. It checks whether you have `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set and picks accordingly.

```bash
cd examples/agents/simple-agent
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

On macOS or Windows, prefix that last command with `BERTH_ALLOW_UNENFORCED=1` — see the platform table above for why.

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
[berth:dev] "hello-world" declares no browser:* capability: no VNC ports exposed
[berth:dev] "hello-world" declares no terminal:* capability: no terminal port exposed
[berth:dev] [berth:runtime] "hello-world" ready
```

Edit `src/index.ts` and save. The container restarts on its own — `on_install` is baked into the image at build time, so a restart never re-runs it and this stays fast.

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

`berth init` asks for a name and a starting template (`hello-world` or `browser-native`), scaffolds `berth.yml` plus SDK boilerplate, runs `pnpm install`, and validates the manifest before handing control back to you. Pass `--template` to skip the prompt, or `--registry=<url>` to scaffold from a published app instead of a bundled template. Check [Resident apps](#resident-apps) for the full anatomy of what just got scaffolded.

## Building a Berth Agent

Most frameworks wire agent straight to tool. `@berth/agents` flips that around: computer, then agent, then tool. Build the computer first, load it with whichever resident apps this agent needs, first-party and custom mixed freely, there's no separate mechanism reserved for either one. Then build the agent on top of it. Every export the computer's apps have becomes a tool for whatever LLM provider you plug in.

```ts
import { Computer, createAgent } from "@berth/agents";

const computer = await Computer.boot({
  apps: ["apps/filesystem", "./my-custom-app"],
});

const { agent } = await createAgent({
  computer,
  llm: { provider: "anthropic", apiKey: "..." }, // omit llm entirely to auto-detect ANTHROPIC_API_KEY/OPENAI_API_KEY, or pass a real LLMProvider
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

`computer` comes back from `createAgent()` too, so you can keep using it after the `Agent` is created: call tools directly, snapshot it, or hand that same instance to a second `createAgent()` call. You own its lifecycle regardless of who built it. `createAgent()` never calls `stop()` on a `Computer` you handed it.

Want to limit a specific agent to only some of a shared OS's apps, instead of booting a fresh one? Build the computer with `Computer.connect()` instead of `Computer.boot()`, and pass an `apps` filter. Everything else about wiring it into `createAgent()` stays exactly the same.

```ts
// team-os was started once with `berth os up team-os --apps=apps/filesystem,apps/notes,apps/terminal`
const writerComputer = await Computer.connect({ name: "team-os", apps: ["filesystem"] });
const { agent: writer } = await createAgent({ computer: writerComputer, llm: { provider: "anthropic", apiKey: "..." } });
```

### Shortcuts for the common case

Building the computer yourself pays off when you need to limit which apps an agent sees, mix in a custom resident app, or reuse one Computer across several agents. Most of the time you don't need any of that, so `@berth/agents` also gives you two shortcuts that build the Computer for you behind the scenes, from whatever you pass as `apps`.

The simplest version needs nothing but an app directory and a task. `llm` figures itself out from whichever of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, and `runAgent()` boots, runs, and cleans up in one call.

```ts
import { runAgent } from "@berth/agents";

const result = await runAgent({
  apps: "apps/filesystem",
  task: "write a file called hello.txt with the text 'hi', then read it back",
});
```

Need more than one turn, but don't need to touch the Computer yourself? Keep the `Agent` and `Computer` handles around with `createAgent({ apps })` instead of `createAgent({ computer })`.

```ts
import { createAgent, createAnthropicProvider } from "@berth/agents";

const { agent, computer } = await createAgent({
  apps: ["apps/filesystem"],
  llm: createAnthropicProvider(), // optional: omit it to auto-detect, pass createOpenAIProvider() or your own LLMProvider, or a plain object like { provider: "openai", apiKey, baseURL } for a custom endpoint
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

Composing multiple agents — in-process, or fully networked peers each on their own computer — is a first-class pattern here, not an afterthought. See [Multi-agent architecture](#multi-agent-architecture).

Want an app to review every other app's tool calls before they happen, allow or deny? See [Governance and scoping](#governance-and-scoping).

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
- **You declare capabilities up front.** `capabilities:` is a list of `namespace:action:scope` strings, things like `filesystem:write:/workspace`, `browser:navigate:*.github.com`, or `network:connect:8090`. Filesystem and network scoping is compiled into a kernel policy applied before your app's code ever runs; the rest is brokered or recorded — the [table below](#available-capabilities) says which per capability, and the [capability tokens reference](./docs/capability-tokens-reference.md) has the mechanics. An undeclared filesystem write or outbound connection is denied, not just left unenforced.
- **Granting a capability and exposing it aren't the same thing.** Declaring `browser:navigate:*` or `terminal:attach:*` is what lets `berth dev` publish the noVNC or ttyd port to the host, bound to `127.0.0.1` and gated by a password it prints per boot. Add an `expose:` block to opt out per app (`expose: { browser: false }`) and keep the capability while running headless. Both default to `true`. See the [manifest reference](./docs/manifest-reference.md). This one's local-`berth dev`-only; deploying the same app to E2B/Daytona/K8s needs its own, separate opt-in — `expose: { preview: true }`, defaulting to `false` since a deployed instance is potentially public-facing.
- **`on_install` and `app.onInstall(fn)` aren't interchangeable, and they no longer even run at the same time.** `on_install` in `berth.yml` is shell baked into the image as a build layer — `pip install -r requirements.txt` and the like. The SDK's `onInstall` is a TypeScript callback that runs at startup, inside your app's own sandboxed process. Changing `on_install` needs a rebuild, not just a `berth dev` restart. See the [manifest reference](./docs/manifest-reference.md#on_install-default-).
- **Network access is denied by default.** If your app needs to reach the outside world, route it through the egress broker instead of requesting a wide-open `network:connect:*`. See the [egress broker reference](./docs/egress-broker-reference.md) and `apps/browser-native`'s `berth.yml` for the pattern.
- **The egress broker can chain through a further upstream proxy.** Set `BERTH_EGRESS_UPSTREAM_PROXY` on the container and every *allowed* CONNECT (`browser:navigate:<pattern>` or `network:host:<pattern>`, same mechanism) tunnels through it instead of connecting directly — useful for a residential/rotating proxy provider when a target site blocks datacenter IP ranges. Capability enforcement still runs first; a denied host never reaches the upstream proxy either. See the [egress broker reference](./docs/egress-broker-reference.md#optional-chaining-through-an-upstream-proxy-eg-residential).

### Available capabilities

The `namespace:action:scope` grammar is wide open. You can declare a capability in a namespace nobody's used before, and `requestCapability()` will honestly tell you `granted: false`, because nothing actually backs it. The table below is what has real enforcement or brokering behind it today, the full list of permissions a resident app in a Berth OS can actually be given.

Looking to control what happens *after* a call is allowed, not just whether it's allowed at all? That's a different layer — see [Governance and scoping](#governance-and-scoping).

| Capability | Enforced by | Notes |
|---|---|---|
| `filesystem:write:<path>` (say, `filesystem:write:/workspace`) | Kernel (Landlock), always on | Restricts write, create, delete, rename, and truncate to the paths you declared, plus a `/tmp` baseline. Declare nothing and your app can still only write to `/tmp`. The path you declare must be under `/workspace`, `/context`, `/tmp`, or `/app` — it's created as root before enforcement starts, so it isn't a free-form string; `filesystem:write:/` is refused. |
| `filesystem:read:<path>` (say, `filesystem:read:/context`) | Kernel (Landlock), opt in | Declare at least one and read scoping turns on: a fixed baseline (`/usr`, `/lib`, `/etc`, `/proc`, `/dev`, `/tmp`, your app's own working directory) plus whatever you added. Declare none and reads stay fully open, same as always. Same four allowed prefixes as writes; a declared read path that doesn't exist at boot is warned about, not created. |
| `network:connect:<port>` or `network:connect:*` | Kernel (Landlock for TCP, seccomp for UDP/raw), denied by default | Declare no capability at all and you get no outbound network: zero TCP (Landlock), and no UDP, ICMP, or raw sockets either — Landlock has no access right for those, so `agent-init` drops `CAP_NET_RAW` and installs a seccomp filter that refuses to hand those apps a datagram or packet socket at all. Declare even one port and UDP comes back, because you need DNS to use that port by name; that's the current limit, and the fix is to route those apps' DNS through the egress broker. Scoping is by port only, not domain. `*` is an explicit, audited escape hatch for apps that genuinely need to reach arbitrary ports; every first-party app avoids it, scoping instead to a single broker port (`browser-native` and `github-assistant` both do this, see below). |
| `network:peer:<name>` or `network:peer:*` | `mesh-coordinator` (mutual consent) plus a real WireGuard mesh | Joins the mesh with any other app whose own `network:peer:<pattern>` names this app back. A one-sided declaration never gets introduced to its target. See the [mesh reference](./docs/mesh-reference.md). |
| `browser:navigate:<pattern>` (say, `browser:navigate:*.github.com`) or `network:host:<pattern>` | The egress broker, at the host level rather than the kernel | Same mechanism, two names — `network:host:*` is the generic form any resident app can declare, not just one that also drives a browser (see `examples/resident-apps/http-fetch`, or `examples/resident-apps/generic-connector`/`@berth/sdk`'s `defineConnectorApp()` for a whole declarative-REST-integration pattern built on it); call `@berth/sdk`'s `configureEgressProxy()` once to route your own `fetch()` traffic through it. The broker reads the CONNECT target's hostname straight off the (cleartext) proxy handshake and checks it against your pattern. You'll also need `network:connect:<broker's port>` declared (`8090` by default), since Landlock only sees ports. See the [egress broker reference](./docs/egress-broker-reference.md). |
| `browser:screenshot:*` | Recorded and reported only | Nothing kernel- or broker-enforced here on its own. Declaring any `browser:*` capability is what makes `berth dev` publish the noVNC/VNC ports — loopback-bound, VNC-password-gated. (Chromium's CDP port stays on the container's own loopback and is never published.) Opt out with `expose: { browser: false }`. |
| `terminal:attach:*` | Pty device access, kernel-enforced | Declaring it grants Landlock write access to `/dev/pts` and `/dev/ptmx` — a shell can't allocate a pty without it. It does *not* scope what the shell may then do; that comes from the app's `filesystem:`/`network:` capabilities, inherited by every process it spawns. It's also what makes `berth dev` publish the ttyd port — loopback-bound, gated by HTTP basic auth with a per-boot credential. Opt out with `expose: { terminal: false }`. |
| `github:read:<scope>` / `github:write:<scope>` (say, `github:read:repos`, `github:write:issues`) | A real TLS-terminating GitHub API broker, verb-and-path level | GET and HEAD map to `read`, everything else maps to `write`. The path is normalized and matched against an explicit route table that denies anything it doesn't cover — `/repos/<owner>/<repo>` is `repos`, the segment after it is its own scope (`issues`, `pulls`), `/user/emails` is `user:emails`, and so on. You'll also need `network:connect:<broker's port>` declared (`8092` by default). See the [GitHub API scoping reference](./docs/github-api-scoping-reference.md). |

Granting a capability and exposing its session to a human watcher are two separate decisions either way, see `expose:` above.

### What isn't enforced yet

Three enforcement tiers run through that table, and the difference matters more than any single row. If you're evaluating Berth as a security boundary rather than a convenience, read [docs/threat-model.md](./docs/threat-model.md) — it names the adversaries, the trust boundaries, and what holds each one.

| Tier | Mechanism | What it means for you |
|---|---|---|
| **Kernel** | Landlock (filesystem writes and reads, outbound TCP by port), seccomp-bpf (UDP/ICMP/raw sockets, and namespace creation), capability dropping | Irrevocable, inherited across `execve()`, applied before your app's first line runs. Nothing in the container can widen it. Needs a kernel that provides Landlock — see [Kernel enforcement, by platform](#kernel-enforcement-by-platform). |
| **Broker** | The egress broker, the GitHub API broker | A real process in the request path that can be bypassed only by reaching the network some other way — which is what the kernel tier is there to prevent. Host- and verb/path-level, so more expressive than the kernel tier, and softer. |
| **Recorded** | `browser:screenshot:*`, any namespace nobody's implemented | Reported honestly by `requestCapability()` and used for `expose:` decisions. Not a control. Don't build a security argument on one. |

And the parts that aren't closed yet. These are tracked with evidence, fixes, and verification steps in [REMEDIATION.md](./docs/internal/REMEDIATION.md), and they're listed here rather than there-only because they change what you should be willing to run:

- **Cross-app calls are authorized at connect, not per export.** An app reaches a sibling's exports only by declaring `app:invoke:<name>`, which gets it a socket of its own that no other uid can traverse — so the target knows which app is calling, and an app that declared nothing gets `EACCES` from the kernel ([1.4](./docs/internal/REMEDIATION.md#14--app-rpc-sockets-in-world-writable-tmp-unauthenticated), closed). But the kernel's part is a *connect-time* gate: once a caller is authorized, DAC lets it reach the target's whole export surface. Per-export policy is now expressible above it — a loaded governance app sees every one of those calls, with the caller's name, and can refuse individual exports ([1.13](./docs/internal/REMEDIATION.md#113--governance-gate-bypasses), closed).
- **A manifest is still code you run, just at build time now.** `on_install` no longer executes at container boot as unsandboxed root (that was [1.5](./docs/internal/REMEDIATION.md#15--on_install-is-unsandboxed-root-shell-run-before-enforcement), now closed) — it's a Docker build layer. That removes it from the running sandbox entirely, but installing a third-party app still means executing its shell on your machine, with your build daemon's authority, when you build the image.
- **The governance gate is not a sandbox.** It now fails *closed* by default ([1.11](./docs/internal/REMEDIATION.md#111--signals-unrestricted-any-app-can-kill-the-governor)) and sits on the Computer's dispatch rather than one tool array, so it covers every resident-app call through a Computer, MCP tools, and `Agent.asTool()` delegation ([1.13](./docs/internal/REMEDIATION.md#113--governance-gate-bypasses)). A second gate in `@berth/sdk` now covers the transports that never touch a Computer — `berth rpc`, `berth mcp`, the HTTP RPC bridge, the TCP listener and a sibling's direct socket call — so a denial holds whichever way the container is entered. It remains a policy layer, not a kernel mechanism, and root on the host is outside it. See [Governance and scoping](#governance-and-scoping).

The short version: **kernel-enforced filesystem and network scoping is real and testable today; cross-app and in-container privilege isolation is in progress.** Berth is a strong boundary around what an agent's *code* can touch, and not yet a boundary you should trust against a determined attacker who already has code execution inside the container.

The full version — assets, adversaries, trust boundaries, and what's out of scope permanently versus not yet — is [docs/threat-model.md](./docs/threat-model.md).

Full manifest schema lives in [docs/manifest-reference.md](./docs/manifest-reference.md). Full SDK surface (`defineApp`, `ContextBusClient`, `SemanticFsClient`, `requestCapability`) lives in [docs/sdk-reference.md](./docs/sdk-reference.md). Building in Python instead of TypeScript? See [docs/sdk-python-reference.md](./docs/sdk-python-reference.md) for resident apps, or [docs/agents-python-reference.md](./docs/agents-python-reference.md) for a Python `Agent`/`Crew` core (six of `Crew`'s seven composition shapes — all but `networked` — checkpointing, streaming, structured-output repair, and `Computer.connect()` for a real sandbox's tools over `berth os up --http-rpc` — see that doc's scope notes).

### Talking to other apps

Apps sharing a Berth OS get two things for free, both reachable from `AppContext` inside `onAgentReady`:

- **Context bus** (`ctx.contextBus`): `register`, `publish(topic, payload)`, `subscribe(topic, handler)`. A Rust daemon gives you real pub/sub between apps with no explicit orchestration. One app writes a file, another reacts to `fs.file_created`, and neither one knows the other exists. See [docs/context-bus-reference.md](./docs/context-bus-reference.md).
- **Semantic FS** (`ctx.semanticFs`): `register`, `tag(path, meta)`, `query(text, limit)`. A filesystem mounted at `$BERTH_CONTEXT_MOUNT` (`/context` by default) that carries metadata about *why* each file exists — `created_by` (attributed automatically), plus the `task` and `relatedApps` you tag it with — and lets any app search that metadata instead of needing the exact path. Be clear about what the search is: a hybrid keyword-and-embedding ranker over **tag text**, not file content, and only for files something explicitly tagged. See [docs/semantic-fs-reference.md](./docs/semantic-fs-reference.md#query-semantics--hybrid-keyword--embedding-similarity).

`apps/filesystem` and `apps/code-editor` show this in action: the first publishes `fs.file_created`, the second reacts to it.

Want more than one app in a single Berth OS, each still independently enforced by Landlock? Check [docs/multi-app-reference.md](./docs/multi-app-reference.md) and pass `--apps` to `berth dev`, or to `berth os up`.

**Looking for something to build?** The first-party apps above are a small starting set. [CONTRIBUTING.md](./CONTRIBUTING.md#resident-apps-wed-love-to-see) has a running wishlist (Slack, Postgres, Gmail, Stripe, and more) plus the exact `berth init` → PR path.

## CLI reference

| Command | What it does |
|---|---|
| `berth doctor [--json]` | Check whether this host can actually enforce capabilities, and say so plainly. Exits non-zero when it can't — see [the doctor reference](./docs/doctor-reference.md) |
| `berth init <name>` | Scaffold a new resident app from a template |
| `berth dev` | Build a dev image, run it, hot-reload on source changes |
| `berth test` | Build the production image, validate exports against `berth.yml`, invoke each with a schema-valid stub, run your own `npm test` |
| `berth eval <file> [--history]` | Run a `@berth/agents` eval suite against a real Agent/Crew and check assertions about *behavior* — distinct from `berth test`'s manifest/export shape check; `--history` lists a suite's prior recorded runs |
| `berth agent run <file.yml> <task>` | Run a task against an Agent declared in a YAML config file — no code needed for the common case |
| `berth crew run <file.yml> <task>` | Run a task against a `sequential`/`parallel`/`withManager` Crew declared in a YAML config file |
| `berth deploy --fleet=<e2b\|daytona\|k8s> [--region=<value>]` | Deploy to a remote sandbox provider — `--region` meaning differs per adapter (Daytona snapshot region, k8s node selector, no-op on E2B) |
| `berth logs <app>` | Stream logs from an already-running dev or fleet container |
| `berth rpc <app> --export=<name> --input=<json>` | Call a resident app's export directly from the host |
| `berth mcp --app=<name> [--only=<export1>,<export2>]` | Bridge a running app's exports to MCP tools, for Claude Desktop/Code or any MCP client — `--only` scopes which exports get bridged instead of exposing everything |
| `berth publish --registry=<url> [--token=<value>]` | Build and publish the app to a running app registry — `--token` is required to publish a new version of a name someone already published |
| `berth snapshot create\|list\|restore [--fleet=<name>]` | Checkpoint and restore a container plus its semantic-fs context data — `--fleet` pauses/resumes (E2B) or snapshots (Daytona) a remote instance instead |
| `berth snapshot fork <app> --fleet=<name>` | Fork a running remote instance into a new, independent clone (Daytona only) |
| `berth grants list\|approve\|deny [--token=<value>]` | Review and resolve pending human-approval capability requests — `approve`/`deny` need the grants-server operator token |
| `berth fleet status <fleet>` | Check the state of a configured remote fleet (`e2b`, `daytona`, or a `~/.berthrc` alias) |
| `berth fleet scale <fleet> --count=<n>` | Manually scale this app's instances on a fleet up or down to a target count — not automatic load-based autoscaling |
| `berth os up\|down\|status` | Boot a long-lived Berth OS once, then reconnect to it instantly instead of rebuilding on every dev iteration |

Run `berth <command> --help` to see the flags. A few of these deserve their own doc: [MCP bridge](./docs/mcp-bridge-reference.md), [app registry](./docs/app-registry-reference.md), [computer snapshots](./docs/computer-snapshots-reference.md), [capability tokens and grants](./docs/capability-tokens-reference.md), [K8s adapter](./docs/k8s-adapter-reference.md), [what is a Berth OS](./docs/berth-os.md), and [the `berth os` command reference for cold start](./docs/berth-os-reference.md).

## Testing and deploying

```bash
pnpm exec berth test              # build prod image, validate exports, run stub invocations + your own tests
pnpm exec berth test --json       # CI-friendly output

berth deploy --fleet=e2b          # or --fleet=daytona, --fleet=k8s, or an alias from ~/.berthrc
```

### Releasing

Not published yet (see the note at the top), but the pipeline is real and dry-run-verified: `pnpm publish:npm:dry-run` (root `package.json`) builds every workspace package and packs each non-private one (everything under `packages/`, skipping `apps/`/`examples/`/test fixtures, which are all `"private": true`) exactly as `npm publish` would, without uploading. `.github/workflows/publish-npm.yml` and `.github/workflows/publish-pypi.yml` run that same pipeline (plus the `berth-agents` PyPI package's own build) from CI — both `workflow_dispatch`-only, dry-run by default, and only publish for real when a human explicitly flips `dry_run` to `false` on a manual run.

## Repository layout

```
packages/
  manifest-schema/     berth.yml schema, validation, and capability parsing
  sdk/                 resident app SDK: defineApp(), lifecycle hooks, context bus client
  docker-orchestrator/ Alpine-based container lifecycle for a Berth OS
  context-bus-daemon/  Rust daemon for shared semantic memory across apps in one Berth OS
  agent-init/          Rust binary that applies a kernel-enforced (Landlock) capability policy before exec-ing the runtime
  semantic-fs-daemon/  Go/FUSE daemon, a filesystem searchable by its files' tags, backed by a SQLite metadata index
  registry-server/     local app registry for publish, discover, and install (Fastify + SQLite)
  grants-server/       human approval service for capability grants (Fastify + SQLite)
  mesh-coordinator/    coordination service for the WireGuard mesh: allocates IPs, exchanges keys, mutually matches peers
  mesh-daemon/         Rust daemon that reconciles a sandbox's WireGuard config against mesh-coordinator's state
  adapters/            deploy adapters for E2B, Daytona, and Kubernetes
  cli/                 the `berth` CLI: init, dev, test, publish, deploy, os
  sdk-python/          Python resident app SDK, wire-protocol compatible with @berth/sdk
  agents/              computer, then agent, then tool: boots a Berth OS from resident apps, drives it with any LLM provider, composes multi-agent Crews
  agents-python/       Python Agent/Crew core (checkpointing, streaming, structured-output repair, all Crew shapes but networked) plus Computer.connect() over berth os up --http-rpc for a real sandbox's tools — no Computer.boot() yet
apps/
  browser-native/      first-party resident app: headless Chromium plus VNC, also exposes search (DuckDuckGo, no API key)
  filesystem/          first-party resident app that reads and writes /workspace, publishes fs.file_created
  code-editor/         first-party resident app that reacts to fs.file_created through the context bus
  github-assistant/    first-party resident app, the original example manifest for this pattern, deployed and milestone-tested
  hello-world-py/      minimal Python resident app proving the Python SDK's RPC wire compatibility
  terminal/            first-party resident app: a shared shell (tmux + ttyd), driven by the agent and watchable live over the web
  activity-feed/       first-party resident app that fans in fs.file_created and notes.* into one queryable feed
  notes/               first-party resident app for stateful notes (add, list, complete), persisted to /workspace
  code-interpreter/    first-party resident app: run_code executes Python/JavaScript/shell as a real subprocess, kernel-sandboxed like every other app — no network unless you declare it
examples/
  resident-apps/       resident app examples you run with `berth dev` (hello-world/ is the minimal, zero-capability one; http-fetch/ shows network:host:* + configureEgressProxy() on a plain, non-browser app)
  agents/              agent examples that depend on @berth/agents as a real (workspace:*) package dependency (simple-agent/ is computer, agent, tool; agent-server/ serves the agent over HTTP instead of driving something itself)
```

## Something not working?

Run **`berth doctor`** first. It reports whether the kernel that runs your apps can enforce anything at all, whether Docker is reachable, and what to do about each answer — most "it built but nothing is being enforced" reports on macOS are answered by its first line. Full output contract: [docs/doctor-reference.md](./docs/doctor-reference.md).

Found a [bug](./.github/ISSUE_TEMPLATE/bug_report.md), something confusing about the [workflow](./.github/ISSUE_TEMPLATE/workflow_feedback.md), or want to pitch a [resident app](./.github/ISSUE_TEMPLATE/resident_app_proposal.md)? Tell us. Those reports are exactly what we need right now.

## License

Apache-2.0. See [LICENSE](./LICENSE).
