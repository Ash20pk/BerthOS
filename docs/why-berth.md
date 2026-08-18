# Why Berth

> Relocated from the README when it was compressed to a thesis and a demo. Nothing
> here was rewritten to sound better than it is; the caveats moved with the claims.

The one-paragraph version is in the [README](../README.md). This is the longer
argument: the gap Berth fills, what you get, and what jobs it makes shippable.

## The problem

Every agent framework gives you a loop and a tool registry. What it doesn't give you is a computer for the agent to actually stand on. That part is on you: a Python subprocess here, a raw sandbox VM there, a pile of API clients holding the whole thing together. None of it remembers what happened last time. None of it stops the agent from doing something you didn't mean for it to do.

That gap turns into the same four problems on every team that ships an agent past a demo.

- **No permission boundary.** Your agent has full shell access or none. There's no middle ground where a tool can write to `/workspace` and nowhere else, enforced for real instead of politely requested in a system prompt.
- **No memory between runs.** Every session starts from zero. Whatever the agent built up, files, notes, browser state, has to be re-derived or manually stitched back together.
- **No way for tools to talk to each other.** A search tool and a file writer that need to coordinate get glued together by hand in your orchestration code, or they don't coordinate at all.
- **No way to watch it work.** When something breaks, you're reading logs after the fact instead of watching the agent's browser or terminal live, right as it happens.

Berth exists so these four things are infrastructure you get for free, not homework every team rebuilds from scratch.

## Use cases

Each of these is a real job people give an agent. What actually makes it shippable is what the Berth OS underneath enforces or provides, not how much you trust the agent to behave.

**A coding agent with real filesystem and shell access, without handing it your whole machine.** Give it `apps/filesystem` and `apps/terminal` and it can write files, run tests, and drive a real shell. Here's what narrows the blast radius: `filesystem:write:/workspace` is enforced by the kernel (Landlock), so a prompt-injected "ignore previous instructions, delete everything" is refused by the kernel rather than by a framework check it could talk its way past — `rm -rf /etc` from that shell dies on `unlink(2)` with `EACCES`. That's the write path specifically, and it's the boundary to plan around: `terminal:attach:*` grants the pty devices the shell needs, not any widening of what that shell may touch, so the filesystem and network scoping is inherited by everything it spawns. There are still [gaps open around the sandbox](./kernel-enforcement.md#what-isnt-enforced-yet) that a determined in-container attacker can work with. The file it writes can also trigger `apps/code-editor` to react over the context bus — `apps/filesystem` publishes `fs.file_created`, `apps/code-editor` subscribes to it — with zero orchestration code from you.

**A browser agent a human can actually supervise.** It researches, fills out forms, does QA, scoped to `browser:navigate:*.example.com` by the egress broker rather than a system prompt instruction it could be talked out of. Open the live noVNC session in `berth dev` and you can watch, or take over, the exact browser it's driving instead of piecing together what happened from a log afterward. Flip `expose: { browser: false }` and the same, identically scoped agent runs headless in CI.

**An assistant that actually remembers you.** `apps/notes` gives it real persisted state instead of a context window that resets every session, and `apps/activity-feed` gives it one queryable history across everything that happened. `berth snapshot create/restore` checkpoints the whole Berth OS, files, tags, context and all, so a container restart doesn't wipe what the agent knows.

