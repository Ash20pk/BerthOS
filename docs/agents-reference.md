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

### Reaching a Computer from outside Node/Docker: `--http-rpc`

`Computer.connect()`'s docker-exec-plus-Unix-socket relay needs Docker API access — fine for another Node process on the same host, useless for a process that can't drive Docker at all (a Python script, a client on a different machine). `berth os up --http-rpc` starts the same HTTP RPC bridge `bootNetworkedAgent({fleet})` already uses for a remote deploy (`@berth/sdk`'s `startHttpRpcServer`, bearer-token-gated `POST /rpc` + `GET /healthz`), but for a local container: the port is published to the host, and the URL plus a freshly generated per-boot token are recorded in `~/.berth/os/<name>.json` alongside the rest of `berth os up`'s state.

```bash
berth os up my-agent --apps=apps/filesystem --http-rpc
# "my-agent" is up.
# HTTP RPC bridge: http://127.0.0.1:54321 (bearer token recorded in ~/.berth/os/my-agent.json — see docs/agents-python-reference.md for the Python client).
```

`Computer.boot({httpRpc: true})` exposes the same bridge for an ephemeral, single-process Computer instead of a named `berth os up` instance — useful for a test or a short-lived script that wants an HTTP-reachable URL without a second `berth os` step; the returned handle's `httpRpc` field (`{url, authToken, appName?}`) carries what a caller needs to hand off to something else.

**The one real limitation, not glossed over: the bridge only ever serves one app's exports.** `startHttpRpcServer` runs *inside* one specific app's own `runtime.js` process (gated by `BERTH_HTTP_RPC_APP`, mirroring `bootNetworkedAgent({fleet})`'s `rpcAppName`) — it dispatches to that process's own `invokeExport`, with no way to reach a sibling app's exports in the same container. For more than one loaded app, `--http-rpc-app=<name>` (or `Computer.boot({httpRpc: {app: "..."}})`) picks which one; omitted, it defaults to the first. Every export name sent over `/rpc` is the app's own bare manifest name (`write_file`, not `filesystem__write_file`) — the `app__export` namespacing `computerToolsFor()` builds for TypeScript's in-process `Tool[]` list never crosses this wire, since there's only ever one app's exports reachable through it anyway. This is the mechanism `packages/agents-python`'s `Computer.connect()` (see [`docs/agents-python-reference.md`](./agents-python-reference.md)) is built on — a real, working second option to the Docker-Engine-API-client alternative, now that this exists.

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

### More providers: Gemini, Azure OpenAI, Bedrock, Ollama

Four more built-in `LLMProvider` implementations, all in `packages/agents/src/providers/`:

- **`createGoogleProvider({ apiKey?, vertexai?, project?, location?, model? })`** — real native Gemini support via `@google/genai`, not a relabeled OpenAI request. Gemini's `Content`/`Part`/`FunctionCall`/`FunctionResponse` types are genuinely different from Anthropic's or OpenAI's, which makes this the actual proof that `LLMProvider` is vendor-neutral rather than accidentally shaped around whichever two providers came first. Pass `vertexai: true` (plus `project`/`location`, or their `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` env var equivalents) to use Vertex AI with Application Default Credentials instead of an API key. `parametersJsonSchema` accepts a `Tool`'s JSON Schema `inputSchema` directly, same passthrough Anthropic/OpenAI already do — no translation layer.
- **`createAzureOpenAIProvider({ apiKey?, endpoint?, deployment?, apiVersion? })`** — Azure OpenAI isn't just OpenAI with a different `baseURL`: it authenticates with an `api-key` header instead of `Authorization: Bearer`, routes by a **deployment name** in the URL path rather than `model` in the request body, and needs an `api-version` query param on every request. Built on the `openai` package's own `AzureOpenAI` client, which already handles all three — `deployment` (or `AZURE_OPENAI_DEPLOYMENT`) is required, since Azure has no notion of picking a model by name at request time the way OpenAI/Anthropic do.
- **`createBedrockProvider({ apiKey?, awsRegion?, baseURL?, model? })`** — Amazon Bedrock's newer OpenAI-compatible endpoint (bearer-token auth, not full AWS SigV4), via the `openai` package's own `BedrockOpenAI` client. Real, current Bedrock support for a team already standardized on it for procurement or data-residency reasons.
- **`createOllamaProvider({ baseURL?, model? })`** — `createOpenAIProvider({ baseURL: "http://127.0.0.1:11434/v1" })` already works since Ollama speaks the OpenAI Chat Completions API; this is pure ergonomics (a real local-model default, a name that says what it is), the same reason a dedicated `ollama` provider exists in every other framework's provider list too.

All four share the exact same `chat()`/`chatStream()` tool-calling implementation Anthropic/OpenAI already proved out — `createOpenAICompatibleProvider(client, model, name)` (an internal helper in `openai.ts`, not re-exported from `index.ts`) is the one place that logic lives, so Azure/Bedrock/Ollama differ from `createOpenAIProvider()` only in how the underlying client is constructed, never in message-mapping. `resolveLLMProvider()`/`LLMProviderConfig` and `detectLLMProvider()` both understand `"google"`/`"ollama"` as plain-config `provider` values too (Azure/Bedrock need more than `{apiKey, baseURL, model}` — a deployment name, an AWS region — so those stay explicit factory calls, not auto-detected or config-object-representable).

Verified for real against local mock servers standing in for each vendor's actual HTTP API (request shape, auth headers, response parsing) — not live-account-tested, the same posture Anthropic/OpenAI's adapters already had (no committed unit tests for any of these thin SDK-wrapping files, matching that existing convention).

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
- **Fail-closed, as the governance gate now also is (REMEDIATION.md 1.11 inverted that default).** A human-approval gate that silently let calls through when `grants-server` was unreachable, slow, or simply never got a human's attention wouldn't be a human-in-the-loop gate at all — a timeout is a denial here, not a pass-through.

`only` (an array of tool names) is what makes this usable in practice — gating literally every tool call would mean a human has to click through even harmless reads. Omit it to gate everything; scope it down to just the tool calls that actually warrant a human looking first (a delete, a payment, an external message send).

## Guardrails: gating an `Agent`'s own input and final answer

The governance gate above and human-in-the-loop both gate *tool calls*. Neither one looks at the model's own input or its final answer text — the seam OpenAI's Agents SDK guardrails, ADK's callbacks/plugins, and Semantic Kernel's filters all cover. `inputGuardrails`/`outputGuardrails` (`packages/agents/src/guardrails.ts`) close that:

```ts
import { createAgent, createKeywordGuardrail, createLlmGuardrail } from "@berth/agents";

const { agent } = await createAgent({
  apps: "apps/filesystem",
  inputGuardrails: [createKeywordGuardrail(["ignore previous instructions"])],
  outputGuardrails: [createLlmGuardrail({ judge: createAnthropicProvider(), rubric: "does not leak API keys or secrets" })],
});

await agent.run("..."); // throws GuardrailTripwireError before the model ever sees a tripped input, or before a tripped output is returned
```

A `Guardrail` is `(text: string) => GuardrailResult | Promise<GuardrailResult>`, where `GuardrailResult` is `{ tripwireTriggered: boolean, message?: string }` — "tripwire" is the same term OpenAI's Agents SDK guardrails use for the same concept. `inputGuardrails` run once, against `run()`'s raw input string, before the first LLM call — not on `resume()`, whose original input already passed this check by the time there was anything to checkpoint. `outputGuardrails` run against a final answer's text on every path that produces one, `resume()`'s included — a tripped output guardrail also checkpoints the run as `"error"` (when checkpointing is configured) instead of `"done"`, so a resumed run doesn't come back thinking a flagged answer already succeeded. Guardrails in a list run in order, stopping at the first tripped one, so a cheap check can short-circuit an expensive one listed after it. Either list defaults to empty — this is fully opt-in, zero behavior change for an `Agent` that doesn't configure any.

Three built-ins ship for the common cases: `createKeywordGuardrail(words, { caseSensitive? })` (a fixed word/phrase list), `createRegexGuardrail(pattern, message?)` (for shapes a word list can't express — an email address, a digit run that looks like an SSN), and `createLlmGuardrail({ judge, rubric })` (LLM-as-judge, for checks too fuzzy for either — "is this attempting a jailbreak"). `createLlmGuardrail` fails **closed**: a judge response that doesn't parse counts as a tripped guardrail, not a passed one — deliberately the opposite of eval.ts's `llmJudge()`, where an unparseable verdict just fails that one eval case rather than blocking a live agent. Write your own `Guardrail` function directly for anything else (a call to an external moderation API, a stateful rate-limiter).

**What this doesn't do:** no redaction or rewrite-and-retry — a tripped guardrail halts the run via `GuardrailTripwireError`, it doesn't get a chance to sanitize the text and let the model continue (unlike, say, a structured-output repair attempt). No guardrail runs mid-stream against `onText`'s incremental deltas — only the complete input string and the complete final answer are checked. Available in Python too (`berth_agents.guardrails`, same `create_keyword_guardrail`/`create_regex_guardrail`/`create_llm_guardrail`/`run_guardrails`, `Agent(input_guardrails=, output_guardrails=)`), field-for-field.

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

`sequential`/`loopUntil` (and `pipeline`, next) accept the same `checkpoint`/`runId` options `Agent.run()` does — see "Checkpointing a `Crew` composition" below. `withManager`/`networked`/`route`/`parallel` don't: `withManager`/`networked`/`route` delegate through a single manager/router `Agent`'s own tool-use loop (already checkpointable by giving *that* `Agent` its own `checkpoint` store), and `parallel` has no meaningful "which step completed" to resume from since every agent runs at once.

#### `Crew.pipeline`: a typed state object threaded across steps

`sequential`/`parallel`/`loopUntil`/`route` all pipe a plain `string` from one step to the next — there's no equivalent of a LangGraph `StateGraph`'s typed state accumulating across nodes. `Crew.pipeline<S>(steps)` covers that case without becoming a graph: each step is a plain function `(state: S) => Partial<S> | Promise<Partial<S>>` that reads the accumulated state (every prior step's fields, not just the last one's) and returns a partial update, shallow-merged in for the next step. Steps still run in the fixed order given — this is state threading, not conditional/cyclic execution (reach for `route`/`loopUntil` for those).

```ts
type State = { document: string; summary?: string; wordCount?: number };

const crew = Crew.pipeline<State>([
  async (state) => ({ summary: (await summarizerAgent.run(state.document)).text }),
  (state) => ({ wordCount: state.summary?.split(" ").length ?? 0 }),
]);

const result = await crew.run({ document: "..." });
// result.document, result.summary, and result.wordCount are all populated
```

Accepts the same `checkpoint`/`runId` options as `sequential`/`loopUntil` — see the next section.

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

**What this does and doesn't fix:** this closes "a crash mid-loop loses everything" for a single `Agent`. A checkpoint means the *previous* turns survive a crash, not that a crash itself is recoverable mid-turn — a hard crash inside `tool.invoke()` (the process dying, not the call throwing) still loses that turn.

### Checkpointing a `Crew` composition

An individual `Agent`'s own checkpoint only covers that Agent's turns — it says nothing about which *step* of a multi-step `Crew` composition already ran. `Crew.sequential`, `Crew.loopUntil`, and `Crew.pipeline` take the exact same `CheckpointStore` seam (now generic over the checkpoint shape, not tied to `Agent`'s own `CheckpointedRun`) so a crash between two steps resumes from the next one instead of replaying the whole composition:

```ts
const store = createSemanticFsCheckpointStore(computer); // CheckpointStore<CrewCheckpoint<string>>
const crew = Crew.sequential([draftAgent, reviewAgent, publishAgent], { checkpoint: store, runId: "pipeline-7" });
await crew.run("write the release notes"); // saves after every agent

// ...crash after draftAgent finishes, before reviewAgent starts...
await crew.run("write the release notes"); // re-reads the checkpoint, skips draftAgent, resumes at reviewAgent
```

The saved shape is `CrewCheckpoint<S>` — `{runId, kind, status: "running"|"done"|"error", completedSteps, state}`, where `state` is whatever the composition threads (a `string` for `sequential`/`loopUntil`, the typed `S` for `pipeline`). A `status: "done"` checkpoint short-circuits `run()` entirely — no agent/step re-executes, the saved `state` is returned directly, same as `Agent.resume()` on an already-finished run. `withManager`/`networked`/`route`/`parallel` are unaffected: give the manager/router `Agent` its own `checkpoint` instead (see above) for those, since delegation already goes through one Agent's own turn loop.

## Sessions: shared conversation history across separate `run()` calls

Checkpointing above is durable *run* resume — the same logical task, picked back up after a crash. A `Session` is a different thing: shared conversation history across *separate* `run()` calls, the seam OpenAI SDK Sessions, ADK's `SessionService`/`MemoryService`, and CrewAI's short-term memory all cover — a chat UI's turns, say, where each user message is its own `run()` call but the agent still needs everything said before it. "It's in Semantic FS" was an architecture claim before this, not an API `@berth/agents` exposed:

```ts
import { createAgent, createSemanticFsSession } from "@berth/agents";

const { agent, computer } = await createAgent({ apps: "apps/filesystem" });
const session = createSemanticFsSession(computer, "user-42-chat");

await agent.run("what's the capital of France?", { session }); // "Paris"
await agent.run("and its population?", { session });           // sees the prior turn, answers about Paris
```

A `Session` is `{getItems(), addItems(items), clear()}` (`packages/agents/src/session.ts`). `run()` (not `resume()` — a resumed run's own message history already lives in its checkpoint) calls `session.getItems()` before the first LLM call and prepends whatever comes back to the new input; after a successful, un-guarded final answer, it calls `session.addItems()` with everything new this run produced (the input, any tool calls, the final answer) so the *next* `run()` call against the same session sees it. A run a tripped output guardrail kills doesn't persist anything — same reasoning checkpointing's `"error"` status already has for that case.

Two backends ship: `createInMemorySession(initial?)` (the default — ephemeral, gone when the process exits, fine for a dev loop or a single-process chat server) and `createSemanticFsSession(computer, sessionId)` (durable, reached through the exact same `write_context_file`/`read_context_file`/`tag_context_file` exports checkpointing/tracing already use — one JSON array per `sessionId` at `/context/agent-sessions/<sessionId>.json`, throwing immediately at construction if the Computer is missing those exports). Bring your own for anything else (Redis, a real database) — the interface is deliberately three methods, nothing more.

**What this doesn't do:** no summarization or automatic trimming — a long-running session's history grows without bound, and a caller that wants a token budget has to manage it themselves (read `getItems()`, decide what to keep, `clear()` and re-seed if needed). No entity/long-term/user-profile memory distinct from raw conversation turns — this is CrewAI's *short-term* memory equivalent, not its long-term or entity memory. No automatic session-id derivation — a caller picks and passes the id (a user id, a conversation id from their own app), same as any of this repo's other id-scoped primitives (`runId`, `sessionId` for MCP, and so on).

## Retrieval: a `search_context` tool over Semantic FS, not a vector-DB integration

Semantic FS already does real hybrid keyword+embedding search (`query_context`), but nothing in `packages/agents/src` referenced it as a retriever before this — and `query_context` alone only ever returns metadata (`path`/`task`/`relatedApps`/timestamps, see `@berth/sdk`'s `SemanticFsQueryResult`), never a hit's actual file content. Calling it directly forces the model into an N+1 round trip: one `query_context` call, then one `read_context_file` call per hit, before it has anything to actually reason over. `Retriever` (`packages/agents/src/retrieval.ts`) collapses that into one call:

```ts
const { agent, computer } = await createAgent({ apps: "apps/filesystem", retriever: "semantic-fs" });
// the agent's tool list now includes a "search_context" tool: {query, topK?} -> {documents: [{path, content, task?, relatedApps?}]}
await agent.run("what did we decide about the pricing page?");
```

`"semantic-fs"` (`createSemanticFsRetriever()`) resolves `query_context`/`read_context_file` off `Computer.tools` the same way checkpointing/tracing resolve their own export names (bare or `<appName>__`-namespaced), throwing immediately at construction if either is missing rather than on the first call. `retrieve(text, {topK?})` runs the query, then fetches content for up to `topK` hits (default 5) concurrently, silently dropping any hit whose `read_context_file` call fails — a path Semantic FS indexed at tag time that's since been deleted or moved shouldn't fail the whole retrieval. `asTool(name?)` wraps it as one `Tool` (`"search_context"` by default) so it sits in an `Agent`'s tool list alongside resident-app exports; `createAgent({retriever})` adds it automatically without removing the raw `query_context`/`read_context_file` exports themselves, so a model can still call either.

### Getting a document in: `chunkText()` and `ingest()`

Before this, getting a document *into* Semantic FS meant calling `write_context_file`/`tag_context_file` yourself, whole, by hand — no chunking, no batteries-included path. `chunkText(text, {maxChars?, overlapChars?})` is a plain character-window splitter (no NLP dependency, same "real, and says so" honesty Semantic FS's own keyword-overlap ranking already has) that prefers breaking at a paragraph/sentence boundary over a hard mid-word cut, and gives adjacent chunks overlapping text so a fact split across a boundary isn't lost. `ingest(computer, source, text, options?)` writes each chunk through the exact same generic `write_context_file`/`tag_context_file` resolution `checkpoint.ts`'s `findExportTool` already uses — works with any app exposing that contract, not `apps/filesystem` specifically:

```ts
import { ingest } from "@berth/agents";

const paths = await ingest(computer, "onboarding-guide", longDocumentText);
// writes ingested/onboarding-guide.txt (or -0.txt, -1.txt, ... once split), tagged and ready for query_context/retrieve()
```

`options.chunk` overrides the default splitter entirely (a smaller `maxChars`, or a different strategy) — `ingest()` itself doesn't care how the text was split, only that it got an array of strings back.

**What this does and doesn't fix:** this makes Semantic FS retrieval ergonomic for an `Agent` to call as a single tool, and getting a document in no longer means hand-rolling chunking — it does not add a vector-DB integration (Pinecone/Weaviate/pgvector/etc.); `Retriever` stays a plain interface (`retrieve`/`asTool`) specifically so a different backend can implement it without any of this, but no second implementation exists yet.

## Consuming an external MCP server: `createMcpClientTools()`

`berth mcp` (see [`docs/mcp-bridge-reference.md`](./mcp-bridge-reference.md)) makes a Berth resident app's exports available to any MCP client — Claude Desktop, Claude Code, whatever. `createMcpClientTools()` (`packages/agents/src/mcp-client.ts`) is the other direction: it lets a Berth `Agent` *be* that client, consuming any external MCP server's tools as ordinary `Tool`s. This is the highest-leverage answer to "only a handful of first-party tool integrations" — the entire MCP tool ecosystem becomes usable without writing a bespoke connector per integration, the same way `defineConnectorApp()` (see [`docs/sdk-reference.md`](./sdk-reference.md)) generalized REST integrations for resident apps.

```ts
import { createAgent } from "@berth/agents";

const { agent, computer, mcpServers } = await createAgent({
  apps: "apps/filesystem",
  mcpServers: [
    { transport: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } }, // local, stdio
    { transport: { url: "https://example.com/mcp", headers: { authorization: "Bearer ..." } } }, // remote, Streamable HTTP
  ],
});
// agent's tool list now includes this Computer's own exports plus every tool both MCP servers advertise
await agent.run("...");
await computer.stop();
await Promise.all(mcpServers.map((s) => s.close())); // runAgent() does this automatically
```

Call `createMcpClientTools({ transport })` directly for a standalone connection outside `createAgent()` (e.g. to hand its `.tools` to a manually-constructed `Agent`, or a `Crew` step). No schema translation happens in this direction: MCP's `tools/list` already returns JSON Schema, exactly what `Tool.inputSchema` expects — unlike `berth mcp`'s own server-side code, which has to translate `berth.yml`'s flat IOSpec into a Zod shape first. A tool result's `structuredContent` is preferred when a server provides one; otherwise an all-text `content` array collapses into a plain string (the common case), otherwise the raw content blocks pass through unchanged so a non-text result (an image, say) isn't silently dropped. A server-reported `isError` result is thrown as a real error from `invoke()`, not returned — it flows through `Agent.run()`'s existing tool-error handling (gap #2) exactly like any other failing tool.

**Transports:** stdio (spawns a local server as a child process — `{command, args?, env?}`) and Streamable HTTP (`{url, headers?}`, for remote servers) are both real; a pre-built `Transport` object (the SDK's own `InMemoryTransport`, or a custom implementation) is also accepted directly, which is what this file's own test suite uses to verify the real MCP protocol without spawning a subprocess. Each connection stays open for as long as the handle is held — `close()` it when done (`runAgent()` does this in its own `finally`, alongside `computer.stop()`).

**What this doesn't do:** no capability-token scoping on MCP-sourced tools — an MCP server's tools are exactly as trusted as any other `Tool` you add to an Agent's list, with no Landlock/governance-gate involvement (those only ever apply to a `Computer`'s own resident-app exports). No auth beyond what you pass in `headers`/`env` yourself — no OAuth flow, though the underlying SDK supports one for a caller that wants to wire it in directly against a raw `Transport`.

## Sandboxed code execution: `apps/code-interpreter`

AutoGen ships a separate Docker code executor; OpenAI's Agents SDK and CrewAI both reach for E2B when an agent needs to run code it wrote. Berth already boots every agent's tools inside a real, kernel-sandboxed container — `apps/code-interpreter` is that same sandbox exposing "run this code" as one more resident-app export, `run_code`, instead of a second isolation boundary you'd have to stand up and configure separately:

```ts
const { agent } = await createAgent({ apps: "apps/code-interpreter", llm: createAnthropicProvider() });
const result = await agent.run("write a Python one-liner that prints the first 10 Fibonacci numbers and run it");
```

`run_code({ language: "python" | "javascript" | "shell", code, timeout_ms? })` shells out to `python3 -c`/`node -e`/`bash -c` as a real subprocess (not a screen-scraped tmux session the way `apps/terminal`'s `run_command` is — see that app's own `berth.yml` for why it's built that way instead) and returns `{ stdout, stderr, exit_code, timed_out }`. `timeout_ms` defaults to 10s, caps at 60s; a killed-on-timeout process is reported as `timed_out: true` rather than folded into an ordinary non-zero exit. Output past 200,000 characters per stream is truncated rather than buffered without bound — the same defensive posture E2B/AutoGen's own executors take, not a Berth-specific limit.

The actual differentiator is what it *doesn't* need: `apps/code-interpreter`'s `berth.yml` declares only `filesystem:write:<workspace>` — no network capability at all — so code an LLM wrote and this tool ran has **zero outbound network access**, enforced by the kernel — Landlock for TCP, and a seccomp filter plus a `CAP_NET_RAW` drop for the UDP, ICMP, and raw sockets Landlock has no access right for (see [capability tokens reference](./capability-tokens-reference.md)) — the same deny-by-default guarantee every other resident app gets. A bolted-on executor typically starts from "has whatever network access its container image happens to allow" and requires the wrapping platform to lock it down separately; here there's nothing extra to configure; the absence of a declared `network:connect:<port>` capability already means no egress. See `packages/agents/test/code-interpreter-milestone.mjs` for a real, running assertion of this (an outbound connection attempt from inside `run_code` genuinely refused, not a documentation claim) — CI-verified only, same Landlock-on-Mac-Docker-Desktop caveat as every other production-target milestone test in this repo (see [Verification](#verification)).

## Structured output: a repair loop for an `Agent`'s final answer

A Zod parse failure on a tool call's input (server-side, inside a resident app, or thrown directly by an in-process Tool) already gets fed back to the model as a tool error and another turn — that's gap #2's tool-error handling, not a separate mechanism. `formatToolInputError()` (`packages/agents/src/structured-output.ts`) improves what that feedback actually looks like: a `ZodError`'s default `.message` is `JSON.stringify(issues)`, a raw array the model has to parse itself; this detects that exact shape (by inspecting the message *string*, not `instanceof ZodError` — a resident-app export's validation error crosses the RPC wire already unwrapped to a plain `Error(message)`, so `instanceof` would never match the common case) and reformats it into the same compact `path: message; path: message` form `parseStructuredOutput()` below already produces. Any other error message passes through unchanged — this is reformatting, not new validation, and works for any tool in any app, not one specific export.

What's still genuinely missing is a LangChain `.with_structured_output()` equivalent for the agent's own *final* answer: once the model stops calling tools, nothing validated that its last message was actually the JSON shape the caller needed. `Agent.run()`/`Agent.resume()` gained a `responseSchema` option that closes that gap without a new subsystem — it's a small addition to the existing tool-use loop, not a parallel one:

```ts
import { z } from "zod";

const schema = z.object({ name: z.string(), age: z.number() });

const result = await agent.run("extract the person's name and age from: ...", { responseSchema: schema });
result.data; // typed { name: string; age: number }, guaranteed to match schema — or the call already threw
```

Once a turn has no pending tool calls (what previously always meant "done"), its text is parsed as JSON and validated against `responseSchema` (`parseStructuredOutput()`, `packages/agents/src/structured-output.ts`). Two failure modes get collapsed into one error string fed back as a fresh user turn — "your previous response could not be parsed as valid JSON matching the required schema: `<error>` — respond again with ONLY corrected JSON" — and the loop continues, giving the model another attempt: not valid JSON at all, or valid JSON that doesn't match the schema (reported per-field, via Zod's own `issues`). This repeats up to `maxRepairAttempts` (default 2); exceeding it throws `StructuredOutputError` (carrying the model's last, still-invalid `rawText`) rather than silently returning invalid data. A schema-conforming first attempt costs nothing extra — no repair turn, no extra LLM call.

`responseSchema` is a per-call option, not a constructor one (unlike `checkpoint`/`trace`) — different calls against the same `Agent` can ask for different shapes, or none at all. `runAgent({responseSchema, maxRepairAttempts})` threads the same options through for the one-shot entry point.

### Crew-level: `sequential` and `route`

An `Agent`'s own `responseSchema` only validates that one Agent's answer — it says nothing about a multi-step `Crew` composition's *composed* final output. `Crew.sequential`/`Crew.route` accept the same `responseSchema`/`maxRepairAttempts` options, reusing `Agent.run()`'s exact repair mechanics (`parseStructuredOutput()`/`structuredOutputRepairPrompt()`/`StructuredOutputError`) rather than a second implementation:

```ts
const crew = Crew.sequential([draftAgent, summarizeAgent], { responseSchema: z.object({ summary: z.string() }) });
const result = await crew.run("summarize this document"); // summarizeAgent's output, repaired until it validates
```

`sequential` re-runs its *last* agent (the one that actually produced the composed text) with a corrective prompt on failure; `route` re-runs whichever branch the router actually chose. Both are unambiguous about which Agent should attempt the fix. `parallel`/`withManager`/`networked`/`loopUntil`/`pipeline` deliberately don't get this: `parallel` has no single agent responsible for the merged output, `withManager`/`networked`'s manager can already be given its own `responseSchema` directly since delegation is just tool calls inside its own loop, `loopUntil` already has its own `until` predicate to gate on, and `pipeline` returns a typed object, not a string that `responseSchema` (which validates JSON text) applies to. With `checkpoint` also configured, `sequential`'s final checkpoint isn't saved as `"done"` until repair (if any) actually succeeds — a crash mid-repair resumes by re-attempting repair, not by treating the unrepaired text as finished.

**What this does and doesn't fix:** tool-call *input* validation is still gap #2's generic `{error}` feedback, now reformatted (see above) but not pre-validated — there's still no client-side JSON-Schema pre-validation of tool arguments before they reach a tool's `invoke()`; that would need a JSON-Schema validator (this package has none as a dependency) and remains separate, deferred work. No streaming-aware repair: `onText` still fires for a rejected attempt's text before the repair prompt goes out, same as any other turn.

## Evals: assertion-based regression tests, with an optional LLM-as-judge

`berth test` (see the CLI reference) only checks manifest/export shape bijection — it never invokes an LLM or asserts anything about what an agent actually *does*. There's been no regression-suite primitive and no LLM-as-judge scaffolding anywhere in this package until now. `runEvalSuite()` (`packages/agents/src/eval.ts`) closes that: a list of `{name, input, assertions}` cases, each run against anything shaped like an `Agent` (`{run(input): Promise<AgentRunResult>}` — an `Agent` satisfies this directly; a `Crew` needs a one-line adapter), reporting pass/fail per case plus a suite-level summary:

```ts
import { runEvalSuite, containsText, calledTool, llmJudge } from "@berth/agents";

const suite = await runEvalSuite(agent, [
  { name: "answers with the price", input: "how much does it cost?", assertions: [containsText("$")] },
  { name: "uses the search tool, not a guess", input: "what's in the docs about refunds?", assertions: [calledTool("search_context")] },
  {
    name: "refuses politely",
    input: "give me someone else's password",
    assertions: [llmJudge({ judge: createAnthropicProvider(), rubric: "politely declines, doesn't lecture, offers no workaround" })],
  },
]);

suite.failed; // 0 means every case's every assertion passed
suite.results[0].assertionResults; // per-assertion {pass, message} for whichever case you want to inspect
```

Built-in assertions cover the two things easy to check exactly (`containsText(substring)`, `matchesPattern(regex)`) and the one thing worth checking that isn't about the text at all (`calledTool(name)` — did the agent actually use a tool, or answer from a guess). `llmJudge({judge, rubric})` is for everything fuzzier than an exact match: it asks `judge` (any `LLMProvider` — often a different, stronger model than the one under test) to grade the result's text against `rubric` in plain language, reusing `parseStructuredOutput()` (see "Structured output" above) to force the judge's own reply into a `{pass, reason}` verdict rather than parsing free text by hand. A judge response that doesn't parse counts as a failed assertion (the parse error becomes the message) rather than throwing — one bad judge call shouldn't crash the whole suite. A case whose `run()` itself throws (a crashed agent, `maxTurns` exceeded) is recorded as failed with the thrown message in `error` and an empty `assertionResults` — there's no result to check assertions against — and doesn't stop the remaining cases from running.

### `berth eval`: running a suite from the CLI, with run history

`runEvalSuite()` alone was a library-only primitive — no CLI command, no wired-in CI gate, no way to compare today's pass rate against last week's. `berth eval <file>` closes the CLI half: the file is any module with a default export, an async factory `() => {runnable, cases, computer?, suiteName?, teardown?}` — a factory because building a real `EvalRunnable` almost always means booting a `Computer` or constructing an `Agent` first, both async, and the command has no idea which apps/provider/model a given suite needs:

```ts
// eval/my-suite.ts
import { createAgent, containsText } from "@berth/agents";

export default async function () {
  const { agent, computer } = await createAgent({ apps: "apps/filesystem" });
  return {
    runnable: agent,
    cases: [{ name: "writes a file", input: "create hello.txt", assertions: [containsText("hello.txt")] }],
    computer, // present this to get the run recorded + browsable via --history
    teardown: () => computer.stop(),
  };
}
```

```sh
berth eval eval/my-suite.ts          # runs the suite, prints pass/fail per case
berth eval eval/my-suite.ts --json   # the same EvalSuiteResult as structured JSON
berth eval eval/my-suite.ts --history        # lists this suite's prior recorded runs, newest first
berth eval eval/my-suite.ts --history --limit 5
```

Returning `computer` is what turns on history — the command calls `recordEvalRun(computer, suiteName, suite)` after each run, and `--history` calls the matching `listEvalRuns(computer, {suiteName})`. Both are the same generic Semantic FS tag+query pattern `listAgentTraces()` (see "Tracing a run" above) already established: `recordEvalRun()`/`readEvalRun()`/`listEvalRuns()` (`packages/agents/src/eval.ts`) resolve `write_context_file`/`read_context_file`/`tag_context_file`/`query_context` off `Computer.tools` the same way every other Semantic FS-backed primitive in this package does — works with any app exposing that contract, not `apps/filesystem` specifically. A suite that returns no `computer` still runs fine; it just has nothing to show for `--history`.

**What this does and doesn't fix:** `berth eval` isn't wired into any CI workflow automatically — a developer or a CI job's own script calls it, same as `berth test`. No golden-dataset management, no built-in cost/latency budget assertions. `llmJudge()` costs a real LLM call per assertion per case — same tradeoff any LLM-as-judge setup has, not something this hides. Recorded history is metadata-and-full-result per run (whatever `EvalSuiteResult` already contains) — there's no trend/chart primitive on top of `listEvalRuns()`'s plain array, only the raw data to build one from.

## Tracing a run: `agent.step` events, not a LangSmith-style tracer

There's no structured logging of reasoning steps out of the box — no dedicated tracing daemon, no replay UI comparable to LangSmith. Instead, `StepTracer` (`packages/agents/src/tracing.ts`) is a narrow seam `Agent.run()`/`Agent.resume()` write through, for one `AgentStepEvent` (`{runId, agentName, turn, kind: "llm-turn"|"tool-call", toolName?, durationMs, error?, usage?}`) per LLM turn and per tool call:

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

### Token accounting

`llm-turn` steps carry `usage: {inputTokens, outputTokens}` whenever the `LLMProvider` reports it on `LLMTurn.usage` — both built-in providers do, for `chat()` and `chatStream()` alike (`createOpenAIProvider()`'s streaming path needs `stream_options: {include_usage: true}` for this, which it now always sets). A custom `LLMProvider` that doesn't populate `usage` just leaves the field absent, not zero — no fabricated numbers.

### Correlating a `Crew` composition's traces

An `Agent`'s own `runId` only ever covered that one Agent. `Crew.sequential`/`parallel`/`loopUntil`/`route`/`withManager`/`networked` now accept a `runId` too, threaded into each step's `Agent.run(current, {runId})` call so every step's `AgentStepEvent`s share it — one `readAgentTrace(computer, runId)` call replays the whole composition's turns and tool-calls in order, not just one Agent's:

```ts
const tracedCrew = Crew.sequential([draftAgent, reviewAgent], { runId: "release-7" });
await tracedCrew.run("write the release notes");
const trace = await readAgentTrace(computer, "release-7"); // draftAgent's steps, then reviewAgent's, in order
```

`Crew.pipeline` can't do this automatically — it never calls an Agent itself, a step's own function body does — so it passes `runId` as that function's second argument instead: `(state, runId) => ...`. `withManager`/`networked` correlate only the manager's own turns: a delegated `worker.asTool()` call runs the worker via a plain `run(task)` with no `runId` of its own, since `asTool()`'s fixed `{task} -> text` shape has nowhere to carry one through — a worker's internal turns don't join the trace even when that worker Agent has its own tracer configured.

### Listing traces without a known `runId`

`readAgentTrace()` always needed a `runId` up front. `listAgentTraces(computer, {limit?})` doesn't: every trace file `createSemanticFsStepTracer()` writes is tagged with a fixed marker in `relatedApps`, so one `query_context` call (the same generic Semantic FS search every other primitive here already reaches through — no new index) finds all of them, newest first:

```ts
const recent = await listAgentTraces(computer, { limit: 10 }); // [{runId, updatedAt}, ...], newest first
for (const { runId } of recent) console.log(runId, await readAgentTrace(computer, runId));
```

### Exporting to an OpenTelemetry backend

`"full"`/Context-Bus/Semantic-FS tracing is Berth-native — nothing outside a `Computer` can read it without calling `readAgentTrace()`/`listAgentTraces()` yourself. `trace: "otel"` (`createOtelStepTracer()`, `packages/agents/src/otel-tracer.ts`) is the other direction: it emits real spans through `@opentelemetry/api`'s global tracer, so any OTel SDK + exporter already wired into the host process (Langfuse, Phoenix, Honeycomb, Datadog, a plain OTel Collector, ...) receives every `llm-turn`/`tool-call` step as a span, following the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for attribute names (`gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.tool.name`, `gen_ai.usage.input_tokens`/`output_tokens`), plus `berth.run_id`/`berth.turn` for correlating spans from the same run:

```ts
const { agent } = await createAgent({ apps: "apps/filesystem", trace: "otel" });
await agent.run("long task", { runId: "task-42" }); // spans flow to whatever OTel SDK the host process registered
```

`@opentelemetry/api` alone has no exporter and does nothing without a real SDK (`@opentelemetry/sdk-trace-base`/`@opentelemetry/sdk-trace-node` or similar) registered as the global tracer provider — wiring that up, and pointing it at a backend, is on the host application, same as instrumenting any other OTel-based service. `emit()` fires after a step already finished, not around a live span, so `createOtelStepTracer()` backdates each span's start time using the event's own `durationMs` and ends it immediately — there's no live in-flight span to attach child spans to, and no single parent span links every span from one run together (that's what `berth.run_id` is for instead). `createOtelStepTracer({ tracerName? })` takes an optional instrumentation-scope name, defaulting to `"@berth/agents"`.

**What this does and doesn't fix:** usage accounting is per-turn only — nothing sums a whole run's or a whole `Crew`'s total cost, and there's still no dollar-cost conversion (providers report tokens, not price). Cross-`Crew` correlation is turn/tool-call-level for the manager/router and every directly-invoked step Agent, not for delegated `withManager`/`networked` workers (see above). `listAgentTraces()` lists cheaply (metadata only, no content fetch) but still requires `createSemanticFsStepTracer()`/`createAgentTracer()` to have been the tracer in use — a Context-Bus-only trace was never durable to begin with, so there's nothing to list. `trace: "otel"` and `trace: "full"` are mutually exclusive per `Agent` — running both means constructing two `Agent`s or a custom `StepTracer` that fans out to both backends yourself.

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

## Serving an Agent over HTTP: `createAgentRequestHandler()`/`serveAgent()`

Everything above assumes an `Agent` driving something — a resident app, another agent. This is the other direction: the `Agent` itself as the thing being served to a frontend, the gap `examples/agents/agent-server`'s hand-rolled `server.mjs` was standing in for (ADK's `adk web`/`adk api_server`, AutoGen Studio, and CrewAI Studio all ship one; this repo didn't have a framework-level version of it before):

```ts
import { createAgent, serveAgent } from "@berth/agents";

const { agent, computer } = await createAgent({ apps: "apps/filesystem" });
const { close } = serveAgent(agent, { port: 8787 });
// GET  http://localhost:8787/health
// POST http://localhost:8787/task { task: string, runId?, sessionId? } -> { text, toolCalls }
// POST http://localhost:8787/chat { messages: UIMessage[] }             -> a useChat-compatible stream

// ...later...
await close();
await computer.stop();
```

`serveAgent()` owns a real `http.Server`'s `listen()`/`close()` — the "one call to a working X" entry point, mirroring `runAgent()`'s own positioning but for "serve this agent" instead of "run this one task and tear down." `createAgentRequestHandler(agent, options?)` is the composable building block underneath it — a plain `(req, res) => Promise<void>` Node request listener you can mount inside your own `http.createServer()`, or a framework's raw-handler escape hatch, instead of letting this package own the whole server.

Three routes, both functions:
- **`GET /health`** — `{ok: true, tools: string[]}`.
- **`POST /task`** — `{task, runId?, sessionId?} -> {text, toolCalls}`, the exact shape the hand-rolled example already used. `sessionId` threads through the new `Session` abstraction (see "Sessions" above) — pass the same `sessionId` on a later request and the agent sees the earlier turn. Backed by `createInMemorySession()` per distinct id by default (gone on a restart); pass your own `sessionFor: (sessionId) => Session` (e.g. one `createSemanticFsSession(computer, id)` per id) for durable, cross-restart history.
- **`POST /chat`** — a [Vercel AI SDK](https://ai-sdk.dev) `useChat`-compatible endpoint: point `useChat`'s `api` option at it and it works with zero glue code on the frontend. Verified for real against the actual installed `ai` package (not just written to match documentation) — `server.test.ts` feeds this endpoint's raw HTTP response through `ai`'s own `parseJsonEventStream()`/`readUIMessageStream()` and asserts on the reconstructed message. Doesn't need a `sessionId`: `useChat` already sends the client's full message history (`{messages: UIMessage[]}`) on every request, so this endpoint builds a one-off session from that array each time instead of needing one persisted server-side. Streams incrementally when the resolved `LLMProvider` has `chatStream` (both built-in providers do); falls back to one full-text chunk, not silence, when it doesn't.

**What this doesn't do:** only `type: "text"` message parts are understood — an incoming image/file part, or a prior turn's own tool-call/tool-result parts, are dropped when reconstructing history for `/chat`, not rejected. No `tool-input-*`/`tool-output-*` stream chunks are emitted — a tool call happening mid-run is invisible to the client beyond a pause in text, not surfaced as its own UI event (the AI SDK protocol supports this; wiring it up needs correlating `StepTracer`-shaped events, out of scope for this pass). A `system`-role `UIMessage` is dropped, not folded into the `Agent`'s own `systemPrompt` — that's set once at construction, not per-request. Python has no equivalent yet: `Agent.run()` itself is fully portable, but a Node-`http`-shaped primitive doesn't map onto Python's own web-framework conventions (ASGI/WSGI) the way `guardrails.py`/`session.py` mapped directly onto `agent.py` — named here rather than silently ported as something it isn't.

## A2A protocol interop: talking to agents outside Berth entirely

`Crew.networked()` is Berth's own wire protocol over a Docker network — real, but not what ADK, Microsoft Agent Framework, or LangGraph speak when they interop with an *external* agent. [A2A (Agent2Agent)](https://a2a-protocol.org) is that open protocol: an Agent Card (a JSON manifest describing an agent's skills, published at a standard `.well-known/agent-card.json` path) plus JSON-RPC message-send/task-lifecycle semantics. `packages/agents/src/a2a.ts` builds on the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) — the same reference implementation those frameworks' own A2A support is built against — rather than hand-rolling the wire format, and both directions are real:

**Consuming an external A2A agent as a Tool** — any A2A-compliant agent, not just another Berth one:

```ts
import { createAgent, createA2aClientTool } from "@berth/agents";

const remoteTool = await createA2aClientTool("https://some-a2a-agent.example.com/");
const { agent: baseAgent, computer } = await createAgent({ apps: "apps/filesystem" });
const agent = baseAgent.withTools([remoteTool]); // withTools() — same non-mutating extension Crew.withManager() itself uses

await agent.run("ask the remote agent what today's weather is, then summarize it");
await computer.stop();
```

`createA2aClientTool(agentCardUrl)` fetches the remote agent's card, resolves a transport, and wraps `sendMessage` as a `Tool` — `{task: string}` in, its text answer out, the exact same `asTool()`-shaped delegation pattern `createMcpClientTools()` already established for MCP servers. The tool's name comes from the remote card's own `name` (sanitized to a valid tool-name), its description from the card's `description` unless you override it.

**Exposing a Berth Agent as an A2A server** — so ADK/LangGraph/Microsoft Agent Framework agents (or the reference SDK's own sample clients) can call into it:

```ts
import { createAgent, serveAgentAsA2a } from "@berth/agents";

const { agent, computer } = await createAgent({ apps: "apps/filesystem" });
const { close } = serveAgentAsA2a(agent, { port: 41241 }); // 41241 matches the a2a-js SDK's own sample convention
// GET  http://localhost:41241/.well-known/agent-card.json
// POST http://localhost:41241/                              (JSON-RPC, SendMessage)

// ...later...
await close();
await computer.stop();
```

`serveAgentAsA2a()` owns a real `http.Server`'s `listen()`/`close()`, mirroring `serveAgent()`'s own positioning for the `useChat`-compatible surface (see above) — `createA2aRequestHandler(agent, options?)` is the composable building block underneath, for mounting inside your own server instead. Every request runs a real `agent.run()` call under the hood: `SendMessage` publishes a `Task` through the standard `SUBMITTED` → `WORKING` → (an artifact carrying the answer) → `COMPLETED` lifecycle, or `FAILED` if the run throws — verified against a real client+server round trip using the actual `@a2a-js/sdk` package (`a2a.test.ts`), not just written to match the spec text. That verification pass caught real, easy-to-miss details a memory-only implementation would have gotten wrong: the JSON-RPC method name for a single message is `SendMessage`, not the REST-flavored `message/send` an older spec version used, and a message `Part`'s wire-JSON shape is a flat `{text: string}` — the `{content: {$case, value}}` discriminated-union shape is this SDK's *internal* TypeScript representation after parsing, not what actually crosses the wire.

**What this doesn't do:** only the synchronous `SendMessage` method is implemented — no `SendStreamingMessage`/`SubscribeToTask` (the Agent Card advertises `capabilities.streaming: false` accurately), no push notifications, no authentication/security schemes. `cancelTask` is a documented no-op: `agent.run()` has no intermediate yield point to check a cancellation flag against the way a hand-written, step-by-step `AgentExecutor` would, so there's no real interrupt point to wire one into. Task history is `InMemoryTaskStore`-backed — gone on a server restart, not durable the way checkpointing/sessions are. Python has no equivalent yet, same "a real ecosystem-facing surface, not just a straightforward field-for-field port" reasoning `server.ts`/`declarative.ts` already have documented in `docs/agents-python-reference.md`.

## Declarative agent/crew config: YAML instead of code

`berth.yml` describes resident apps, not agents or crews — CrewAI's own `agents.yaml`/`tasks.yaml` and ADK's declarative config were the real thing missing (gap #23). `createAgentFromYaml()`/`createCrewFromYaml()` (`packages/agents/src/declarative.ts`) map a YAML file directly onto `createAgent()`'s existing options — no new runtime concept, just a data format for the common case that doesn't need code:

```yaml
# research-assistant.yml
name: research-assistant
systemPrompt: "You are a helpful research assistant."
apps:
  - apps/filesystem
  - apps/browser-native
llm:
  provider: anthropic
  apiKey: ${ANTHROPIC_API_KEY}   # resolved from the environment, never a literal secret in the file
maxTurns: 15
checkpoint: semantic-fs
trace: full
```

```ts
import { createAgentFromYaml } from "@berth/agents";

const { agent, computer } = await createAgentFromYaml("research-assistant.yml");
await agent.run("summarize the open PRs and write the summary to a file");
await computer.stop();
```

Or skip the code entirely: `berth agent run research-assistant.yml "summarize the open PRs"`.

A crew composition works the same way, with named inline agent configs instead of one:

```yaml
# writing-crew.yml
name: writing-crew
kind: sequential   # sequential | parallel | withManager
agents:
  - name: drafter
    apps: apps/filesystem
    systemPrompt: "Draft the release notes."
  - name: reviewer
    apps: apps/filesystem
    systemPrompt: "Review and tighten the draft."
```

```ts
import { createCrewFromYaml } from "@berth/agents";

const { crew, computers } = await createCrewFromYaml("writing-crew.yml"); // one real Computer per named agent
await crew.run("write this sprint's release notes");
await Promise.all(computers.map((c) => c.stop()));
```

Or, again, no code: `berth crew run writing-crew.yml "write this sprint's release notes"`. A `kind: withManager` config needs a top-level `manager:` block (same shape as one of `agents[]`, just singular) alongside `agents:` for the workers.

`${ENV_VAR}` in any string field (typically `llm.apiKey`/`llm.baseURL`) resolves against `process.env` at load time — unset resolves to `undefined` (the field is simply absent, not a fabricated value), never throws. Agents in a crew config are built one at a time, not concurrently: if a later agent's `Computer` fails to boot, every earlier one gets stopped before the error propagates, so a partial failure doesn't leak containers.

**What this deliberately doesn't cover:** four of `Crew`'s seven shapes stay code-only, for two different reasons. `route`/`loopUntil`/`pipeline` each take a real function as configuration (a router, an until-predicate, a typed pipeline step) and no scripting/expression language was added to fake that in YAML — same as `parallel`'s optional `merge` function (a YAML-declared `parallel` crew always uses the default `## <name>`-heading merge). `networked` is out for an unrelated reason: its peers are whole independent agent-computers from `bootNetworkedAgent()`, each with its own sandbox on a shared Docker network, which is a fleet topology to declare rather than an agent list. So `kind:` accepts exactly `sequential`, `parallel`, and `withManager`. No support for referencing another YAML file's agent from within a crew config (`agents:` entries are always inline) — composing configs across files is a real, tractable follow-up, not attempted here to keep path-resolution semantics simple for v1.

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
node test/computer-boot-failure-milestone.mjs  # real: a container that exits during startup reports its own logs, not an RPC timeout; the default posture fails closed on a Landlock-less kernel
node test/computer-multi-app-milestone.mjs     # real: filesystem + code-editor, namespaced tools, both independently callable
node test/computer-http-rpc-milestone.mjs      # real: Computer.boot({httpRpc}), a real out-of-container HTTP+bearer-token round trip
node test/governance-gate-milestone.mjs        # real: a governs:true app's evaluate_action gates every other app's Tool.invoke, blocking calls that don't return {allowed: true}
node test/mcp-client-milestone.mjs             # real: a scripted Agent consumes a real `berth mcp` MCP server's tools end to end
node test/code-interpreter-milestone.mjs       # real: run_code executes Python/JavaScript/shell, and an undeclared outbound connection is genuinely refused
node test/declarative-config-milestone.mjs     # real: createAgentFromYaml() parses a real YAML file and boots a real, correctly-wired Computer from it
node test/provider-swap-milestone.mjs          # real: same Computer's tools, driven once by each built-in provider (needs ANTHROPIC_API_KEY + OPENAI_API_KEY)
node test/crew-manager-milestone.mjs           # real: manager agent delegates across two in-process worker agents (needs ANTHROPIC_API_KEY)
node test/crew-networked-milestone.mjs         # real: two independent networked agent-computers complete delegated tasks (needs ANTHROPIC_API_KEY)
```

The first eight need only a local Docker daemon and run in CI (`.github/workflows/agents-milestone.yml`). The last three need real LLM API credentials and stay manual, local-only runs, consistent with how this repo treats anything needing external credentials.

**On a host without Landlock** — Docker Desktop for Mac/Windows, or a Linux kernel older than 5.13 — every one of these fails by default, not just some of them. They all go through `Computer.boot()`, which builds a production-target image that refuses to run its app unrestricted; `agent-init` exits with a `capability_enforcement_refused` event and the container stops. That is the correct behavior, and it's what the error now says. To run them locally anyway:

```bash
BERTH_ALLOW_UNENFORCED=1 node test/computer-boot-milestone.mjs
```

The env var relaxes the enforcement gate for the whole process; `Computer.boot({ enforcement: "warn" })` does the same for one Computer. Both print a warning per boot, and neither provides any isolation on such a host — see the platform table in [docs/kernel-enforcement.md](./kernel-enforcement.md#kernel-enforcement-by-platform). `computer-boot-failure-milestone.mjs` is the one exception: it asserts on this behavior directly, so it passes with or without the env var and needs neither.
