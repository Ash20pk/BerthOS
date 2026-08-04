# Agent runtime reference

Most agent frameworks wire `agent -> tool`: the agent process calls out to stateless functions. `@berth/agents` flips that around. A `Computer` (a real Docker sandbox, built from the same `berth.yml` and manifest infrastructure every other part of Berth already uses) comes first. Resident apps loaded into it become the tools, and an `Agent` gets attached on top. It's a framework in the spirit of LangChain or CrewAI: bring your own LLM provider, define agents, compose them into multi-agent crews. The difference is that every agent's tools come from real, sandboxed resident apps, not bare functions.

Build the computer, then attach the agent to it.

```ts
import { Computer, createAgent, createAnthropicProvider } from "@berth/agents";

const computer = await Computer.boot({ apps: ["apps/filesystem", "./my-custom-app"] });

const { agent } = await createAgent({ computer, llm: createAnthropicProvider() });

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

## `Computer`, the runtime primitive

`Computer.boot({ apps: string[] })` resolves each directory's `berth.yml` through `resolveComputerApps()` (no pnpm-workspace requirement here, unlike `@berth/cli`'s `resolveApps`), builds one production image via `buildImage()` (primary plus companions, exactly `@berth/cli`'s `buildProductionImage` pattern), boots it with `startContainer()`, and turns every export across every loaded app into a `Tool`: `{name, description, inputSchema, invoke}`. Tool names get namespaced `<appName>__<exportName>` once more than one app is loaded, both to avoid collisions and because tool names need to satisfy `^[a-zA-Z0-9_-]+$`, which rules out a `.` separator.

None of this is new infrastructure. Capability enforcement, the context bus, and semantic FS all work exactly the way they do everywhere else: `@berth/manifest-schema`'s `loadManifest()`, `@berth/docker-orchestrator`'s `buildImage()`, `startContainer()`, `createStdioRpcClient()` for a single app, and `invokeAppExport()` for multi-app.

There's no fabricated health-check export to poll for readiness. Container boot (`on_install`, the context-bus and semantic-fs daemons, capability-policy generation, `agent-init`'s Landlock setup) takes a few seconds before an app's RPC server is even listening. `Computer.call()` retries a failed attempt with backoff (a short per-attempt timeout, about a 30 second ceiling) instead of requiring every loaded app to expose a synthetic ping export just so something can poll it.

Every `Computer.boot()` builds a fresh, uniquely-tagged image, unlike `berth dev`/`deploy`'s stable, overwritten tags. `Computer.stop()` removes it along with the container, so repeated boots in a long-running process don't leak images on disk.

### Building a Computer your own way

You don't have to hand `createAgent()` a fresh set of `apps` every time. Three ways to get a `Computer`, each suited to a different situation.

Boot fresh from resident app directories. First-party and custom mix freely.

```ts
const computer = await Computer.boot({ apps: ["apps/filesystem", "./my-custom-app"] });
```

Connect to a shared, already-running `berth os up` instance.

```ts
const computer = await Computer.connect({ name: "my-agent" });
```

Or connect to that same shared instance, scoped to just the apps this particular agent needs.

```ts
const computer = await Computer.connect({ name: "my-agent", apps: ["filesystem"] });
```

That last option is worth calling out. If a `berth os up` instance has several apps loaded (say `filesystem`, `notes`, and `terminal`), each agent that connects to it can ask for only the ones it actually needs. One agent might get `{ apps: ["filesystem"] }`, another `{ apps: ["notes"] }`, both sharing the same running sandbox without either one seeing tools it has no business calling. Ask for an app name the OS doesn't have loaded and `connect()` throws a clear error naming what's actually available, rather than silently handing back an empty tool list.

However you got a `Computer`, hand it straight to `createAgent()` instead of `apps`, and it'll use it as-is with no extra boot or connect step:

```ts
const { agent } = await createAgent({ computer, llm: createAnthropicProvider() });
```

This is what lets one Berth OS back several agents at once, a manager and its workers, say, each built from the same `Computer` with a different (or filtered) set of tools. You still own that Computer's lifecycle either way. `createAgent()` never calls `stop()` on it, whether it built the Computer itself or you handed one in.

## Cold start: `berth os up` and `Computer.connect()`

`Computer.boot()`'s build-then-boot path is correct for a one-shot script, but you'll feel it as real seconds of latency (image build, container start, `on_install`, the context-bus and semantic-fs daemons, `agent-init`'s Landlock setup) paid again on every single run while you're iterating on agent code. `berth os up` moves that cost out of the loop. It builds once and starts a container that stays running after the CLI command returns, instead of the ephemeral, freshly-built container `Computer.boot()` creates on every call.

```bash
berth os up my-agent --apps=apps/filesystem,apps/notes   # or --config=<path to a small YAML: name + apps: [...] + network?>
berth os status                                          # confirm it's still running
berth os down my-agent                                   # tear it down when you're done for the day
```

Agent code then connects instead of booting.

```ts
import { createAgent, createAnthropicProvider } from "@berth/agents";

