# Agent Runtime Reference

Every other agent framework wires `agent -> tool`: the agent process calls out to stateless functions. `@berth/agents` inverts that — a `Computer` (a real Docker sandbox, built from the same `berth.yml`/manifest infrastructure every other phase already uses) comes first, resident apps loaded into it become the tools, and an `Agent` is what gets attached on top. It's a framework in the spirit of LangChain/CrewAI — bring your own LLM provider, define agents, compose them into multi-agent crews — except every agent's tools come from real sandboxed resident apps, not bare functions.

The dead-simple form — `llm` defaults to whichever of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set, and `runAgent()` boots, runs one task, and cleans up in one call:

```ts
import { runAgent } from "@berth/agents";

const result = await runAgent({
  apps: "apps/filesystem", // a single string is shorthand for a one-app Computer
  task: "write a file called hello.txt with the text 'hi', then read it back",
});
```

The fuller form — same defaulting, but you keep the `Agent`/`Computer` handles to run more than one turn or call tools directly:

```ts
import { createAgent, createAnthropicProvider } from "@berth/agents";

const { agent, computer } = await createAgent({
  apps: ["apps/filesystem"],
  llm: createAnthropicProvider(), // optional — omit to auto-detect from the environment, or pass createOpenAIProvider()/your own LLMProvider
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

Both `createAgent()` and `runAgent()` also accept `connect: "<name>"` instead of `apps` — see "Cold start: `berth os up` + `Computer.connect()`" below.

## `Computer` — the runtime primitive

`Computer.boot({ apps: string[] })` resolves each directory's `berth.yml` (`resolveComputerApps` — no pnpm-workspace requirement, unlike `@berth/cli`'s `resolveApps`), builds one production image via `buildImage()` (primary + companions, exactly `@berth/cli`'s `buildProductionImage` pattern), boots it with `startContainer()`, and turns every export across every loaded app into a `Tool`: `{name, description, inputSchema, invoke}`. Tool names are namespaced `<appName>__<exportName>` once more than one app is loaded (avoids collisions; `__` rather than `.` since tool names must satisfy `^[a-zA-Z0-9_-]+$`).

Reused as-is from existing infrastructure — nothing about capability enforcement, the context bus, or semantic FS changes: `@berth/manifest-schema`'s `loadManifest()`, `@berth/docker-orchestrator`'s `buildImage()`/`startContainer()`/`createStdioRpcClient()` (single app)/`invokeAppExport()` (multi-app).

No fabricated health-check export exists to poll for readiness — container boot (`on_install`, the context-bus/semantic-fs daemons, capability-policy generation, `agent-init`'s Landlock setup) takes a few seconds before an app's RPC server is even reading. `Computer.call()` retries a failed attempt with backoff (short per-attempt timeout, ~30s ceiling) rather than requiring every loaded app to expose a synthetic ping export.

Every `Computer.boot()` builds a fresh, uniquely-tagged image (unlike `berth dev`/`deploy`'s stable, overwritten tags) — `Computer.stop()` removes it along with the container, so repeated boots in a long-running process don't leak images.

## Cold start: `berth os up` + `Computer.connect()`

`Computer.boot()`'s build-a-fresh-image-then-boot path is correct for a one-shot script, but it's real seconds of latency (image build, container start, `on_install`, the context-bus/semantic-fs daemons, `agent-init`'s Landlock setup) paid again on *every* run while you're iterating on agent code. `berth os up` moves that cost out of the loop: it builds once and starts a container that stays running after the CLI command returns, instead of the ephemeral, always-freshly-built container `Computer.boot()` creates per call.

```bash
berth os up my-agent --apps=apps/filesystem,apps/notes   # or --config=<path to a small YAML: name + apps: [...] + network?>
berth os status                                          # confirm it's still running
berth os down my-agent                                   # tear it down when you're done for the day
```

Agent code then attaches instead of booting:

```ts
import { createAgent } from "@berth/agents";

