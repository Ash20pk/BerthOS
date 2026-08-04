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
| 1 | No state-graph/node-edge orchestration model | 🔴 Open | `Crew` (`packages/agents/src/crew.ts`) is 3 fixed shapes: `sequential`, `withManager`, `networked`. No cycles, no conditional branching, no explicit shared-state object, no parallel-then-merge. Anything beyond a linear pipe or manager-delegates-to-fixed-workers has to be hand-coded in raw TypeScript. **Chosen replacement, not yet built**: composable `Crew` functions (`parallel`/`loopUntil`/`route`) instead of a graph — stays consistent with the repo's existing "Crew is not a new execution primitive" stance. |
| 2 | Tool-call errors kill the entire agent run | 🟢 Closed | **Closed (2026-08-04), branch `fix/agent-tool-error-handling`**: `Agent.run()`'s tool loop (`agent.ts`) now wraps `tool.invoke()` in try/catch and feeds `{ error: <message> }` back to the model as that call's tool result — same pattern the existing "no such tool" case already used. The model gets a chance to retry, try another tool, or explain the failure, instead of the run throwing straight out. |
| 3 | No token-level streaming | 🔴 Open | Both LLM providers (`anthropic.ts`, `openai.ts`) call `.create()` without `stream: true` and await the full response. No SSE, no partial-token callback. Any chat-UI use case is a non-starter as-is. |
| 4 | No cross-run memory / checkpointing / durable execution | 🟡 Partial | **Closed for a single `Agent`** (2026-08-04, branch `feat/agent-checkpointing`): `Agent.run(input, {runId})`/`Agent.resume(runId)` + `CheckpointStore` seam (`packages/agents/src/checkpoint.ts`), backed by a real `createSemanticFsCheckpointStore()` that persists after every turn through `apps/filesystem`'s `write_context_file`/`read_context_file`/`tag_context_file` exports. A crash mid-loop no longer loses everything — `resume()` picks the loop back up from the last saved turn. **Still open**: `Crew.sequential`/`withManager`/`networked` don't checkpoint crew-level composition state (which sub-agent ran, in what order) — only individual `Agent`s constructed with a `checkpoint` store get durable progress. Also still open: this doesn't fix gap #2 — a checkpoint preserves the turns *before* a crash, not the crashing turn itself. |
| 5 | Zero observability/tracing | 🔴 Open | No structured logging of reasoning steps, no token/cost accounting, no trace IDs, no replay debugging — nothing comparable to LangSmith. **Chosen replacement, not yet built**: a standardized `agent.step` event (turn, tool, tokens, duration, error) published on the Context Bus for live tailing, and written to Semantic FS tagged by run-id for durable replay after the fact (Context Bus itself is ephemeral pub/sub, so the FS is what makes traces queryable later). |

## Tier 2 — credibility gaps once someone reads the code

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| 6 | Multi-agent orchestration (the headline feature) has no unit tests and isn't in CI | 🔴 Open | `Crew.withManager`/`Crew.networked` are verified only by `crew-manager-milestone.mjs`/`crew-networked-milestone.mjs`, both requiring a live `ANTHROPIC_API_KEY` and explicitly excluded from `.github/workflows/agents-milestone.yml`. Note: the checkpointing work (#4) added the *first* unit tests `Agent` has ever had (`agent.test.ts`, 7 tests, no Docker/API key needed) — same pattern could extend to `Crew`, but `Crew` itself still has zero. |
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
