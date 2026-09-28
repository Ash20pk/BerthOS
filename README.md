# BerthOS

**Your agent decides what to call. Berth decides what those calls can touch, and the Linux kernel enforces it.**

Agents act through tools: a filesystem, a shell, a browser, a code interpreter. Berth runs those tools in a sandbox and gives each one a manifest listing exactly what it may touch. Before the tool's first line of code runs, the manifest is compiled into kernel rules. So when a prompt-injected model tries to write outside its folder, it isn't talked out of it by a system prompt. The write fails with `EACCES`.

Keep your agent and keep your framework. Berth sits underneath the tools.

## How it works

```mermaid
flowchart LR
  subgraph agent["Your agent, unchanged"]
    MCP["Claude Code · Cursor · Claude Desktop<br/>any MCP client"]
    LOOP["Vercel AI SDK · LangChain<br/>any tool-calling loop"]
  end

  subgraph berth["Berth sandbox"]
    APP["Resident app<br/>(the tool, e.g. filesystem)"]
    MANIFEST["berth.yml<br/>filesystem:write:/workspace"]
    KERNEL{"Linux kernel<br/>Landlock + seccomp"}
    MANIFEST -. "compiled into a policy<br/>before the app starts" .-> KERNEL
    APP -- "syscall" --> KERNEL
  end

  MCP -- "MCP (berth mcp)" --> APP
  LOOP -- "toAiSdkTools / toLangChainTools" --> APP
  KERNEL -- "declared: allowed" --> OK["write /workspace/report.md"]
  KERNEL -- "undeclared: EACCES" --> NO["write /etc/passwd"]
```

1. **Declare.** Every tool is a *resident app* with a `berth.yml` that names the capabilities it needs (`filesystem:write:/workspace`, `network:connect:443`) and the functions it exports.
2. **Enforce.** When the sandbox boots, Berth compiles those capabilities into a Landlock and seccomp policy and applies it before the app starts. Anything undeclared is denied by default: files, outbound connections, raw sockets.
3. **Connect.** The app's exports show up in your agent as ordinary tools, over MCP or through adapters for the Vercel AI SDK and LangChain. Your agent's code doesn't change; what its tools can reach does.

## See it in 60 seconds

No API key and no LLM needed: this demo calls the tool directly, the way an agent would.

```bash
git clone https://github.com/Ash20pk/BerthOS && cd BerthOS
corepack enable && pnpm install && pnpm build
node packages/cli/bin/berth.js doctor --fix     # can this machine's kernel enforce anything?
cd examples/kernel-says-no && pnpm start
```

```
--- inside the declared scope ---
write /workspace/hello.txt -> ok, read back: "hello from a sandbox"

--- outside the declared scope ---
write /etc/berth-should-not-exist.txt -> EACCES: permission denied, open '/etc/berth-should-not-exist.txt'

PASS — the capability line in berth.yml is the boundary, and the kernel is the one holding it.
```

Nothing in that script, or in the app's own code, checks the second path. The kernel refused it.

> **On a Mac, run `doctor` first.** Docker Desktop's VM has no Landlock, so nothing would be enforced, and the demo says so and exits non-zero rather than faking a pass. `berth doctor --fix` sets up a [Colima](./docs/mac-enforcement.md) VM whose kernel can enforce. Linux 6.7+ works out of the box.

More demos, each proving one boundary: a [fully compromised model](./examples/prompt-injection) told to backdoor `/etc`, [attacker-chosen code with no network](./examples/no-egress), and a [tamper-evident audit trail](./examples/audit-trail) catching an edited record. See the [catalog](./examples/README.md).

## Plug in the agent you already have

### Any MCP client, no code

`berth mcp` is an MCP server. It boots the sandbox itself, exposes the app's exports as tools, and shuts the sandbox down when your client disconnects.

```bash
node packages/cli/bin/berth.js mcp --app filesystem --app-dir apps/filesystem --warm   # build the image once

claude mcp add berth-filesystem -- node /abs/path/BerthOS/packages/cli/bin/berth.js \
  mcp --app filesystem --app-dir /abs/path/BerthOS/apps/filesystem
```

Ask your agent to write to `/etc` and it gets back a denial that tells it why, not just an error code:

```
BERTH CAPABILITY DENIAL
denied: open(2) on /etc/berth-should-not-exist.txt (EACCES: permission denied)
denied-by: the kernel — a Landlock ruleset compiled from "filesystem"'s berth.yml, applied before the app's first line ran
fix: none available — a berth.yml filesystem scope may only name /workspace, /context, /tmp, /app
```

Setup for Claude Desktop, Cursor and Colima: [MCP quickstart](./docs/mcp-quickstart.md).

### Your own tool-calling loop

Boot a sandbox, hand its tools to the loop you already run. This path works from a clone for now: `Computer` and the adapters live in the experimental agent framework, which isn't published. Moving them into their own package is [on the roadmap](./ROADMAP.md#now).

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { Computer, toAiSdkTools } from "@berthos/agents";

