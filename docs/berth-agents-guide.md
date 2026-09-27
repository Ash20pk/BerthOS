# Building with `@berthos/agents`

`@berthos/agents` is an agent framework built on Berth: you boot a sandbox, load it with resident apps, and every app export becomes a tool for the LLM you plug in. You don't need it to use Berth; [your existing framework](./why-berth.md#use-it-from-your-existing-framework) works too. Full API: [agents reference](./agents-reference.md).

It lives in [`experimental/`](../experimental/README.md): frozen, bug and security fixes only. It isn't published to npm; releases ship the sandbox only. Use it from a clone of this repo.

## Building a Berth Agent

Build the computer first, then the agent on top of it. Load whichever resident apps the agent needs; first-party and custom apps mix freely.

```ts
import { Computer, createAgent } from "@berthos/agents";

const computer = await Computer.boot({
  apps: ["apps/filesystem", "./my-custom-app"],
});

const { agent } = await createAgent({
  computer,
  llm: { provider: "anthropic", apiKey: "..." },
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

`llm` takes a provider (`createAnthropicProvider()`, `createOpenAIProvider()` or your own `LLMProvider`), or a plain config like `{ provider: "openai", apiKey, baseURL }` for a custom endpoint. Leave it out to pick a provider from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_API_KEY` / `GEMINI_API_KEY`, in that order.

`createAgent()` returns `{ agent, computer, mcpServers }`. You own the computer: `createAgent()` never stops it, so you can call its tools directly, snapshot it, or pass it to another `createAgent()`.

To give an agent only some of a running sandbox's apps, use `Computer.connect()` with an `apps` filter:

```ts
// started once with: berth os up team-os --apps=apps/filesystem,apps/notes,apps/terminal
const writerComputer = await Computer.connect({ name: "team-os", apps: ["filesystem"] });
const { agent: writer } = await createAgent({ computer: writerComputer });
```

## Shortcuts for the common case

If you don't need to share or scope the computer, let the framework build it from `apps`.

`runAgent()` boots, runs one task and cleans up:

```ts
import { runAgent } from "@berthos/agents";

const result = await runAgent({
  apps: "apps/filesystem",
  task: "write a file called hello.txt with the text 'hi', then read it back",
});
```

`createAgent({ apps })` keeps the agent and computer around for more than one turn:

```ts
import { createAgent, createAnthropicProvider } from "@berthos/agents";

const { agent, computer } = await createAgent({
  apps: ["apps/filesystem"],
  llm: createAnthropicProvider(), // optional
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

`apps`, `connect` and `computer` are mutually exclusive.

## What is a Berth OS?

A Berth OS is the sandbox your agent's tools run in: a Docker container loaded with one or more resident apps, each enforced separately by the kernel, sharing a context bus and a semantic filesystem. In code it's the `Computer` class. [Berth OS reference](./berth-os-reference.md) covers what's inside.

By default, every `runAgent()` or `createAgent({ apps })` boots a fresh one, which costs seconds on every run. During development, boot it once with `berth os up` and reconnect in milliseconds:

```bash
berth os up my-agent --apps=apps/filesystem,apps/notes   # or --config=<path to a YAML file>
```

```ts
const result = await runAgent({ connect: "my-agent", task: "..." });
```

`connect` also takes `{ name, apps }` to scope the agent to some of the sandbox's apps. Stopping a connected computer does nothing; `berth os down my-agent` tears the sandbox down.

## Multi-agent architecture

`Crew` composes agents. In one process:

- `Crew.sequential(agents)` pipes each agent's output into the next.
- `Crew.withManager({ manager, workers })` gives the manager one tool per worker and lets its LLM decide when to delegate.

The [agents reference](./agents-reference.md) covers the other shapes (`parallel`, `loopUntil`, `route`, `pipeline`).

`Crew.networked()` makes each peer a full agent on its own computer. `bootNetworkedAgent()` boots one `Computer` per peer, with its own apps and its own agent loop, on a shared Docker network. The manager gets one delegation tool per peer:

```ts
import { Agent, Crew, createOpenAIProvider, bootNetworkedAgent } from "@berthos/agents";

const filer = await bootNetworkedAgent({ name: "filer", apps: ["apps/filesystem"], llm: { provider: "openai", apiKeyEnvVar: "OPENAI_API_KEY" } });
const notetaker = await bootNetworkedAgent({ name: "notetaker", apps: ["apps/notes"], llm: { provider: "openai", apiKeyEnvVar: "OPENAI_API_KEY" } });

const manager = new Agent({ name: "manager", llm: createOpenAIProvider(), tools: [] });
const crew = Crew.networked({ manager, peers: [filer, notetaker] });

const output = await crew.run("Ask notetaker to log this run, then ask filer to write the result to a file.");
```

A peer's `llm` is `{ provider: "anthropic" | "openai", model?, apiKeyEnvVar }`: the name of the env var the peer reads its key from, so the key itself never lands in generated code. Each peer has a `stop()`.

Peers can run remotely too. `bootNetworkedAgent({ fleet: { adapter, port } })` deploys a peer to E2B, Daytona or Kubernetes, and `Crew.networked()` reaches it over an HTTP RPC bridge with a per-boot token instead of the Docker network. See [networked crew over a remote fleet](./agents-reference.md#networked-crew-over-a-remote-fleet-e2b-daytona-k8s).

## Governance and scoping

Capabilities decide what a single app can do ([available capabilities](./kernel-enforcement.md#available-capabilities)). Governance decides, call by call, whether a tool call runs at all: one app reviews every other app's calls in the same Berth OS.

To write a governance app, declare `governs: true` in its `berth.yml` and export `evaluate_action({ app, export, input }) -> { allowed, reason }`. Load it into the computer with the other apps; every other app's calls then go through it. An app opts out with `governance: { exempt: true }`.

- **What's gated:** tool calls through a `Computer` (including MCP tools, as `mcp:<server>`, and delegation to another agent, as `agent:<name>`), and calls that reach an app another way (`berth rpc`, `berth mcp`, the HTTP RPC bridge, another app's socket), checked inside the sandbox by `@berthos/sdk`.
- **Fails closed:** if `evaluate_action` errors or times out, the call is refused. At the `Computer` you can pass `governance: { mode: "fail-open" }` where availability matters more.
- **Not kernel enforcement:** it's a policy layer, and root on the host can bypass it.

Full contract: [governance reference](./governance-reference.md).