const { agent, computer } = await createAgent({ connect: "my-agent", llm: createAnthropicProvider() });
```

Or, if you just want the `Computer` and no `Agent`/LLM at all:

```ts
const computer = await Computer.connect({ name: "my-agent" });
```

`Computer.connect()` reads `~/.berth/os/<name>.json` (written by `berth os up`), re-derives a `Docker.Container` handle by name, and dispatches every tool call through `invokeAppExport()`'s docker-exec-plus-Unix-socket relay. That's the same mechanism `berth rpc` and multi-app mode already use to reach a specific, already-running app from a fresh host process. See the [multi-app reference](./multi-app-reference.md). `berth os up` always forces `entrypoint.sh`'s multi-app branch, even for a single app (`buildImage`'s `forceCompanionLayout`, `startContainer`'s `apps` array with exactly one entry), specifically so a per-app RPC socket always exists to reconnect to, no matter how many apps are loaded. The single-app stdio-attach path `Computer.boot()` uses can only ever be held by the process that started the container, which is exactly the limitation this works around.

**`computer.stop()` is a no-op for a connected Computer.** `Computer.boot()`'s `stop()` tears down the container and image it created. A connected Computer didn't create anything and doesn't own the container's lifecycle, so tearing it down from inside one agent run would kill it for every other run still using it. That means `runAgent({connect: "...", task: "..."})` is always safe to call over and over against the same `berth os up` instance. Its `finally { computer.stop() }` never actually stops anything when `connect` was used. Use `berth os down <name>` when you actually want to tear it down.

**Scope:** local, `berth dev`-equivalent Docker only, same as the rest of `@berth/agents`. There's no `berth os` equivalent for E2B, Daytona, or K8s fleets today.

## Shortcuts: `runAgent()` and `createAgent({ apps })`

Building the `Computer` yourself pays off when you need to reuse it across agents, filter which apps an agent sees, or mix in a custom resident app. Most of the time you don't need any of that, so `@berth/agents` also gives you two shortcuts that build the Computer for you behind the scenes, from whatever you pass as `apps`.

The simplest version needs nothing but an app directory and a task. `llm` defaults to whichever of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set, and `runAgent()` boots, runs one task, and cleans up in one call.

```ts
import { runAgent } from "@berth/agents";

const result = await runAgent({
  apps: "apps/filesystem", // a single string is shorthand for a one-app Computer
  task: "write a file called hello.txt with the text 'hi', then read it back",
});
```

Same defaults, but here's the fuller form, for when you want to keep the `Agent`/`Computer` handles around to run more than one turn or call tools directly.

```ts
import { createAgent, createAnthropicProvider } from "@berth/agents";

const { agent, computer } = await createAgent({
  apps: ["apps/filesystem"],
  llm: createAnthropicProvider(), // optional, omit to auto-detect from the environment, or pass createOpenAIProvider()/your own LLMProvider
});

const result = await agent.run("write a file called hello.txt with the text 'hi', then read it back");
await computer.stop();
```

Both `createAgent()` and `runAgent()` also accept `connect: "<name>"` instead of `apps`, the same shortcut `Computer.connect()` gives you explicitly. See "Cold start" above.

## `Tool` and `LLMProvider`, the bring-your-own-LLM seam

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
  chatStream?(
    params: { system?: string; messages: AgentMessage[]; tools: Tool[] },
    onText: (delta: string) => void,
  ): Promise<LLMTurn>;
}
```

`createAnthropicProvider()` and `createOpenAIProvider()` ship as two real, independent implementations, proof the interface isn't secretly hardcoded to one vendor. Implement `LLMProvider` yourself for any other API. Nothing in `Computer`, `Agent`, or `Crew` references a specific provider.

`chatStream` is optional — same request/response contract as `chat()`, but it calls `onText(delta)` with each chunk of assistant text as the model produces it (backed by `client.messages.stream()` for Anthropic, `stream: true` chat completions for OpenAI), rather than only handing back the full text once the turn is done. Pass `onText` to `run()`/`resume()`/`runAgent()` to get it:

```ts
const { agent } = await createAgent({ apps: "apps/filesystem" });
const result = await agent.run("long task", {
  onText: (delta) => process.stdout.write(delta),
});
```

