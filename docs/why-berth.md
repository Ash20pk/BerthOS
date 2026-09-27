# Why Berth

An agent is only as safe as the tools it can call. Berth gives those tools a boundary the Linux kernel enforces, so you can hand an agent a real shell, a real filesystem and a real browser without handing it your machine. The short version is in the [README](../README.md); this page makes the longer case.

## The problem

Agent frameworks give you a loop and a tool registry. They don't give the agent a computer to work on. That part is left to you: a subprocess here, a sandbox VM there, and a system prompt asking the model to behave.

A system prompt is not a permission system. The moment a model reads attacker-controlled text (a web page, a file, a tool result), it can be talked into calling any tool it has, with any arguments. If the file tool can write anywhere, a prompt injection can too. Today you get two choices: give the agent full access and hope, or give it so little that it can't do the job.

Teams that ship agents past a demo hit the same gaps:

- **No real permission boundary.** Nothing between "full shell" and "no shell". Nothing that says "this tool writes to `/workspace` and nowhere else" and means it.
- **No way to see what happened.** When something goes wrong you read logs afterwards instead of watching the agent's browser or terminal.
- **No memory between runs.** Files, notes and state vanish when the session ends.
- **Tools that can't coordinate.** Two tools that need to react to each other get glued together in your orchestration code.

## What Berth does about it

Every tool runs as a *resident app* with a manifest, `berth.yml`, that lists what it may touch: `filesystem:write:/workspace`, `network:connect:443`, `browser:navigate:*.github.com`. Before the tool's first line of code runs, Berth compiles that list into Landlock and seccomp rules. Anything not declared is refused by the kernel. A prompt-injected write to `/etc` doesn't get argued down; it fails with `EACCES`.

This changes what you have to trust. You no longer need the model to follow instructions. You need the manifest to be right, and the manifest is a short file you can read and review.

Where the kernel can't see what matters (it sees ports, not hostnames), a proxy enforces it instead: browsing by hostname and GitHub API calls by method and path. Which capability is enforced where is listed in [enforcement](./kernel-enforcement.md#available-capabilities).

Around that boundary you also get the other missing pieces: a live view of the agent's browser and terminal, state that survives the run, and a context bus that lets apps react to each other.

## Use cases

**A coding agent with a real shell, not your whole machine.** Give it [`apps/filesystem`](../apps/filesystem) and [`apps/terminal`](../apps/terminal) and it can write files, run tests and drive a shell. `filesystem:write:/workspace` is enforced by the kernel, so `rm -rf /etc` from that shell fails with `EACCES`, and everything the shell starts inherits the same limits. When it writes a file, `apps/filesystem` publishes `fs.file_created`, and [`apps/code-editor`](../apps/code-editor) reacts to it over the context bus with no orchestration code from you.

**A browser agent you can supervise.** [`apps/browser-native`](../apps/browser-native) researches, fills in forms and runs QA, limited to the hostnames it declares, such as `browser:navigate:*.example.com`, by the egress proxy. Under `berth dev` you get a live noVNC view to watch it or take over. Set `expose: { browser: false }` and the same agent, with the same limits, runs headless in CI.

**An agent that runs its own code.** [`apps/code-interpreter`](../apps/code-interpreter)'s `run_code` runs Python, JavaScript or shell as a real subprocess. It's already inside the kernel sandbox, so with no `network:connect:<port>` declared, that code gets no outbound TCP, and no UDP, ICMP or raw sockets either. There's no second sandbox to set up.

**An agent limited to one API action.** [`apps/github-assistant`](../apps/github-assistant) can read repos and open issues, and nothing else. `github:read:repos` and `github:write:issues` are checked per request, by method and path, by a TLS-terminating proxy, not left to the scopes of an API token. See [GitHub API scoping](./github-api-scoping-reference.md).

**An assistant that remembers.** [`apps/notes`](../apps/notes) keeps state on disk and [`apps/activity-feed`](../apps/activity-feed) keeps one searchable history of what happened. `berth snapshot create` and `berth snapshot restore` checkpoint the whole Berth OS (files, tags and context) so a restart doesn't wipe what the agent knows.

**Several agents, each with only what it needs.** Boot one shared sandbox with `berth os up team --apps=apps/filesystem,apps/notes,apps/terminal`, then scope a writer agent to `filesystem` and a note-taker to `notes`. One sandbox, least privilege per agent. This uses the experimental agent framework; see [Multi-agent architecture](./berth-agents-guide.md#multi-agent-architecture).

## How it fits with what you already use

Berth sits underneath your tools. It doesn't replace your agent or your framework.

- **You already use Claude Code, Cursor or Claude Desktop.** Add `berth mcp` to the client's config and the agent gets Berth's tools as ordinary MCP tools. No code. See [the MCP quickstart](./mcp-quickstart.md).
- **You already have a tool-calling loop.** Pass Berth's tools to it; see below.
- **You already run on E2B, Daytona or Kubernetes.** Berth adds the app model and the kernel-enforced permissions on top. `berth deploy --fleet=e2b|daytona|k8s` ships the same sandbox definition there.
- **You want a Berth-native agent.** The agent framework, `@berthos/agents`, adds agents, crews, governance, tracing and serving over HTTP. It's experimental and unpublished, and runs from a clone. Start with [Building a Berth Agent](./berth-agents-guide.md#building-a-berth-agent).

## Use it from your existing framework

Boot a `Computer` and hand its tools to the loop you already run:

| Your stack | The call |
|---|---|
| Vercel AI SDK | `await toAiSdkTools(computer.tools)` → pass as `tools` to `generateText`/`streamText`/`useChat` |
| LangChain / LangGraph | `await toLangChainTools(computer.tools)` → pass to `createReactAgent({ tools })`, `ToolNode`, `bindTools` |
| Claude Code, Cursor, any MCP client | `berth mcp --app=<name>`: an MCP server, no adapter needed |
| Anything else | `toToolSpecs(computer.tools)`: name, description, JSON Schema, and a call function |

`Computer` and these adapters come from `@berthos/agents`, which is experimental and not published, so use them from a clone. The Vercel AI SDK and LangChain packages are optional peer dependencies: install only the one you use. An `abortSignal` from `generateText` reaches the resident app's call and stops it. A full example is in [`examples/agents/with-vercel-ai-sdk`](../examples/agents/with-vercel-ai-sdk).

What your loop gets is the point: a file tool whose write scope is enforced by the kernel, a shell whose reach is set by a manifest, a browser limited by a proxy, and state that survives the run.

## Limits

- Kernel enforcement needs Landlock (Linux 6.7+). Docker Desktop on macOS and Windows doesn't have it; `berth doctor` checks, and `berth doctor --fix` sets up a Mac VM that does.
- When Berth can't enforce, it runs apps unrestricted with a warning, unless `BERTH_REQUIRE_ENFORCEMENT=1` is set. `Computer.boot()` sets it.
- Root on the host bypasses the sandbox: anyone who can `docker exec` into the container gets past every rule.

What's in and out of scope: [the threat model](./threat-model.md). What isn't enforced yet: [enforcement](./kernel-enforcement.md#limits).
