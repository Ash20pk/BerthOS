# Gap analysis: `@berth/agents` vs. LangChain/LangGraph

Working list of concrete gaps found by auditing `packages/agents`, `packages/mesh-coordinator`/`mesh-daemon`, `packages/sdk`, and `packages/sdk-python` against LangChain/LangGraph's feature set (2026-08-04). Ranked by how quickly each would surface in a head-to-head technical evaluation. Status is updated as gaps get closed — see the progress log at the bottom for what changed and why.

Design constraint that shapes every "fixed" entry below: **no LangGraph-style node/edge graph DSL.** Where LangGraph would reach for a dedicated subsystem (a checkpointer, an interrupt primitive, a tracer), Berth's answer is to expose primitives the OS layer already has (Semantic FS, Context Bus, grants-server) to `@berth/agents`, rather than build a parallel one.

## Status key

- 🔴 Open — not started
- 🟡 Partial — some real progress, real scope left
- 🟢 Closed — done, verified (tests/build passing)

---

## Tier 1 — would lose a head-to-head immediately

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| 1 | No state-graph/node-edge orchestration model | 🟡 Partial | **Closed for cycles/fan-out/branching (2026-08-04), branch `feat/crew-composable-functions`**: `Crew` gained `parallel`/`loopUntil`/`route` — same "just wiring over `Agent`" stance as the original three, not a graph DSL. `parallel(agents, {merge?})` fans out to every agent concurrently and combines outputs; `loopUntil({agent, until, maxIterations?})` is the cycle, feeding an agent's own output back in until a predicate fires or a turn cap is hit; `route({router, routes, fallback?})` is the conditional branch, an LLM classifying input to one of a fixed set of downstream agents. **Still open**: no explicit shared-state object threaded across steps (each function only ever passes a `string` along, same as the original three) — a LangGraph `StateGraph`'s typed state accumulating across nodes has no equivalent here. |
| 2 | Tool-call errors kill the entire agent run | 🟢 Closed | **Closed (2026-08-04), branch `fix/agent-tool-error-handling`**: `Agent.run()`'s tool loop (`agent.ts`) now wraps `tool.invoke()` in try/catch and feeds `{ error: <message> }` back to the model as that call's tool result — same pattern the existing "no such tool" case already used. The model gets a chance to retry, try another tool, or explain the failure, instead of the run throwing straight out. |
| 3 | No token-level streaming | 🟢 Closed | **Closed (2026-08-04), branch `feat/llm-token-streaming`**: `LLMProvider` gained an optional `chatStream(params, onText)`, implemented for real by both built-in providers (`client.messages.stream()` for Anthropic, `stream: true` chat completions for OpenAI, accumulating fragmented tool-call deltas by index). `Agent.run()`/`resume()`/`runAgent()` take an `onText` callback and use `chatStream` when both it and the callback are present, falling back to plain `chat()` otherwise — a custom `LLMProvider` without `chatStream` still works, just without incremental events. |
| 4 | No cross-run memory / checkpointing / durable execution | 🟡 Partial | **Closed for a single `Agent`** (2026-08-04, branch `feat/agent-checkpointing`): `Agent.run(input, {runId})`/`Agent.resume(runId)` + `CheckpointStore` seam (`packages/agents/src/checkpoint.ts`), backed by a real `createSemanticFsCheckpointStore()` that persists after every turn through `apps/filesystem`'s `write_context_file`/`read_context_file`/`tag_context_file` exports. A crash mid-loop no longer loses everything — `resume()` picks the loop back up from the last saved turn. **Still open**: `Crew.sequential`/`withManager`/`networked` don't checkpoint crew-level composition state (which sub-agent ran, in what order) — only individual `Agent`s constructed with a `checkpoint` store get durable progress. Also still open: this doesn't fix gap #2 — a checkpoint preserves the turns *before* a crash, not the crashing turn itself. |
| 5 | Zero observability/tracing | 🟡 Partial | **Closed for a single `Agent`'s turns/tool-calls (2026-08-04), branch `feat/agent-tracing`**: `StepTracer` seam (`packages/agents/src/tracing.ts`) + `AgentStepEvent` (`runId, agentName, turn, kind: "llm-turn"|"tool-call", toolName?, durationMs, error?`), emitted after every LLM turn and every tool call when both `trace` and `runId` are set — same "constructor-level seam, run-level activation" shape as checkpointing. `createContextBusStepTracer()` publishes to Context Bus topic `agent.step` for live tailing, via a new `apps/filesystem` export (`publish_context_event`) — the tool-export surface Context Bus didn't have before this, unlike Semantic FS. `createSemanticFsStepTracer()` writes to `/context/agent-traces/<runId>.json` for durable replay (`readAgentTrace()` reads it back), reusing checkpointing's exact resident-app-export pattern. `createAgentTracer()` (`trace: "full"`) does both. **Still open**: no token/cost accounting — no `LLMProvider` reports usage, so it's not in the event shape. No trace-ID correlation across a `Crew` — Agent-level only, same boundary checkpointing has. No list/browse-all-traces primitive — `readAgentTrace()` needs a known `runId`. |