const { agent, computer } = await createAgent({ connect: "my-agent", llm: createAnthropicProvider() });
// or: const computer = await Computer.connect({ name: "my-agent" });
```

`Computer.connect()` reads `~/.berth/os/<name>.json` (written by `berth os up`), re-derives a `Docker.Container` handle by name, and dispatches every tool call through `invokeAppExport()`'s docker-exec + Unix-socket relay — the same mechanism `berth rpc`/multi-app mode already use to reach a specific already-running app from a fresh host process (see [multi-app reference](./multi-app-reference.md)). `berth os up` always forces entrypoint.sh's multi-app branch, even for a single app (`buildImage`'s `forceCompanionLayout`, `startContainer`'s `apps` array with exactly one entry) — specifically so a per-app RPC socket always exists to reconnect to, regardless of how many apps are loaded; the single-app stdio-attach path `Computer.boot()` uses can only ever be held by the process that started the container.

**`computer.stop()` is a no-op for a connected Computer.** `Computer.boot()`'s `stop()` tears down the container and image it created; a connected Computer didn't create anything and doesn't own the container's lifecycle — tearing it down from inside one agent run would kill it for every other run still using it. This means `runAgent({connect: "...", task: "..."})` is always safe to call repeatedly against the same `berth os up` instance: its `finally { computer.stop() }` never actually stops anything when `connect` was used. Use `berth os down <name>` to actually tear it down.

**Scope**: local `berth dev`-equivalent Docker only, same as the rest of `@berth/agents` — no `berth os` equivalent exists for E2B/Daytona/K8s fleets today.

## `Tool` and `LLMProvider` — the "bring your own LLM" seam

```ts
interface Tool {
  name: string;
  description: string;
  inputSchema: object; // JSON Schema
  invoke(input: unknown): Promise<unknown>;
}