`onText` only takes effect when the resolved provider implements `chatStream` — both built-in providers do. Passing it to a provider that only implements `chat()` (a custom `LLMProvider`) is a silent no-op, not an error: `Agent` falls back to `chat()` and the run completes exactly as it would without `onText`, just without incremental events. Streaming is per-turn, not across the whole tool-use loop — each LLM call in `Agent`'s loop streams its own text independently; tool-call arguments themselves aren't streamed, only the assistant's text.

You don't have to construct a provider object yourself, either. `createAgent()`/`runAgent()`'s `llm` option also accepts a plain config object, resolved through `resolveLLMProvider()`:

```ts
const { agent } = await createAgent({
  apps: "apps/filesystem",
  llm: { provider: "openai", apiKey: "...", baseURL: "https://my-endpoint/v1", model: "..." },
});
```

`baseURL` is what makes this useful beyond a shorthand. Both `createAnthropicProvider()` and `createOpenAIProvider()` accept it directly too, and it's what lets you point at a self-hosted or OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, a Bedrock or Vertex proxy) instead of the vendor's own API. Omit `llm` entirely and `detectLLMProvider()` picks whichever of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is actually set.

### Retries and a fallback model chain

A single flaky call (a 429, a 5xx, a timeout) is already retried a couple of times before it ever reaches `Agent` — `createAnthropicProvider()`/`createOpenAIProvider()` are thin adapters over `@anthropic-ai/sdk`/`openai`, and both SDK clients retry retriable errors with their own exponential backoff by default (`maxRetries: 2`). That default was previously invisible and unconfigurable from this package; both providers now accept `maxRetries` directly:

```ts
const llm = createAnthropicProvider({ maxRetries: 5 });
```

