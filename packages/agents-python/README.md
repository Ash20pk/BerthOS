# berth-agents

The Python half of [Berth](https://github.com/Ash20pk/BerthOS)'s agent framework: a provider-agnostic `Agent` tool-use loop and six `Crew` composition shapes, mirroring `@berth/agents` (the TypeScript package) field-for-field.

```bash
pip install berth-agents
```

```python
from berth_agents import Agent, create_anthropic_provider

agent = Agent(llm=create_anthropic_provider(), tools=[])
result = await agent.run("say hello")
print(result.text)
```

## What's in the box

- **`Agent`** — the tool-use loop: checkpointed resume, token-level streaming, `response_schema` structured-output repair, and `StepTracer`-based tracing (Context Bus/Semantic FS backends are TypeScript-only; an [OpenTelemetry](https://opentelemetry.io) backend — `create_otel_step_tracer()` — ships here too, so any OTel-compatible backend picks up real spans for free).
- **Six built-in `LLMProvider`s** — Anthropic, OpenAI, Google/Gemini (incl. Vertex AI), Azure OpenAI, Amazon Bedrock, and Ollama — plus `create_fallback_provider()` for retry-through-a-chain, and a plain `Protocol` if you want to bring your own.
- **`Crew`** — `sequential`, `with_manager`, `parallel`, `loop_until`, `route`, and `pipeline` composition shapes over any set of `Agent`s.
- **`create_mcp_client_tools()`** — consume any external [MCP](https://modelcontextprotocol.io) server's tools (stdio or Streamable HTTP) as ordinary `Tool`s, mixed in alongside anything else.
- **`Computer.connect(name)`** — attach to an already-running `berth os up --http-rpc` sandbox instance and use its resident apps' exports as real `Tool`s, no Docker API access needed from Python.

## What this package deliberately doesn't do

This is the Python *agent loop*, not a Python port of Berth's sandbox orchestration. There's no `Computer.boot()` (sandbox *creation*) from Python — only `connect()` to an instance something else already started — and no `Crew.networked` (which needs that same creation capability). See [`docs/agents-python-reference.md`](https://github.com/Ash20pk/BerthOS/blob/main/docs/agents-python-reference.md) in the main repo for the full, current scope, including exactly what's ported vs. still TypeScript-only.

## Docs and source

The real documentation lives in the main [BerthOS](https://github.com/Ash20pk/BerthOS) repository:

- [`docs/agents-python-reference.md`](https://github.com/Ash20pk/BerthOS/blob/main/docs/agents-python-reference.md) — this package's full reference
- [`docs/agents-reference.md`](https://github.com/Ash20pk/BerthOS/blob/main/docs/agents-reference.md) — the TypeScript sibling this mirrors
- [`packages/agents-python/`](https://github.com/Ash20pk/BerthOS/tree/main/packages/agents-python) — source and tests

## License

Apache-2.0. See [LICENSE](https://github.com/Ash20pk/BerthOS/blob/main/LICENSE).