**A team of agents, each scoped to only what it needs, sharing one sandbox.** Boot one shared Berth OS with `berth os up team --apps=apps/filesystem,apps/notes,apps/terminal`, then get a writer agent scoped to just `apps/filesystem` and a notetaker scoped to just `apps/notes` with `createAgent({ connect: { name: "team", apps: ["filesystem"] } })` and `createAgent({ connect: { name: "team", apps: ["notes"] } })`. One running sandbox, least privilege per agent, nothing to rebuild between runs. Need each agent driving its own LLM loop on its own computer instead? See [Multi-agent architecture](./berth-agents-guide.md#multi-agent-architecture).

**An agent behind a real API, not a one-shot script.** [`examples/agents/agent-server`](../examples/agents/agent-server) boots once and calls `serveAgent()`, answering `POST /task` and a `useChat`-compatible `POST /chat` against the same `Agent` for as long as the process runs. Pair it with `berth os up` and `BERTH_OS_CONNECT`, and restarting the server during development reconnects to the sandbox in milliseconds instead of rebuilding it on every code change.

**An agent scoped to exactly one third-party API action, nothing wider.** `apps/github-assistant` can read repos and open issues, and only that. `github:read:repos` and `github:write:issues` are enforced verb-and-path level by a real TLS-terminating broker, not just "has an API key with these OAuth scopes." It's a deployed, milestone-tested example of least-privilege access for any agent that needs to touch a real external API. See the [GitHub API scoping reference](./github-api-scoping-reference.md).

**An agent that writes and runs its own code, without a bolted-on sandbox.** `apps/code-interpreter`'s `run_code` executes a Python, JavaScript, or shell snippet as a real subprocess and hands back stdout/stderr/exit code — the same primitive AutoGen ships a separate Docker executor for and OpenAI/CrewAI reach for E2B to get. Here it's just another resident app: the code it runs is already inside this agent's own kernel-enforced sandbox, so declaring no `network:connect:<port>` capability means that code gets no outbound network — no TCP (Landlock), and no UDP, ICMP, or raw sockets either (a seccomp filter, since Landlock has no access right for those) — the same deny-by-default guarantee every other app gets — not a second isolation boundary you have to configure separately.

**An agent that delegates to (or gets called by) agents built on something else entirely.** `createA2aClientTool(url)` lets a Berth agent hand off a task to any [A2A](https://a2a-protocol.org)-compliant agent — one built on ADK, LangGraph, Microsoft Agent Framework, or anything else that speaks the protocol — the same way it would delegate to a worker built on Berth itself. `serveAgentAsA2a(agent)` is the other direction: those same frameworks' agents can call into a Berth agent as a standard A2A peer, no Berth-specific glue on their side at all.

Convinced, or just curious? Let's get something running.

## Why `@berth/agents`

| | What you get |
|---|---|
| **One call to a working agent, instant reconnects while you iterate** | `runAgent({ apps: "apps/filesystem", task: "..." })` figures out your LLM provider on its own and cleans up after itself. No boilerplate. `berth os up` boots the sandbox once, then `connect: "<name>"` reattaches in milliseconds instead of rebuilding it on every dev loop run. |
| **Multi-agent by default, not bolted on** | `Crew.sequential()`/`Crew.withManager()` compose agents in-process; `Crew.networked()` goes further — each peer is a full, independently-LLM-driven agent on its own Berth OS, joined over a real Docker network, not just a delegated tool call. See [Multi-agent architecture](./berth-agents-guide.md#multi-agent-architecture). |
| **A governance gate any app can become** | Declare `governs: true` and export `evaluate_action`, and every other app's tool calls route through your policy first — human approval, an ML classifier, whatever you want — before they execute. See [Governance and scoping](./berth-agents-guide.md#governance-and-scoping). |
| **Bring your own LLM, own your deploy target** | `@berth/agents` wires any LLM provider (Anthropic, OpenAI, Gemini, Azure OpenAI, Bedrock, Ollama, a custom endpoint through `{provider, apiKey, baseURL}`, or your own `LLMProvider`) into a Berth OS's resident apps as tools. `berth deploy --fleet=e2b\|daytona\|k8s` ships the same sandbox definition to whatever provider you already run on. |
| **The whole MCP ecosystem, not just resident apps** | `createAgent({ mcpServers: [...] })` connects to any external [MCP](https://modelcontextprotocol.io) server (stdio or Streamable HTTP) and merges its tools in alongside your Computer's own — `createMcpClientTools()` in TypeScript, `create_mcp_client_tools()` in Python. `berth mcp --app=<name>` is the other direction: exposing a resident app's exports *to* an MCP client like Claude Desktop. |
| **Traces your existing observability stack already understands** | `trace: "otel"` emits real OpenTelemetry GenAI-semantic-convention spans for every LLM turn and tool call — Langfuse, Phoenix, Honeycomb, Datadog, or a plain OTel Collector all pick them up with no Berth-specific integration. `trace: "full"` stays available for durable, Semantic-FS-backed replay without any external backend at all. |
| **Guardrails on the model's own input and answer, not just its tool calls** | `inputGuardrails`/`outputGuardrails` gate what goes into and comes out of the model itself — a tripped one halts the run via `GuardrailTripwireError`, distinct from the governance gate (tool calls) and human-in-the-loop approval (a live decision) above. Built-in `createKeywordGuardrail()`/`createRegexGuardrail()`/`createLlmGuardrail()` cover the common cases; write your own for anything else. |
| **Conversation history across separate `run()` calls, not just one durable run** | `createAgent().run(input, { session })` shares message history across turns — a chat UI's turns, say — distinct from checkpointing's crash-resume of *one* run. `createInMemorySession()` for a dev loop, `createSemanticFsSession(computer, sessionId)` for durable history reached through the same resident-app exports checkpointing already uses. |
| **A real HTTP surface to serve an agent to a frontend, `useChat` included** | `serveAgent(agent, { port })` — `GET /health`, `POST /task`, and `POST /chat`, a [Vercel AI SDK](https://ai-sdk.dev) `useChat`-compatible streaming endpoint verified against the actual `ai` package's own client-side stream parser, not just written to match docs. `createAgentRequestHandler()` is the composable building block underneath, for mounting inside your own server instead. |
| **A2A interop — talk to agents outside Berth, and let them talk to yours** | `createA2aClientTool(agentCardUrl)` wraps any [A2A](https://a2a-protocol.org)-compliant agent (ADK, LangGraph, Microsoft Agent Framework, anything) as a `Tool`; `serveAgentAsA2a(agent, { port })` exposes a Berth Agent as a real A2A server those same frameworks can call into. Built on the official `@a2a-js/sdk` and verified against a real client+server round trip through it, not just written to match the spec text. |

What backs every one of those calls, in brief — full picture in [What is a Berth OS?](./berth-agents-guide.md#what-is-a-berth-os):

| | What you get |
|---|---|
| **Permissions that are enforced, not just requested** | Every resident app declares `namespace:action:scope` capabilities in its manifest, things like `filesystem:write:/workspace` or `browser:navigate:*.github.com`. A Landlock policy built from that manifest applies before your code even runs, on a kernel that provides Landlock ([which hosts do](./kernel-enforcement.md#kernel-enforcement-by-platform)). An undeclared *write* isn't caught by a try/catch — the kernel refuses the syscall outright. Outbound network is denied the same way. Other capabilities are enforced by a broker, or only recorded: which is which is [spelled out per capability](./kernel-enforcement.md#available-capabilities), along with [what isn't enforced yet](./kernel-enforcement.md#what-isnt-enforced-yet). |
| **State that survives the session** | A filesystem whose files carry *why they exist* — `created_by`, `task`, `related_apps` — searchable by that metadata rather than only by path, plus `berth snapshot create/restore`, means an agent's work (files, tags, context) outlives any single run. It searches what you tagged, [not file contents](./semantic-fs-reference.md#query-semantics--hybrid-keyword--embedding-similarity). |
| **Apps that talk to each other without you wiring it** | The context bus is pub/sub between resident apps in the same Berth OS. A filesystem app writes a file, a code editor app reacts to it. Neither one imports or calls the other. |
| **A workspace you can actually watch, and you decide how much** | In local `berth dev`, `apps/browser-native` opens a live noVNC view of the sandboxed Chromium instance, and `apps/terminal` opens a live, typeable `ttyd` session. You're watching the real thing, not a transcript of it. Set `expose: { browser: false }` or `{ terminal: false }` in `berth.yml` to keep the capability while running headless in CI. Deployed to E2B or Daytona? Opt in with `expose: { preview: true }` and `berth deploy`/`berth fleet status` print that same live view as a real, platform-hosted URL — off by default, since a deployed fleet is potentially public-facing. On Kubernetes, that same opt-in only gets you the in-cluster DNS name; a real public URL there still needs your own Ingress/LoadBalancer. See [Resident apps](./resident-apps.md). |

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