What was actually missing is the layer above that: a whole provider being down (an outage, an exhausted quota), not one bad request. `createFallbackProvider(providers, {onFallback?})` wraps an ordered list of `LLMProvider`s into one — `chat()`/`chatStream()` try `providers[0]`, and on any thrown error (i.e. once that provider's own retries are exhausted) fall through to `providers[1]`, and so on, until one succeeds or the last one's error propagates unchanged:

```ts
const llm = createFallbackProvider(
  [createAnthropicProvider(), createOpenAIProvider()],
  { onFallback: (err, failed) => console.error(`${failed.name} failed, falling back:`, err) },
);
const { agent } = await createAgent({ apps: "apps/filesystem", llm });
```

Works with any `LLMProvider`, built-in or custom — nothing in `createFallbackProvider()` references Anthropic or OpenAI specifically, and nothing in `Agent`/`createAgent` needs to know a fallback chain is even in use; `llm` accepts the wrapped provider exactly like any other. `chatStream` is present on the wrapped provider only when every provider in the chain implements it — same "absent means no incremental events" contract `Agent.run()` already treats `chatStream` under. **One real, documented gap**: falling back mid-stream isn't clean — `onText` may have already fired with the failed provider's partial text before the switch, and the next provider's stream starts over from nothing, so a caller could see `"Hel"` then `"Hello there"` rather than one continuous stream.

Because `Tool` is the one interface both resident-app exports and other agents implement (through `Agent.asTool()`), a manager agent's tool list can freely mix "call a resident app export" and "delegate to another agent" through the same dispatch path.

## Governance gate: gating every other app's tools

An app declaring `governs: true` in its `berth.yml` becomes the Computer's governance authority: `Computer` wraps every *other* app's `Tool.invoke` to call that app's `evaluate_action` export first, and only proceeds if it returns `{ allowed: true }`. This is `Computer`-level, not kernel-level — Landlock has no per-syscall hook to build a true kernel gate on, so this is the closest real choke point that sees every tool call an agent makes across every app. Full contract, opt-out (`governance: { exempt: true }`), and fail-open behavior in the [governance gate reference](./governance-reference.md).

Governance is fully automated — `evaluate_action` is a policy check some app's code answers, not a human. For an actual human decision in the loop, see the next section.

## Human-in-the-loop: gating a live tool call on a human decision

Neither `Agent.run()` nor the governance gate above has an interrupt point — nothing like LangGraph's `interrupt()`/`Command(resume=...)`. `applyHumanApprovalGate(tools, options)` (`packages/agents/src/approval.ts`) closes that by generalizing [`@berth/grants-server`](./capability-tokens-reference.md#human-admin-approval-berthgrants-server)'s existing approve/deny pattern from "container gets this filesystem capability" (decided *async*, taking effect only on the app's next boot) to "this agent gets to take its next action" (decided *live*, blocking the call that's asking):

```ts
const { agent } = await createAgent({
  apps: "apps/filesystem",
  humanApproval: {
    grantsServerUrl: "http://127.0.0.1:4874", // a running `berth-grants` instance
    only: ["write_file"], // omit to gate every tool; requesterName defaults to this Agent's name
  },
});

await agent.run("clean up old files"); // blocks on write_file until `berth grants approve/deny` decides it
```

A gated tool call does `POST /grants {appName: requesterName, capability: "agent-action:<toolName>", reason: JSON.stringify(input)}`, then polls `GET /grants/:id` (`pollIntervalMs`, default 2s) until a human decides via `berth grants approve|deny` (or the REST API directly) or `timeoutMs` (default 10 minutes) elapses. Denied, or timed out, both throw `HumanApprovalDeniedError` — caught generically by `Agent.run()`'s tool loop and fed back to the model as `{error}`, exactly like any other tool failure (see gap #2 above); no `Agent` changes were needed for this to work.

Two things this deliberately does **not** do, both by design rather than oversight:
- **Doesn't touch `generate-capability-policy.ts`/Landlock at all.** That machinery is boot-time-only — Landlock rulesets are fixed at `agent-init`'s `restrict_self()` and can never be widened on an already-running process, so the *existing* async consumer (`requestCapability()`) can only take effect on the app's *next container restart*. There's no container to restart mid-`Agent.run()`, so this gate polls and blocks live instead, reusing only the request/approve/deny/webhook machinery, not the boot-time merge.
- **Fail-closed, the opposite of the governance gate's fail-open.** A human-approval gate that silently let calls through when `grants-server` was unreachable, slow, or simply never got a human's attention wouldn't be a human-in-the-loop gate at all — a timeout is a denial here, not a pass-through.

`only` (an array of tool names) is what makes this usable in practice — gating literally every tool call would mean a human has to click through even harmless reads. Omit it to gate everything; scope it down to just the tool calls that actually warrant a human looking first (a delete, a payment, an external message send).

## `Agent` and `Crew`: single- and multi-agent composition

`Agent.run(input)` is the provider-agnostic tool-use loop, identical no matter which `LLMProvider` or `Tool` implementations are plugged in. `Agent.asTool(description)` wraps an agent as a `Tool` (`{task: string}` in, `run(task).text` out), the seam `Crew.withManager({manager, workers})` uses to let a manager's own LLM decide when to delegate. `Crew.sequential(agents)` just pipes each agent's output text into the next.

A tool call that throws (bad args, a handler exception, a governance denial) doesn't end the run. `Agent.run()`'s tool loop catches it and feeds `{ error: <message> }` back to the model as that call's tool result, exactly like the existing "no such tool" case — the model sees the failure and can retry with different input, try a different tool, or give up and explain why, the same way it reacts to any other tool result. Nothing to opt into; this is the only behavior.

### Composable `Crew` functions: cycles, fan-out, and branching without a graph DSL

`sequential`/`withManager`/`networked` are three fixed shapes — a straight pipe, or a manager delegating to fixed workers/peers. Anything beyond that (a fan-out-then-merge, a retry loop, an if/else) used to mean dropping out of `Crew` and hand-coding it. Three more `Crew` functions cover those without introducing a LangGraph-style node/edge graph — each is still just plain wiring over `Agent.run()`, not a new execution primitive:

- **`Crew.parallel(agents, { merge? })`** — runs every agent against the same input concurrently, then combines their outputs. Default `merge` concatenates each agent's output under a `## <name>` heading; pass `merge` to pick one, vote, or combine some other way.
- **`Crew.loopUntil({ agent, until, maxIterations? })`** — runs `agent` repeatedly, feeding its own output back in as the next input, checking `until(result, iteration)` *after* each run (so it always runs at least once). Stops the moment `until` returns true, or after `maxIterations` (default 10) as the backstop against a condition that never fires.
- **`Crew.route({ router, routes, fallback? })`** — `router` is asked to classify the input as exactly one of `routes`'s keys; only that one branch's agent then runs, against the *original* input, not the router's classification prompt. Falls back to `fallback` (or throws, naming what the router actually said) when its answer matches no route.

```ts
const crew = Crew.route({
  router: classifierAgent,
  routes: { billing: billingAgent, support: supportAgent },
  fallback: generalAgent,
});
const result = await crew.run("where's my refund?"); // routed to billingAgent
```

Same scope boundary as checkpointing (below): none of these three checkpoint crew-level composition state either — only individual `Agent`s constructed with a `checkpoint` store do.

## Checkpointing and resuming a run: state without a graph

`Agent.run()`'s tool-use loop keeps its `messages`/executed-tool-calls state as a plain in-process array — it's gone the moment the call returns or the process dies mid-loop. There's no LangGraph-style checkpointer here, and deliberately no graph to attach one to; instead, checkpointing is exposed as a `CheckpointStore` seam (`packages/agents/src/checkpoint.ts`) that `Agent.run()`/`Agent.resume()` write through directly:

```ts
const { agent, computer } = await createAgent({ apps: "apps/filesystem", checkpoint: "semantic-fs" });
await agent.run("long task", { runId: "task-42" }); // saves progress after every turn

// ...process crashes, or you just come back later...
const result = await agent.resume("task-42"); // picks the loop back up, doesn't replay from scratch
```

`"semantic-fs"` (`createSemanticFsCheckpointStore()`) is the built-in backend, and it's built entirely from existing pieces, not a new daemon:
- An `Agent` runs on the host, outside the sandbox — the only way it can reach Semantic FS at all is through a resident app's exports, the same as any other tool call. `apps/filesystem`'s `write_context_file`/`read_context_file`/`tag_context_file` (the last is a small, real addition — `read_context_file` mirroring `read_file` but scoped to `/context`, since `query_context` is fuzzy keyword/embedding search, not a fit for an exact-path checkpoint load) are what it calls. Any app exposing those three export names works; the store resolves them off `Computer.tools` by suffix match (bare `write_context_file` on a single-app Computer, `<appName>__write_context_file` once there's more than one app), and throws immediately at construction if none is found — not on the first `save()` deep inside a run.
- A checkpoint is one JSON blob per `runId` at `/context/agent-runs/<runId>.json`: `{runId, agentName, status: "running"|"done"|"error", turnCount, messages, toolCalls, text?}`. `turnCount` is the index of the *next* turn to run, so `resume()` continues the loop rather than re-sending the original task.
- `resume()` on a `status: "done"` checkpoint is a plain read — it returns the stored `text`/`toolCalls` without calling the LLM again.
- `load()` can't distinguish "nothing was ever saved for this runId" from "a real error happened reading it" — resident-app export errors cross the RPC wire as a plain message string (see `Computer`'s `dispatch()`), not a typed error code. Both cases return `null` from `load()`, so `resume()` on a `runId` that failed to read for an unrelated reason (a transient RPC hiccup, say) reports "no checkpoint found" rather than the real cause. Worth knowing if a resume doesn't behave as expected.

**What this does and doesn't fix:** this closes "a crash mid-loop loses everything" for a single `Agent`. A checkpoint means the *previous* turns survive a crash, not that a crash itself is recoverable mid-turn — a hard crash inside `tool.invoke()` (the process dying, not the call throwing) still loses that turn. It's also Agent-level only for now: `Crew.sequential`/`withManager`/`networked` don't checkpoint the crew's own composition state (which sub-agent ran, in what order) — only whichever individual `Agent`s you construct with a `checkpoint` store get durable turn-by-turn progress.

## Structured output: a repair loop for an `Agent`'s final answer

A Zod parse failure on a tool call's input (server-side, inside a resident app) already gets fed back to the model as a tool error and another turn — that's gap #2's tool-error handling, not a separate mechanism. What's genuinely missing is a LangChain `.with_structured_output()` equivalent for the agent's own *final* answer: once the model stops calling tools, nothing validated that its last message was actually the JSON shape the caller needed. `Agent.run()`/`Agent.resume()` gained a `responseSchema` option that closes that gap without a new subsystem — it's a small addition to the existing tool-use loop, not a parallel one:

```ts
import { z } from "zod";

const schema = z.object({ name: z.string(), age: z.number() });

const result = await agent.run("extract the person's name and age from: ...", { responseSchema: schema });
result.data; // typed { name: string; age: number }, guaranteed to match schema — or the call already threw
```

Once a turn has no pending tool calls (what previously always meant "done"), its text is parsed as JSON and validated against `responseSchema` (`parseStructuredOutput()`, `packages/agents/src/structured-output.ts`). Two failure modes get collapsed into one error string fed back as a fresh user turn — "your previous response could not be parsed as valid JSON matching the required schema: `<error>` — respond again with ONLY corrected JSON" — and the loop continues, giving the model another attempt: not valid JSON at all, or valid JSON that doesn't match the schema (reported per-field, via Zod's own `issues`). This repeats up to `maxRepairAttempts` (default 2); exceeding it throws `StructuredOutputError` (carrying the model's last, still-invalid `rawText`) rather than silently returning invalid data. A schema-conforming first attempt costs nothing extra — no repair turn, no extra LLM call.

`responseSchema` is a per-call option, not a constructor one (unlike `checkpoint`/`trace`) — different calls against the same `Agent` can ask for different shapes, or none at all. `runAgent({responseSchema, maxRepairAttempts})` threads the same options through for the one-shot entry point.

**What this does and doesn't fix:** this only validates the loop's own final text turn — a tool call's input is still whatever the resident app's own Zod schema accepts or rejects (gap #2's generic `{error}` feedback, unchanged). There's no client-side JSON-Schema pre-validation of tool arguments before they reach a tool's `invoke()` either — that would need a JSON-Schema validator (this package has none as a dependency) and is a different, separate piece of the same broader gap, left for later. No streaming-aware repair: `onText` still fires for a rejected attempt's text before the repair prompt goes out, same as any other turn.

## Tracing a run: `agent.step` events, not a LangSmith-style tracer

There's no structured logging of reasoning steps out of the box — no token/cost accounting, no trace IDs, no replay UI comparable to LangSmith. Same non-goal as checkpointing above: no new tracing daemon, no dedicated subsystem. Instead, `StepTracer` (`packages/agents/src/tracing.ts`) is another narrow seam `Agent.run()`/`Agent.resume()` write through, this time for one `AgentStepEvent` (`{runId, agentName, turn, kind: "llm-turn"|"tool-call", toolName?, durationMs, error?}`) per LLM turn and per tool call:

```ts
const { agent, computer } = await createAgent({ apps: "apps/filesystem", trace: "full" });
await agent.run("long task", { runId: "task-42" }); // emits a step after every LLM turn and every tool call

const trace = await readAgentTrace(computer, "task-42"); // full step-by-step history, in order
```

`"full"` (`createAgentTracer()`) is two channels at once, matching the two different jobs "observability" actually means here:
- **Live tailing** — `createContextBusStepTracer()` publishes each event to the Context Bus topic `"agent.step"`, fire-and-forget, for whatever's tailing it in real time. Reached the same way Semantic FS is: an `Agent` runs outside the sandbox, so the only way to reach the bus at all is through a resident app's export — `apps/filesystem` gained `publish_context_event({topic, payload})`, a thin pass-through to the `contextBus` client it already held from registering for `fs.file_created`. A small, real addition, same as `read_context_file`/`tag_context_file` were for checkpointing.
- **Durable replay** — `createSemanticFsStepTracer()` writes to Semantic FS, since the Context Bus is ephemeral pub/sub (a tailer that wasn't listening at the time sees nothing, ever). Reuses the exact `write_context_file`/`read_context_file`/`tag_context_file` exports checkpointing already depends on — one JSON array per `runId` at `/context/agent-traces/<runId>.json`, appended to (read-modify-write, not a true append) on every `emit()`. `readAgentTrace(computer, runId)` reads it back in order; `[]` if nothing was ever traced for that `runId`, same "can't tell missing from a real read error" caveat `CheckpointStore.load()` already has.

Both `createContextBusStepTracer()`/`createSemanticFsStepTracer()` throw immediately at construction (not on the first `emit()`) if the Computer is missing the export(s) they need — same fail-fast contract as `createSemanticFsCheckpointStore()`. Pass either one alone as `trace` instead of `"full"` for just one channel, or your own `StepTracer` for a different backend entirely.

Like checkpointing, tracing only activates with a `runId` — `trace` configured but no `runId` passed to `run()`/`resume()` means zero events, not an error. An LLM call that throws still emits an `llm-turn` step (duration + error) before the error propagates out of `run()` exactly as before — tracing observes failures, it doesn't swallow them.

**What this does and doesn't fix:** no token/cost accounting — no `LLMProvider` in this package surfaces usage numbers today, so `AgentStepEvent` doesn't carry a `tokens` field; adding one only when a provider actually reports something is future work, not a placeholder here. No trace-ID correlation across a `Crew` — each `Agent` traces its own `runId` independently, same Agent-level-only scope checkpointing has for crew composition state. No query/browse-all-traces UI — `readAgentTrace()` needs a known `runId`; there's no "list every trace ever recorded" primitive (Semantic FS's `query_context` is fuzzy text search, not an exact tag filter).

## Networked Crew: agents as peers on a real LAN

A `Computer` is a full sandboxed OS with real networking, so agents built on separate computers can be genuine network peers, not just composed in-process. `bootNetworkedAgent({name, apps, llm, systemPrompt})` boots a `Computer` for the peer's own tool-providing apps, plus a synthesized companion app (`generateAgentServerApp`) that runs its own agent loop over those tools, exposed through one `run_task` export. The agent itself lives on that computer, not just its tools. `Crew.networked({manager, peers})` gives a manager agent one `Tool` per peer.

Two small, real additions to existing infrastructure make this work:
- `@berth/docker-orchestrator`'s `startContainer()` gained a `network?: string` option. It joins (creating if needed) a Docker user-defined bridge network, so peer containers can resolve each other by name through Docker's embedded DNS.
- `@berth/sdk`'s `rpc.ts` gained an optional TCP listener (`BERTH_NETWORK_PORT`) alongside its existing stdio and Unix-socket transports, using the identical line-delimited JSON envelope.

The synthesized agent-server app is generated on the fly (a `berth.yml` plus a plain, pre-built `dist/index.js`, no TypeScript compile step) and vendors `@berth/sdk` the same way `berth init` already does for apps outside the pnpm workspace (`packages/sdk/dist-external/berth-sdk.tgz`). Its runtime is deliberately self-contained. It dials sibling apps' RPC Unix sockets directly with `node:net` and calls the LLM API directly with `fetch()`, rather than importing `@berth/agents` itself, which would drag `@anthropic-ai/sdk`/`openai` (and their own vendoring) into the sandbox. Because a live `LLMProvider` object can't be serialized into generated source, networked peers are limited to the two built-in providers (`{provider: "anthropic" | "openai", model?, apiKeyEnvVar}`), not an arbitrary custom `LLMProvider`. In-process `Agent`s have no such limit.

### What's real, and what's still ahead

- **Real today:** two independent Computer/container boots joined to a shared Docker network, each peer running its own agent loop inside its own sandbox over its own tools, and a host-side manager reaching each peer's `run_task` export to complete real multi-peer tasks.
- **Host-mediated, not container-to-container mesh, yet:** `Crew.networked()`'s dispatch to a peer currently goes through `Computer`'s existing `invokeAppExport`/`createStdioRpcClient` transport, meaning the host talks to each container rather than peers talking directly. The Docker network join and the TCP RPC listener are real, working substrate for peers to reach each other directly. Wiring a genuine container-to-container mesh dispatch path through that instead of the host is follow-up work.
- **Unrestricted egress, not a scoped broker, yet:** the synthesized agent-server app declares `network:connect:*` rather than routing its LLM API calls through a capability-scoped broker. The existing egress broker (`docs/egress-broker-reference.md`) only host-matches `browser:navigate:*` today, not arbitrary API hosts. Extending it, or adding a comparable one, for LLM egress is a documented follow-up, not something this does yet.
- **No auth or TLS between peers, yet:** plaintext line-JSON on a private, single-Docker-host, user-defined bridge network. Same trust model the existing context-bus and semantic-fs Unix sockets already operate under, just extended across containers instead of staying within one.
- **Single Docker host only, for now:** no cross-host or multi-machine fleet networking. Blocked on the same gap remote fleets generally have, covered below.

`network:peer:<name>` (see the [mesh reference](./mesh-reference.md)) is a separate, real primitive that closes two of these gaps in a different way: a genuine encrypted WireGuard tunnel between containers, not host-mediated RPC, with mutual-consent authorization instead of no auth at all between peers. `Crew.networked()` doesn't use it yet. Rewiring it onto the mesh instead of the plain Docker bridge is its own follow-up.

## Networked Crew over a remote fleet (E2B, Daytona, K8s)

`bootNetworkedAgent({fleet: {adapter, port?}})` deploys a peer to a remote fleet instead of booting it as a local Docker container. The manager agent gets back an identical `Tool` either way — `Crew.networked()` needs no awareness of which transport a peer ended up on (see `NetworkedAgent.transport`, `"local" | "http"`, informational only).

This is a different transport from the Docker-network path above, not an extension of it, and deliberately not the WireGuard mesh either — considered and ruled out, not overlooked: mesh-coordinator's own peer-lookup API (`GET /peers?name=`) requires the caller to already be a registered, mutually-matched peer, and every existing mesh participant is a container/pod running its own `mesh-daemon`. A host-side manager process (a plain Node process on a laptop or CI runner) has no way to join the mesh without an entirely new subsystem — a mesh-daemon-equivalent host client with its own keypair and `wg0` interface — which is out of scope here. So instead: a new HTTP RPC bridge (`@berth/sdk`'s `startHttpRpcServer`, gated by a per-boot bearer token) dispatched over whichever real, reachable URL the adapter can produce for the port — E2B's `getHost()`/Daytona's `getPreviewLink()` (the same real public HTTPS reverse-proxy URLs `previewUrl()` already uses) or, for K8s, a `NodePort` Service instead of `previewUrl()`'s `ClusterIP`-only one. See each adapter's `rpcUrl()`.

**Real today:** deploying a peer via any `DeployAdapter` that implements `rpcUrl()` (E2B, Daytona, K8s all do), generating a per-boot auth token, waiting for the instance to report `running` and the bridge to answer `/healthz`, then dispatching real tool calls to it over that URL — verified end-to-end at the protocol level in `packages/agents/src/fleet-computer.test.ts` and manually against a real (non-mocked) resident app's runtime.

**Real caveats, not glossed over:** K8s's `NodePort` reachability depends on the cluster's node IPs actually being reachable from wherever the manager runs — true for `kind`/local/on-prem, not guaranteed on a managed cloud cluster that firewalls node IPs (same caveat class `previewUrl()`'s K8s case already documents). The bridge's own auth is a single shared bearer token per boot, not per-export ACLs — the same trust level a `docker exec` caller already has locally, now reachable over a real network instead of only via host access, so the token is the whole security boundary. No `kind`-cluster end-to-end milestone test exists yet for the K8s path specifically (mocked-adapter unit tests only, same posture E2B/Daytona's adapters already have) — a real live-account test for E2B/Daytona isn't attempted for the same reason neither adapter has one anywhere else in this repo.

## Other scope boundaries (v1)

- **Local Docker only, for `createAgent()`/`Computer.boot()` specifically.** These still always target local Docker, same as `berth dev` — no `DeployAdapter` implementation exposes anything like `invokeAppExport`'s docker-exec/attach, so a plain `Computer` still can't be backed by a remote fleet instance directly. `bootNetworkedAgent({fleet})` (above) reaches a remote fleet instance too, but via a different mechanism (an HTTP RPC bridge, not `invokeAppExport`) — this is not a general remote-`Computer` capability.
- **App directories, not registry names.** Pulling a resident app "by name" from the app registry only ever gets you a source bundle that still needs a local Docker build (see `docs/app-registry-reference.md`). `apps:` takes local directory paths.
- **Tool schema fidelity matches the manifest, not your code.** `berth.yml`'s `exports:` grammar is intentionally flat (`string | number | boolean | object | array`, no nesting), the same limitation `berth mcp`'s tool bridge already has. Whatever richer Zod schema you wrote in `app.export({input: ...})` never crosses the RPC wire, so it isn't available here either.

## Examples

Start with [`examples/agents/simple-agent`](../examples/agents/simple-agent). It depends on `@berth/agents` as an ordinary `workspace:*` package dependency, the shape an external project's `package.json` would actually use, rather than a relative import into this repo's own build output.

```bash
cd examples/agents/simple-agent
export OPENAI_API_KEY=sk-...
pnpm start
```

[`examples/agents/agent-server`](../examples/agents/agent-server) runs the other direction. The agent isn't driving anything, it's the thing being served. A plain HTTP server boots (or connects, via `BERTH_OS_CONNECT`) a `Computer`/`Agent` once at startup, then answers `POST /task { task }` requests against it. This is the pattern for putting an agent behind a real API instead of a one-shot script.

For multi-agent composition, narrative and runnable demonstrations (not hard-assertion tests) live in
[`packages/agents/examples/`](../packages/agents/examples/README.md).

```bash
cd packages/agents
export OPENAI_API_KEY=sk-...
node examples/single-agent.mjs      # createAgent(), one Computer, one Agent
node examples/manager-crew.mjs      # Crew.withManager(), two in-process worker agents
node examples/networked-crew.mjs    # Crew.networked(), two independent networked agent-computers
```

## Verification

```bash
cd packages/agents
node test/computer-boot-milestone.mjs          # real: single-app Computer, live tool list, write_file/read_file round trip
node test/computer-multi-app-milestone.mjs     # real: filesystem + code-editor, namespaced tools, both independently callable
node test/governance-gate-milestone.mjs        # real: a governs:true app's evaluate_action gates every other app's Tool.invoke, blocking calls that don't return {allowed: true}
node test/provider-swap-milestone.mjs          # real: same Computer's tools, driven once by each built-in provider (needs ANTHROPIC_API_KEY + OPENAI_API_KEY)
node test/crew-manager-milestone.mjs           # real: manager agent delegates across two in-process worker agents (needs ANTHROPIC_API_KEY)
node test/crew-networked-milestone.mjs         # real: two independent networked agent-computers complete delegated tasks (needs ANTHROPIC_API_KEY)
```

The first three need only a local Docker daemon and run in CI (`.github/workflows/agents-milestone.yml`). The other three need real LLM API credentials and stay manual, local-only runs, consistent with how this repo treats anything needing external credentials.