const computer = await Computer.boot({ apps: ["apps/filesystem"] });
const tools = await toAiSdkTools(computer.tools);

await generateText({
  model: openai("gpt-4o"),
  tools,
  stopWhen: stepCountIs(5),
  prompt: "Write a summary to /workspace/notes.md",
});
await computer.stop();
```

| Your stack | Call |
|---|---|
| Vercel AI SDK | `toAiSdkTools(computer.tools)` |
| LangChain / LangGraph | `toLangChainTools(computer.tools)` |
| Anything else | `toToolSpecs(computer.tools)`: name, description, JSON Schema, and a call function |

Both adapters are optional peer dependencies. Full example: [`examples/agents/with-vercel-ai-sdk`](./examples/agents/with-vercel-ai-sdk).

## Bring your own tools

A resident app is a manifest plus a handler. This is the whole of one:

```yaml
# berth.yml
name: hello-world
version: 0.1.0
capabilities: []          # touches nothing, so it can reach nothing
exports:
  - name: ping
    output: { message: string }
```

```ts
// src/index.ts
import { defineApp } from "@berthos/sdk";
import { z } from "zod";

export default defineApp((app) => {
  app.export({
    name: "ping",
    output: z.object({ message: z.string() }),
    handler: () => ({ message: "pong" }),
  });
});
```

```bash
berth init my-app && cd my-app
berth dev      # boots it in the sandbox, reloads on save
berth test     # checks the exports match the manifest and calls each one
```

The rest is in [Resident apps](./docs/resident-apps.md) and the [manifest reference](./docs/manifest-reference.md).

## Tools in the box

| App | What it gives an agent | Declares |
|---|---|---|
| [`filesystem`](./apps/filesystem) | Read and write files | `filesystem:read/write:/workspace` |
| [`code-interpreter`](./apps/code-interpreter) | Run Python, JavaScript or shell | `filesystem:write:/workspace`, no network |
| [`terminal`](./apps/terminal) | A real shell you can watch live in the browser | `filesystem:write:/workspace` |
| [`browser-native`](./apps/browser-native) | Headless Chromium you can watch over VNC | `browser:navigate:*` |
| [`github-assistant`](./apps/github-assistant) | Read repos, open issues | `github:read:repos`, `github:write:issues` |
| [`notes`](./apps/notes) | Stateful notes, persisted to disk | `filesystem:write:/workspace` |

Several apps can share one sandbox, and each keeps its own policy and its own uid.

## What it guarantees, and what it doesn't

- **Kernel-enforced:** filesystem read and write scopes, outbound TCP, UDP and raw sockets, namespace creation, and isolation between apps. This is real on any Linux 6.7+ kernel.
- **Broker-enforced:** browser hostnames and GitHub API verbs go through a proxy that checks them, because the kernel sees ports, not hostnames. Which capability is enforced at which level: [enforcement](./docs/kernel-enforcement.md).
- **It won't pretend.** On a kernel that can't enforce, `berth doctor` says so and the demos fail. Every `berth mcp` session writes its tool calls to a hash-chained audit trail, and `berth attest <runId>` turns a session into a record of what ran and the enforcement measured for its boot. Anyone can check the record with a standalone script, and it says `NOT_ENFORCED` when nothing was enforced.
- **Not a defence against root on the host.** Anyone who can `docker exec` into the container bypasses all of it. What's in scope and what isn't: [threat model](./docs/threat-model.md).

## Docs

| | |
|---|---|
| [MCP quickstart](./docs/mcp-quickstart.md) | Berth in Claude Code, Claude Desktop or Cursor in five minutes |
| [Quickstart](./docs/quickstart.md) | Install, run, scaffold, the CLI reference, releasing |
| [Resident apps](./docs/resident-apps.md) | Building your own tools |
| [Enforcement](./docs/kernel-enforcement.md) | Every capability and what enforces it, per platform |
| [Threat model](./docs/threat-model.md) | What holds, against whom, and what's out of scope |
| [Roadmap](./ROADMAP.md) | What works today, what's next, and where to help |

Every subsystem has a reference page in [`docs/`](./docs). The manifest format and the attestation record are also standalone, versioned specs: [capability manifest](./spec/capability-manifest), [attestation record](./spec/attestation-record).

## Status

Early, and built by one maintainer, so expect APIs to move before 1.0. The sandbox publishes to npm as `@berthos/*` (`npm install -g @berthos/cli`) and to PyPI as `berthos-sdk`; the first-party apps, the demos and the experimental agent framework live in this repo. The unrelated `@berth/*` packages on npm belong to a different project.

Something not working? Run `berth doctor` first; it answers most "it built but nothing was enforced" reports in one line. Then [file a bug](./.github/ISSUE_TEMPLATE/bug_report.md), send [workflow feedback](./.github/ISSUE_TEMPLATE/workflow_feedback.md), or [pitch a resident app](./.github/ISSUE_TEMPLATE/resident_app_proposal.md). [CONTRIBUTING.md](./CONTRIBUTING.md) has the wishlist.

## License

Apache-2.0. See [LICENSE](./LICENSE).
