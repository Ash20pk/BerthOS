# Building with `@berth/agents`

`@berth/agents` is the reference consumer of the Berth substrate: computer, then
agent, then tool. It is optional — [using Berth from the framework you already
have](./why-berth.md#use-it-from-your-existing-framework) is a first-class path,
and the substrate is the product. Full API surface:
[docs/agents-reference.md](./agents-reference.md).

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

## Shortcuts for the common case

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

Composing multiple agents — in-process, or fully networked peers each on their own computer — is a first-class pattern here, not an afterthought. See [Multi-agent architecture](./berth-agents-guide.md#multi-agent-architecture).

Want an app to review every other app's tool calls before they happen, allow or deny? See [Governance and scoping](./berth-agents-guide.md#governance-and-scoping).

## What is a Berth OS?

Every `runAgent()` or `createAgent()` call above needs somewhere for its tools to actually live and run. That's a Berth OS: a real, sandboxed computer (a Docker container today) loaded with one or more resident apps, each independently enforced by the kernel, all able to collaborate through a shared context bus and semantic filesystem. In code, that's the `Computer` class.

Want the full picture? [docs/berth-os.md](./berth-os.md) walks through what's actually inside one and how it relates to a resident app.

Here's the part that matters for your day to day: by default, every `createAgent()` or `runAgent()` call boots a fresh, throwaway Berth OS. That's fine for a one-off script, but you'll feel it as real seconds of latency on every single dev loop iteration. `berth os up` pays that cost once, keeps the sandbox running, and lets your agent code reconnect in milliseconds instead of rebuilding and rebooting.

```bash
berth os up my-agent --apps=apps/filesystem,apps/notes   # or --config=<path to a small YAML>
```

```ts
const result = await runAgent({ connect: "my-agent", task: "..." }); // reconnects instantly, no build, no boot
```

`berth os down my-agent` tears it down when you're done. [docs/berth-os-reference.md](./berth-os-reference.md) has the full command and API reference, including how to scope one agent to a subset of a shared OS's loaded apps.

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

Each peer keeps driving its own agent loop independently, on its own sandboxed computer — this is the architecture, not a demo trick, and it's why multi-agent here scales past "one process calling itself." Full API, and what's real vs. deferred today (host-mediated dispatch, a genuine container-to-container mesh as follow-up work): [docs/agents-reference.md](./agents-reference.md).

Peers don't have to be local either. `bootNetworkedAgent({ fleet: { adapter, port } })` deploys a peer to a remote E2B/Daytona/K8s instance instead of a local Docker container, and `Crew.networked()` dispatches to it the same way — over a per-boot-authenticated HTTP RPC bridge instead of the Docker network. See [docs/agents-reference.md](./agents-reference.md#networked-crew-over-a-remote-fleet-e2b-daytona-k8s) for what's verified end-to-end versus reasoned-but-not-live-tested.

## Governance and scoping

Capabilities (see [Available capabilities](./kernel-enforcement.md#available-capabilities)) control what a single app can do, enforced by the kernel or a broker before the call happens. Governance controls what happens next: any app can put itself in front of every *other* app's tool calls in the same Berth OS and decide, per call, whether it's allowed to run at all.

Declare `governs: true` in your `berth.yml` and export a fixed-contract `evaluate_action({ app, export, input }) -> { allowed, reason }`. Load it alongside whatever else the Computer needs, and every other app's tool calls now route through it automatically — no other wiring required. Any app can opt out with `governance: { exempt: true }`.

Worth being precise about: this gates what goes through `Computer`/`Agent` — an LLM-driven agent's tool use, including MCP tools (as `mcp:<server>`) and delegation to another agent (as `agent:<name>`). It is **not** kernel-level like Landlock's per-syscall capability enforcement, and it doesn't cover `berth rpc`, `berth mcp`, the HTTP RPC bridge, or direct `invokeAppExport()` calls — separate transports with no governance app on their path. It fails **closed** by default: if `evaluate_action` errors or times out, the call is refused rather than run, because "the policy check didn't happen" should not quietly become "the policy check passed." Pass `governance: { mode: "fail-open" }` where availability matters more. Full contract in [docs/governance-reference.md](./governance-reference.md).
