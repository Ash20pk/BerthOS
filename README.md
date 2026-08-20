# Berth

**IAM for agents: declare what your agent may touch, and the kernel enforces it.**

The cloud solved this for humans and services decades ago — declared policy, enforced by the platform rather than the application, with an audit trail compliance can run on. Agents have none of that: frameworks trust the model, sandboxes are permission-blind *inside* the box, guardrails filter words rather than actions. Berth is the missing layer — the **agent trust layer**.

Your agent gets a persistent, sandboxed computer — a **Berth OS** — where what it's allowed to touch is a line in a manifest compiled into a [Landlock](https://docs.kernel.org/userspace-api/landlock.html) policy, applied before the app's own code runs. `filesystem:write:/workspace` means a write anywhere else dies on `EACCES` in the kernel, not in a `try/catch` and not in a system prompt the model can be talked out of. Every action lands in a hash-chained, actor-attributed [audit trail](./docs/audit-reference.md). (The third IAM leg — per-run *proof* that the policy was enforced — is in open development, and we won't claim it before it ships.)

> Agents are not functions. They are workers. Workers need desks — and permissions.

## Run it

```bash
npm install -g @berth/cli
berth doctor --fix      # macOS: provisions a Colima host whose kernel actually enforces
berth init my-app && cd my-app && berth dev
```

`berth doctor --fix` is the honest step most sandboxes skip: it checks whether
*your* Docker host's kernel can enforce Landlock, and on a default Mac (where
Docker Desktop's kernel can't) it offers to install and start the
[Colima host](./docs/mac-enforcement.md) that can — then re-checks and refuses
to claim enforcement it didn't observe.

Working from source instead:

```bash
git clone https://github.com/Ash20pk/BerthOS && cd BerthOS
corepack enable && pnpm install && pnpm build
cd examples/kernel-says-no && pnpm start        # no API key needed
```

## The demo

[`examples/kernel-says-no`](./examples/kernel-says-no) boots a Berth OS with one resident app — `apps/filesystem`, which declares `filesystem:write:/workspace` and nothing else — and calls the same `write_file` tool an agent would call, twice:

```
--- inside the declared scope ---
write /workspace/hello.txt -> ok, read back: "hello from a sandbox"

--- outside the declared scope ---
write /etc/berth-should-not-exist.txt -> EACCES: permission denied, open '/etc/berth-should-not-exist.txt'

PASS — the capability line in berth.yml is the boundary, and the kernel is the one holding it.
```

Nothing in that script, in `@berth/agents`, or in the app's own code inspects the second path. The manifest's capability list was compiled into a Landlock ruleset and applied by `agent-init` before the app's first line ran, so the write dies in `open(2)`. An agent that gets prompt-injected into trying it gets the same answer.

**The honest part:** that denial needs a host kernel that provides Landlock. Docker Desktop for Mac does not, and the example says so and exits non-zero rather than printing a denial it can't attribute to the kernel. On macOS, [docs/mac-enforcement.md](./docs/mac-enforcement.md) is a four-flag Colima recipe (no kernel build) where it's real — verified on Apple silicon, Landlock ABI 4. Run [`berth doctor`](./docs/doctor-reference.md) to see which host you're on. What is and isn't enforced, per capability and per tier: [docs/kernel-enforcement.md](./docs/kernel-enforcement.md).

## The fastest way in: point your agent at it over MCP

No framework, no SDK call, no `Agent` class — Berth is an MCP server, so the agent you already use can hold the sandbox directly:

```bash
claude mcp add berth-filesystem -- node /abs/path/BerthOS/packages/cli/bin/berth.js \
  mcp --app filesystem --app-dir /abs/path/BerthOS/apps/filesystem
```

`berth mcp` boots the sandbox itself, exposes exactly the exports `apps/filesystem`'s manifest declares, and stops the sandbox when your client disconnects. Ask your agent to write to `/etc` and it gets this back, rather than an errno:

```
BERTH CAPABILITY DENIAL
denied: open(2) on /etc/berth-should-not-exist.txt (EACCES: permission denied)
denied-by: the kernel — a Landlock ruleset compiled from "filesystem"'s berth.yml, applied before the app's first line ran
fix: none available — a berth.yml filesystem scope may only name /workspace, /context, /tmp, /app
```

Denials name the manifest line that would allow them (or say honestly that none would), and `denied-by:` says `the kernel` only where the kernel really did it. Run `--warm` once first, then read [docs/mcp-quickstart.md](./docs/mcp-quickstart.md) — setup for Claude Desktop/Cursor, scoping with `--only`, and the `DOCKER_HOST` gotcha on Colima.

## Keep the agent framework you already have

Berth's differentiator is what its tools are *made of*, so adopting a whole framework isn't the price of reaching it. Boot a `Computer`, hand its tools to the loop you already run:

| Your stack | The call |
|---|---|
| Vercel AI SDK | `await toAiSdkTools(computer.tools)` → pass as `tools` to `generateText`/`streamText`/`useChat` |
| LangChain / LangGraph | `await toLangChainTools(computer.tools)` → pass to `createReactAgent({ tools })`, `ToolNode`, `bindTools` |
| Claude Code, Cursor, any MCP client | `berth mcp --app <name>` — a real MCP server, no adapter at all ([5-minute setup](./docs/mcp-quickstart.md)) |
| Anything else | `toToolSpecs(computer.tools)` — name, description, JSON Schema, and a call function |

[`examples/agents/with-vercel-ai-sdk`](./examples/agents/with-vercel-ai-sdk) is the demo above with a real model in the loop and no Berth `Agent` anywhere in the file. Details, and why both adapters are optional peer dependencies: [docs/why-berth.md](./docs/why-berth.md#use-it-from-your-existing-framework).

Or use the framework in the box: `@berth/agents` is a full one — providers, agents, multi-agent crews, `runAgent()` for the simple case. It's the reference consumer of everything above, and it's optional. See [docs/berth-agents-guide.md](./docs/berth-agents-guide.md).

## Where everything went

This README used to be 500 lines. It's a hub now; nothing was deleted, including the caveats.

| Read this | For |
|---|---|
| [MCP quickstart](./docs/mcp-quickstart.md) | Adding Berth to Claude Code, Claude Desktop, or Cursor; what a denial looks like and how to read it |
| [Quickstart](./docs/quickstart.md) | Prerequisites, install and build, running an agent, running a resident app, the CLI reference, repository layout |
| [Enforcement](./docs/kernel-enforcement.md) | Kernel enforcement by platform, every capability and what enforces it, the kernel/broker/recorded tiers, **what isn't enforced yet** |
| [Threat model](./docs/threat-model.md) | Adversaries, trust boundaries, what holds each one, what's permanently out of scope |
| [Why Berth](./docs/why-berth.md) | The problem, the use cases, what `@berth/agents` gives you, using Berth from your existing framework |
| [Resident apps](./docs/resident-apps.md) | Building one: `berth.yml`, `defineApp()`, the gotchas, the context bus, the semantic filesystem |
| [`@berth/agents` guide](./docs/berth-agents-guide.md) | `Computer`/`createAgent`/`runAgent`, what a Berth OS is, multi-agent crews, the governance gate |
| [Getting started](./docs/getting-started.md) | The longer, resident-app-focused walkthrough |
| [`berth doctor`](./docs/doctor-reference.md) · [Mac enforcement](./docs/mac-enforcement.md) | Whether your host enforces anything, and how to get a Mac that does |

Reference docs for individual subsystems live in [docs/](./docs): [manifest](./docs/manifest-reference.md), [SDK](./docs/sdk-reference.md) ([Python](./docs/sdk-python-reference.md)), [agents](./docs/agents-reference.md) ([Python](./docs/agents-python-reference.md)), [Berth OS](./docs/berth-os.md) ([commands](./docs/berth-os-reference.md)), [semantic FS](./docs/semantic-fs-reference.md), [context bus](./docs/context-bus-reference.md), [egress broker](./docs/egress-broker-reference.md), [GitHub API scoping](./docs/github-api-scoping-reference.md), [TLS](./docs/tls-reference.md), [secrets](./docs/secrets-reference.md), [capability tokens and grants](./docs/capability-tokens-reference.md), [governance](./docs/governance-reference.md), [audit trail](./docs/audit-reference.md), [multi-app](./docs/multi-app-reference.md), [mesh](./docs/mesh-reference.md), [MCP bridge](./docs/mcp-bridge-reference.md), [app registry](./docs/app-registry-reference.md), [snapshots](./docs/computer-snapshots-reference.md), [K8s adapter](./docs/k8s-adapter-reference.md). Status of what's real: [ROADMAP.md](./ROADMAP.md).

## Two things to know before you build on it

- **`@berth/*` isn't on npm yet.** You build it from source — that's what `pnpm build` above is for. The publish pipeline is real and dry-run-verified; see [Releasing](./docs/quickstart.md#releasing).
- **Kernel-enforced filesystem and network scoping is real and testable today; cross-app and in-container privilege isolation is in progress.** Berth is a strong boundary around what an agent's *code* can touch, and not yet one you should trust against a determined attacker who already has code execution inside the container. The open items, with evidence: [what isn't enforced yet](./docs/kernel-enforcement.md#what-isnt-enforced-yet) and [docs/threat-model.md](./docs/threat-model.md).

## Something not working?

Run **`berth doctor`** first. It reports whether the kernel that runs your apps can enforce anything at all, whether Docker is reachable, and what to do about each answer — most "it built but nothing is being enforced" reports on macOS are answered by its first line. Full output contract: [docs/doctor-reference.md](./docs/doctor-reference.md).

Found a [bug](./.github/ISSUE_TEMPLATE/bug_report.md), something confusing about the [workflow](./.github/ISSUE_TEMPLATE/workflow_feedback.md), or want to pitch a [resident app](./.github/ISSUE_TEMPLATE/resident_app_proposal.md)? Tell us. Those reports are exactly what we need right now. [CONTRIBUTING.md](./CONTRIBUTING.md) has the wishlist and the PR path.

## License

Apache-2.0. See [LICENSE](./LICENSE).