interface LLMProvider {
  readonly name: string;
  chat(params: { system?: string; messages: AgentMessage[]; tools: Tool[] }): Promise<LLMTurn>;
}
```

`createAnthropicProvider()` and `createOpenAIProvider()` ship as two real, independent implementations — proof the interface isn't secretly hardcoded to one vendor. Implement `LLMProvider` yourself for any other API; nothing in `Computer`, `Agent`, or `Crew` references a specific provider.

Because `Tool` is the one interface both resident-app exports *and* other agents implement (`Agent.asTool()`), a manager agent's tool list can freely mix "call a resident app export" and "delegate to another agent" through the same dispatch path.

## `Agent` and `Crew` — single- and multi-agent composition

`Agent.run(input)` is the provider-agnostic tool-use loop — identical regardless of which `LLMProvider` or `Tool` implementations are plugged in. `Agent.asTool(description)` wraps an agent as a `Tool` (`{task: string}` in, `run(task).text` out) — the seam `Crew.withManager({manager, workers})` uses to let a manager's own LLM decide when to delegate. `Crew.sequential(agents)` just pipes each agent's output text into the next.

## Networked Crew — agents as peers on a real LAN

A `Computer` is a full sandboxed OS with real networking, so agents built on separate computers can be genuine network peers, not just in-process composition. `bootNetworkedAgent({name, apps, llm, systemPrompt})` boots a `Computer` for the peer's own tool-providing apps *plus* a synthesized companion app (`generateAgentServerApp`) that runs its own agent loop over those tools, exposed through one `run_task` export — the agent itself lives on that computer, not just its tools. `Crew.networked({manager, peers})` gives a manager agent one `Tool` per peer.

Two small, real additions to existing infrastructure back this:
- `@berth/docker-orchestrator`'s `startContainer()` gained a `network?: string` option — joins (creating if needed) a Docker user-defined bridge network, so peer containers resolve each other by name via Docker's embedded DNS.
- `@berth/sdk`'s `rpc.ts` gained an optional TCP listener (`BERTH_NETWORK_PORT`) alongside its existing stdio/Unix-socket transports, using the identical line-delimited JSON envelope.

The synthesized agent-server app is generated on the fly (`berth.yml` + a plain, pre-built `dist/index.js` — no TS compile step) and vendors `@berth/sdk` the same way `berth init` already does for apps outside the pnpm workspace (`packages/sdk/dist-external/berth-sdk.tgz`). Its runtime is deliberately self-contained: it dials sibling apps' RPC Unix sockets directly with `node:net` and calls the LLM API directly with `fetch()`, rather than importing `@berth/agents` itself (which would drag `@anthropic-ai/sdk`/`openai` — and their own vendoring — into the sandbox). Because a live `LLMProvider` object can't be serialized into generated source, networked peers are limited to the two built-in providers (`{provider: "anthropic" | "openai", model?, apiKeyEnvVar}`), not an arbitrary custom `LLMProvider` — in-process `Agent`s have no such limit.

### What's real vs. deferred

- **Real**: two independent Computer/container boots joined to a shared Docker network; each peer running its own agent loop, inside its own sandbox, over its own tools; a host-side manager reaching each peer's `run_task` export and completing real multi-peer tasks.
- **Host-mediated, not container-to-container mesh (deferred)**: `Crew.networked()`'s dispatch to a peer currently goes through `Computer`'s existing `invokeAppExport`/`createStdioRpcClient` transport (the host talks to each container), not the raw TCP listener over the shared network. The Docker network join and the TCP RPC listener are real, working substrate for peers to reach each other directly — wiring a genuine container-to-container mesh dispatch path through that instead of the host is follow-up work.
- **Unrestricted egress, not a scoped broker (deferred)**: the synthesized agent-server app declares `network:connect:*` rather than routing its LLM API calls through a capability-scoped broker — the existing egress broker (`docs/egress-broker-reference.md`) only host-matches `browser:navigate:*` today, not arbitrary API hosts. Extending it (or adding a comparable one) for LLM egress is a documented follow-up, not attempted here.
- **No auth/TLS between peers (deferred)**: plaintext line-JSON on a private, single-Docker-host user-defined bridge network — the same trust model the existing context-bus/semantic-fs Unix sockets already operate under, just extended across containers instead of within one.
- **Single Docker host only (deferred)**: no cross-host/multi-machine fleet networking — blocked on the same gap as remote fleets generally (see below).

`network:peer:<name>` ([mesh reference](./mesh-reference.md)) is a separate, real primitive that addresses two of the gaps above differently — a genuine encrypted WireGuard tunnel between containers (not host-mediated RPC) with mutual-consent authorization (not "no auth between peers") — but `Crew.networked()` doesn't use it yet; rewiring it onto the mesh instead of the plain Docker bridge is its own follow-up.

## Other scope boundaries (v1)

- **Local Docker only.** None of the `DeployAdapter` implementations (E2B/Daytona/K8s) expose anything like `invokeAppExport` — there's no RPC bridge to a remote fleet instance today. `createAgent()`/`Computer.boot()` target local Docker, same as `berth dev`.
- **App directories, not registry names.** Pulling a resident app "by name" from the app registry only ever gets you a source bundle that still needs a local Docker build (see `docs/app-registry-reference.md`) — `apps:` takes local directory paths.
- **Tool schema fidelity matches the manifest, not your code.** `berth.yml`'s `exports:` grammar is intentionally flat (`string | number | boolean | object | array`, no nesting) — the same limitation `berth mcp`'s tool bridge already has. Whatever richer Zod schema you wrote in `app.export({input: ...})` never crosses the RPC wire, so it isn't available here either.

## Examples

Start with [`examples/agents/simple-agent`](../examples/agents/simple-agent) — depends on `@berth/agents` as an ordinary `workspace:*` package dependency (the shape an external project's `package.json` would actually use), rather than a relative import into this repo's own build output:

```bash
cd examples/agents/simple-agent
export OPENAI_API_KEY=sk-...
pnpm start
```

[`examples/agents/agent-server`](../examples/agents/agent-server) is the other direction: the agent isn't driving anything, it's the thing being served. A plain HTTP server boots (or `BERTH_OS_CONNECT`s to) a `Computer`/`Agent` once at startup, then answers `POST /task { task }` requests against it — the pattern for putting an agent behind a real API instead of a one-shot script.

For multi-agent composition, narrative/runnable demonstrations (not hard-assertion tests) live in
[`packages/agents/examples/`](../packages/agents/examples/README.md):

```bash
cd packages/agents
export OPENAI_API_KEY=sk-...
node examples/single-agent.mjs      # createAgent() — one Computer, one Agent
node examples/manager-crew.mjs      # Crew.withManager() — two in-process worker agents
node examples/networked-crew.mjs    # Crew.networked() — two independent networked agent-computers
```

## Verification

```bash
cd packages/agents
node test/computer-boot-milestone.mjs          # real: single-app Computer, live tool list, write_file/read_file round trip
node test/computer-multi-app-milestone.mjs     # real: filesystem + code-editor, namespaced tools, both independently callable
node test/provider-swap-milestone.mjs          # real: same Computer's tools, driven once by each built-in provider (needs ANTHROPIC_API_KEY + OPENAI_API_KEY)
node test/crew-manager-milestone.mjs           # real: manager agent delegates across two in-process worker agents (needs ANTHROPIC_API_KEY)
node test/crew-networked-milestone.mjs         # real: two independent networked agent-computers complete delegated tasks (needs ANTHROPIC_API_KEY)
```

The first two need only a local Docker daemon and are wired into CI (`.github/workflows/agents-milestone.yml`). The other three need real LLM API credentials and are manual/local-only — consistent with how this repo treats anything needing external credentials.