## Tier 2 — credibility gaps once someone reads the code

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| 6 | Multi-agent orchestration (the headline feature) has no unit tests and isn't in CI | 🟡 Partial | `Crew.withManager`/`Crew.networked` are still verified only by `crew-manager-milestone.mjs`/`crew-networked-milestone.mjs`, both requiring a live `ANTHROPIC_API_KEY` and explicitly excluded from `.github/workflows/agents-milestone.yml`. **Update (2026-08-04, gap #1's branch)**: `crew.test.ts` now exists (8 tests, no Docker/API key needed) — but for `parallel`/`loopUntil`/`route` only, using a fake `LLMProvider` the same way `agent.test.ts` does. `withManager`/`networked`/`sequential` are still untested outside the API-key-gated milestone scripts. |
| 7 | No LLM-call retry/backoff, no fallback models | 🔴 Open | Neither provider wraps its API call in retry logic for 429s/5xx/timeouts. A rate limit propagates straight out of `Agent.run()`. No primary/secondary model chain. |
| 8 | No human-in-the-loop at the agent-loop level | 🔴 Open | `Agent.run()` has no interrupt point — nothing like LangGraph's `interrupt()`/`Command(resume=...)`. The governance gate (`governance.ts`) is a fully automated, fail-open policy check, not a human approval step; grants-server is OS-level capability approval, unrelated to the reasoning loop. **Chosen replacement, not yet built**: generalize grants-server's existing approve/deny pattern from "container gets this filesystem capability" to "this agent gets to take its next action." |
| 9 | RAG/retrieval not surfaced to the agent framework | 🔴 Open | Semantic FS (real hybrid keyword+embedding search) exists at the OS layer but nothing in `packages/agents/src` references it as a retriever `Tool`. The checkpointing work (#4) is the first thing in `@berth/agents` to actually call into Semantic FS at all — but only for exact-path save/load, not query-based retrieval. No vector-DB integration (Pinecone/Weaviate/pgvector/etc.) anywhere. |
| 10 | No structured-output enforcement/repair loop | 🔴 Open | A Zod parse failure on tool input (server-side, inside the sandboxed app) becomes a thrown error (see #2) rather than being fed back to the model to retry with corrected arguments. No `.with_structured_output()` equivalent. |

## Tier 3 — ecosystem/breadth gaps, expected but worth naming

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| 11 | ~6 first-party tool integrations vs. LangChain's hundreds | 🔴 Open | `apps/`: activity-feed, browser-native, code-editor, filesystem, github-assistant, hello-world-py, notes, terminal. No web search, no generic code-exec primitive, no Slack/Jira/DB connectors, no document loaders. Coherent with the "tools are sandboxed apps you build" thesis, but real day-one breadth gap vs. `pip install`-and-go integrations. |
| 12 | Python is not a first-class agent framework | 🔴 Open | `sdk-python` only lets you author a *tool* (resident app); there's no Python `Agent`/`Crew` at all. Also missing capability-runtime APIs, Semantic FS client, and mesh support relative to the TS SDK. Strategic mismatch given LangChain/LangGraph are Python-first. |
| 13 | No eval harness for agent quality | 🔴 Open | `berth test` only checks manifest/export shape bijection — zero LLM invocation, zero behavioral assertion. No regression suite, no LLM-as-judge scaffolding. |

## Structural (architectural tradeoff, not a code fix)

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| 14 | Docker/sandbox cold-start is a real adoption-friction cost | 🔴 Open (by design) | Every gap above assumes a booted sandbox container. Getting a "hello world" agent running requires Docker + the Landlock/context-bus/semantic-fs daemon stack, vs. `pip install langgraph` and a script. This is a genuine disadvantage for the framework-vs-framework comparison specifically — a tradeoff of the OS-first architecture, not something framework-code polish fixes. Worth being explicit about rather than silently absorbing into the other gaps. |

---

## Progress log

**2026-08-04 — Gap #5 (zero observability/tracing), partially closed.** Branch `feat/agent-tracing`, committed locally, not pushed.
- `apps/filesystem` gained `publish_context_event({topic, payload})` — a thin pass-through to the `contextBus` client it already held from publishing `fs.file_created`. This is the tool-export surface Context Bus was missing relative to Semantic FS: before this, nothing let a host process (an `Agent`, running outside the sandbox) reach the bus at all, only resident-app code via `ctx.contextBus` directly.
- New `packages/agents/src/tracing.ts`: `AgentStepEvent` (`{runId, agentName, turn, kind: "llm-turn"|"tool-call", toolName?, durationMs, error?}`) + `StepTracer` interface. `createContextBusStepTracer()` (publishes to topic `"agent.step"`), `createSemanticFsStepTracer()` (appends — read-modify-write, not true append — to `/context/agent-traces/<runId>.json`, same single-blob-per-runId shape as `CheckpointedRun`), `createAgentTracer()` (both at once), `readAgentTrace()` (reads a trace back, `[]` if none). All three resolve their required export tools off `Computer.tools` via `checkpoint.ts`'s `findExportTool` (now exported for reuse), throwing at construction, not on first `emit()`.
- `Agent` gained a `trace?: StepTracer` constructor option (parallel to `checkpoint`) and `createAgent`/`runAgent` gained `trace?: "full" | StepTracer`. `loop()` now times and emits a step around each LLM call and each tool call — only when both `trace` and `runId` are set, otherwise zero behavior change. An LLM call that throws still emits its `llm-turn` step (with the error) before rethrowing — tracing observes failures, doesn't swallow them, consistent with gap #2's tool-error handling being separate and unaffected.
- 11 new unit tests (`tracing.test.ts` ×7, `agent.test.ts` ×4), all Docker-free/API-key-free, following `checkpoint.test.ts`'s `fakeComputer`/`fakeTool` pattern. All 45 tests in `packages/agents` pass; `tsc --noEmit` clean.
- Docs: `docs/agents-reference.md` gained a "Tracing a run" section (mirroring the checkpointing section's structure) and `docs/context-bus-reference.md` gained a "Publishing from outside the sandbox" section explaining the new export.
- Explicitly still open: no token/cost accounting (no `LLMProvider` in this package reports usage — didn't fabricate a field nothing populates), no cross-`Crew` trace-ID correlation (Agent-level only, same boundary as checkpointing), no way to list/browse every trace ever recorded (only look up a known `runId`).

**2026-08-04 — Gap #1 (no state-graph/node-edge orchestration model), partially closed.** Branch `feat/crew-composable-functions`, committed locally, not pushed.
- `Crew.parallel(agents, {merge?})` (`crew.ts`): runs every agent against the same input via `Promise.all`, then combines with `merge` (defaulting to a `## <name>` heading join) — the fan-out-then-merge shape none of the original three could express.
- `Crew.loopUntil({agent, until, maxIterations?})`: repeatedly runs one agent, piping its own output back in as the next input, checking `until(result, iteration)` after each run; stops on the first `true` or after `maxIterations` (default 10) — the cycle.
- `Crew.route({router, routes, fallback?})`: asks `router` to classify the input as one of `routes`'s keys, then runs only that branch's agent against the *original* input (not the classification prompt); `fallback` or a thrown error (naming the router's actual answer) when nothing matches — the conditional branch.
- All three are the same "just wiring over `Agent`" pattern as `sequential`/`withManager`/`networked` — no new execution primitive, no graph.
- 8 new unit tests (`crew.test.ts`, the first tests `Crew` has ever had — see gap #6) covering default/custom merge, loop-until-satisfied, loop-hits-maxIterations, route-dispatches, route-falls-back, route-throws-naming-the-answer. All 34 tests in `packages/agents` pass; `tsc --noEmit` (the package's lint) is clean.
- Docs: `docs/agents-reference.md` gained a "Composable `Crew` functions" subsection under "Agent and Crew".
- Explicitly still open: no explicit shared-state object threaded across steps — every function here only ever passes a `string`, so a LangGraph `StateGraph`'s typed accumulating state has no equivalent yet. Crew-level composition state still isn't checkpointed (same boundary gap #4 already called out for the original three).

**2026-08-04 — Gap #3 (no token-level streaming), closed.** Branch `feat/llm-token-streaming`, committed locally, not pushed.
- `LLMProvider.chatStream?(params, onText)` (`types.ts`): same request/response shape as `chat()`, but calls `onText(delta)` per chunk of assistant text before resolving with the same `LLMTurn`.
- `createAnthropicProvider()` implements it with `client.messages.stream()` + `.on("text", ...)`, resolving via `.finalMessage()`. `createOpenAIProvider()` implements it with `stream: true` chat completions, accumulating `delta.tool_calls[].index`-keyed fragments (id/name/arguments each arrive split across chunks) into complete tool calls once the stream ends.
- `Agent.run(input, {onText})` / `Agent.resume(runId, {onText})` / `runAgent({onText})`: the tool-use loop calls `chatStream` instead of `chat` only when both `onText` and `llm.chatStream` are present, per turn. No `onText`, or a provider without `chatStream` (any custom `LLMProvider`) → identical behavior to before, silently.
- 4 new unit tests in `agent.test.ts` using a fake provider with a scripted `chatStream`, covering: deltas arrive and the final text still matches; `chatStream` is never called without `onText`; `onText` without `chatStream` degrades to `chat()` instead of throwing; `resume()` streams the remaining turns after a checkpointed crash.
- Docs: `docs/agents-reference.md`'s "bring-your-own-LLM seam" section gained the `chatStream` signature and an example.
- Explicitly still open: streaming is per-turn text only — tool-call arguments aren't streamed (only assembled complete at turn end), and this doesn't touch `Crew`'s composition layer, same scope boundary as the checkpointing work.

**2026-08-04 — Gap #2 (tool-call errors kill the run), closed.** Branch `fix/agent-tool-error-handling`.
- `Agent.run()`'s tool loop (`agent.ts`) wraps `tool.invoke()` in try/catch; a thrown error becomes `{ error: <message> }` fed back as that call's tool result, same as the pre-existing "no such tool" case.
- New test in `agent.test.ts`: a throwing tool doesn't end the run, the model gets a second turn and can recover.
- Docs: `docs/agents-reference.md` gained a short note under "Agent and Crew", and the checkpointing section's "doesn't fix" callout for this gap was removed since it's now fixed.
- Explicitly still open: a hard process crash *during* `tool.invoke()` (not a thrown JS error) still loses that turn — only the checkpoint from before it started is recoverable.

**2026-08-04 — Gap #4 (state/checkpointing), Agent-level, closed.** Branch `feat/agent-checkpointing`, committed locally, not pushed.
- `apps/filesystem` gained `read_context_file` (mirrors `read_file`, scoped to `/context`) — `query_context` is fuzzy search, not a fit for an exact-path checkpoint load.
- New `packages/agents/src/checkpoint.ts`: `CheckpointStore` interface + `createSemanticFsCheckpointStore(computer)`, resolving `write_context_file`/`read_context_file`/`tag_context_file` off `Computer.tools` by suffix match (handles namespaced multi-app tool names), throwing immediately at construction if a Computer lacks them.
- `Agent` gained `resume(runId)` and `run(input, {runId})`, refactored around a shared `loop()`. Checkpoint status is `"running"|"done"|"error"`. Fully backward compatible — no `checkpoint`/`runId` means the old behavior, unchanged.
- `createAgent`/`runAgent` gained `checkpoint?: "semantic-fs" | CheckpointStore` and `runId?: string`.
- 12 new unit tests (`checkpoint.test.ts` ×5, `agent.test.ts` ×7 — the first unit tests `Agent` has ever had), all Docker-free/API-key-free. All 22 tests in the package pass.
- Docs: `docs/agents-reference.md` (new "Checkpointing and resuming a run" section) and `docs/semantic-fs-reference.md` updated.
- Explicitly still open, called out in the docs themselves: gap #2 (tool-error handling) is unrelated and unfixed; Crew-level composition state is out of scope for this piece.
