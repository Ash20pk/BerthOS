# Python agent runtime reference (Slice 1 — core)

`packages/agents-python` (`berth_agents` on PyPI-style import) is a real second-language `Agent`/`Crew` — not a stub, not a design doc. Before this package existed, `packages/sdk-python` only let you author a *tool* (a resident app); there was no way to write an agent loop in Python at all, a real strategic mismatch given LangChain/LangGraph are Python-first. This closes that gap for a first, deliberately minimal slice: the provider-agnostic tool-use loop and the simplest multi-agent composition, mirroring the *core* of [`@berth/agents`](./agents-reference.md) — not its Docker/`Computer` boot glue or any of the enhancements documented there (checkpointing, tracing, streaming, structured-output repair, human approval, retrieval, retry/fallback, evals). Those are real gaps still open for Python; see "What's deliberately out of this slice" below.

## What's reused vs. rewritten

Same reasoning `docs/sdk-python-reference.md` used for the resident-app SDK, applied to the agent loop instead of the RPC wire protocol: `Agent`'s tool-use loop is a plain in-process algorithm with no TypeScript-specific runtime behavior (no Node APIs, no `zod`), so it's a direct algorithmic port — same field names (snake_case instead of camelCase), same control flow — rather than an "idiomatic Python equivalent" that happens to behave differently at the edges.

- **`berth_agents/types.py`** — `Tool`/`LLMProvider` `Protocol`s (structural typing — nothing needs to inherit from them, matching TypeScript's structural interfaces) and `AgentMessage`/`LLMTurn`/`AgentRunResult`/`ToolCall`/`ToolResult` dataclasses, field-for-field identical to `@berth/agents`' `types.ts`.
- **`berth_agents/agent.py`** — `Agent.run(input) -> AgentRunResult`: seeds a `user` message, loops the LLM call, and on tool calls, invokes each by name (a missing tool or a tool that raises both feed an `{"error": ...}` result back to the model as that call's result instead of ending the run — the exact behavior `agent.ts`'s gap-#2 fix added) until a turn has no pending tool calls or `max_turns` (default 25) is hit. `with_tools()`/`as_tool()` port the same "extend without mutating" and "wrap an Agent as a Tool for delegation" helpers.
- **`berth_agents/crew.py`** — `Crew.sequential(agents)`: pipes each agent's output text as the next agent's input, returns the last agent's output (or the input unchanged, for an empty list).
- **`berth_agents/providers/anthropic.py`** — `create_anthropic_provider(api_key=None, base_url=None, model=None, max_tokens=None, max_retries=None)`, a thin adapter over the `anthropic` package's async Messages API. Maps `AgentMessage` the same way `anthropic.ts` does: `user` → plain string content; `tool` → a `tool_result` content block keyed by `tool_result.id`, with the output JSON-encoded; `assistant` → an optional `text` block followed by one `tool_use` block per call. Default model `claude-sonnet-5`, default `max_tokens` 4096 — same defaults as the TypeScript provider.

## What's deliberately out of this slice

- **`Computer`/Docker boot glue** (`createAgent`/`runAgent` in the TypeScript package). This slice's `Agent` only ever needs an `LLMProvider` and a plain list of `Tool`s — nothing here boots a container or resolves resident-app exports into tools. Wiring a Python `Agent` up to real Berth resident-app tools (over the same RPC protocol `berth_sdk` already speaks) is future work, not attempted here.
- **`Crew.parallel`/`loop_until`/`route`/`with_manager`/`networked`.** Only `sequential` is ported — the other five `Crew` shapes `crew.ts` has (see [Composable `Crew` functions](./agents-reference.md#composable-crew-functions-cycles-fan-out-and-branching-without-a-graph-dsl)) aren't yet.
- **Checkpointing, tracing, token-level streaming, structured-output repair, human-in-the-loop approval, retrieval, retry/fallback provider chains, the eval harness.** Every one of these is a real, separately-documented piece of `@berth/agents` (see `docs/agents-reference.md`) with no Python equivalent yet. Each is realistically its own follow-up slice, the same way the Python resident-app SDK's context-bus client landed as a second slice after its wire-protocol core.
- **`openai`/other providers.** Only Anthropic is ported; `@berth/agents`' `createOpenAIProvider()`/`createFallbackProvider()` have no Python equivalent.
- **A packaged, pip-installable distribution.** Same as `packages/sdk-python`: no `sdist`/`wheel` publishing step — install in dev mode (`pip install -e packages/agents-python[dev]`) same as this reference's own test setup.

## Testing

`packages/agents-python/tests/` uses `pytest` + `pytest-asyncio` (`asyncio_mode = "auto"` in `pyproject.toml`, so `async def test_...` runs without per-test markers). `test_agent.py`/`test_crew.py` follow `agent.test.ts`'s fake-provider pattern directly: a `ScriptedLLM` that pops a queued `LLMTurn` per `chat()` call, plain `EchoTool`/`ThrowingTool` fakes — no real API key or network access needed. Run from the package directory:

```
cd packages/agents-python
pip install -e ".[dev]"
pytest
```

This also runs in CI as a step in `build-lint-test.yml`, alongside the existing `pnpm test` — same "fast, no Docker" posture, just a second language `turbo` doesn't orchestrate.

The Anthropic provider's message-mapping and its real `messages.create()` request/response parsing were both verified against the actual `anthropic` package (a mocked HTTP transport standing in for the network call, so no real API key is needed) during development, but that check isn't part of the committed test suite — `providers/anthropic.ts` has no unit tests in the TypeScript package either, so this mirrors that posture rather than adding one-off extra coverage.
