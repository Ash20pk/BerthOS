# Python agent reference

`berthos-agents` (imported as `berth_agents`) is the Python version of [`@berthos/agents`](./agents-reference.md): an `Agent` tool-use loop, six `Crew` composition shapes, and a `Computer.connect()` that gives an agent a running Berth sandbox's tools. Field names match the TypeScript package, in snake_case. Where TypeScript uses zod, Python uses pydantic.

This is part of the experimental agent framework in [`experimental/`](../experimental/README.md): frozen, bug and security fixes only. It isn't published to PyPI; releases ship the sandbox only. Use it from a clone of this repo.

## Install

Python 3.11 or later:

```bash
pip install -e experimental/agents-python
```

## Quick start

Start a sandbox with the HTTP RPC bridge on, then connect to it from Python:

```bash
berth os up my-agent --apps=apps/filesystem --http-rpc
```

```python
import asyncio
from berth_agents import Agent, Computer, create_anthropic_provider

async def main():
    computer = await Computer.connect("my-agent")
    agent = Agent(llm=create_anthropic_provider(), tools=computer.tools)
    result = await agent.run("read hello.txt and summarize it")
    print(result.text)

asyncio.run(main())
```

`berth os down my-agent` stops the sandbox. [Berth OS reference](./berth-os-reference.md) covers `berth os up` in full.

## Connecting to a sandbox: `Computer.connect()`

`await Computer.connect(name, os_dir=None)` reads `~/.berth/os/<name>.json` (written by `berth os up`), loads the bridge app's `berth.yml`, and returns a `ComputerHandle`:

| Member | What it does |
|---|---|
| `tools` | One `Tool` per export of the bridge app, called over `POST <url>/rpc` with the recorded bearer token |
| `await call(tool_name, input)` | Calls one tool directly |
| `await stop()` | Does nothing. The sandbox is shared and long-lived; stop it with `berth os down <name>` |

The bridge serves one app. With several apps loaded, `berth os up --http-rpc-app=<name>` picks which one (default: the first). Tool names are the export's own name (`write_file`), not namespaced.

`ComputerConnectionError` is raised when there's no state file for `name`, the sandbox was started without `--http-rpc`, or the bridge app's `berth.yml` is missing.

## `Agent`

```python
Agent(
    llm=provider,                  # required: an LLMProvider
    tools=[...],                   # required: list of Tool
    name="agent",
    system_prompt=None,
    max_turns=25,
    checkpoint=None,               # a CheckpointStore
    trace=None,                    # a StepTracer
    input_guardrails=None,         # list of Guardrail
    output_guardrails=None,
)
```

| Method | What it does |
|---|---|
| `await run(input, *, run_id=None, on_text=None, response_schema=None, max_repair_attempts=2, session=None)` | Runs the tool-use loop until the model gives a final answer. Returns `AgentRunResult(text, tool_calls)` |
| `await resume(run_id, *, on_text=None, response_schema=None, max_repair_attempts=2)` | Continues a checkpointed run that didn't finish. Needs `checkpoint` on the constructor. A run already marked `done` returns its saved answer |
| `with_tools(extra_tools)` | Returns a new `Agent` with the same settings and more tools |
| `as_tool(description)` | Wraps the agent as a `Tool` taking `{"task": str}`, for delegation |

- `on_text` receives text as it streams, when the provider has `chat_stream`. Other providers still work, without incremental text.
- A tool that raises, or a tool name the agent doesn't have, goes back to the model as an `{"error": ...}` tool result instead of ending the run. A pydantic `ValidationError` from a tool is reformatted into a short per-field message (`format_tool_input_error()`).
- A run that passes `max_turns` without a final answer raises `RuntimeError`.

A `Tool` is any object with `name`, `description`, `input_schema` (JSON Schema) and `async invoke(input)`. An `LLMProvider` is any object with `name` and `async chat(*, system, messages, tools) -> LLMTurn`, plus an optional `chat_stream(..., on_text)`.

## Providers

| Factory | Arguments | Default model | Reads from the environment |
|---|---|---|---|
| `create_anthropic_provider()` | `api_key`, `base_url`, `model`, `max_tokens` (4096), `max_retries` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| `create_openai_provider()` | `api_key`, `base_url`, `model`, `max_retries` | `gpt-4o` | `OPENAI_API_KEY` |
| `create_google_provider()` | `api_key`, `vertexai=False`, `project`, `location`, `model` | `gemini-2.5-flash` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| `create_azure_openai_provider()` | `api_key`, `endpoint`, `deployment` (required), `api_version` (`2024-10-21`) | the deployment | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |
| `create_bedrock_provider()` | `api_key`, `aws_region`, `base_url`, `model` | `anthropic.claude-sonnet-5` | the `openai` package's Bedrock client settings |
| `create_ollama_provider()` | `base_url` (`http://127.0.0.1:11434/v1`), `model` | `llama3.1` | none |

With `vertexai=True`, the Google provider uses Vertex AI with Application Default Credentials instead of an API key.

- **`create_fallback_provider(providers, on_fallback=None)`** tries each provider in order and moves to the next on any exception; the last one's error propagates unchanged. It streams only if every provider in the chain can. Use it for a provider outage; each provider already retries single failed calls through its SDK client.
- **`detect_llm_provider()`** picks a provider from whichever key is set: `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`, then `GOOGLE_API_KEY` / `GEMINI_API_KEY`. Azure, Bedrock and Ollama are never auto-detected.
- **`resolve_llm_provider(llm)`** passes a provider through, builds one from an `LLMProviderConfig(provider, api_key=None, base_url=None, model=None)` (`provider` is `"anthropic"`, `"openai"`, `"google"` or `"ollama"`), or auto-detects when `llm` is `None`.

## `Crew`

Each shape returns an object with `await run(input)`. `pipeline` takes and returns a dict.

| Shape | What it does |
|---|---|
| `Crew.sequential(agents, *, checkpoint, run_id, response_schema, max_repair_attempts)` | Pipes each agent's output into the next; returns the last one's |
| `Crew.with_manager(*, manager, workers, run_id)` | Gives the manager one tool per worker (via `as_tool`) and lets it delegate |
| `Crew.parallel(agents, *, merge, run_id)` | Runs every agent on the same input at once. The default `merge` puts each output under a `## <name>` heading |
| `Crew.loop_until(*, agent, until, max_iterations=10, checkpoint, run_id)` | Feeds the agent its own output until `until(result, iteration)` returns `True` |
| `Crew.route(*, router, routes, fallback, run_id, response_schema, max_repair_attempts)` | Asks `router` to pick one key of `routes`, then runs that agent on the original input. With no match and no `fallback`, it raises |
| `Crew.pipeline(steps, *, checkpoint, run_id)` | Calls each `step(state, run_id)` in order, shallow-merging each returned dict into a shared state dict. Steps can be sync or async |

## Checkpointing

Pass a `CheckpointStore` as `checkpoint=` and a `run_id` to `run()`. The run is saved after every turn, and `resume(run_id)` continues it from another process. Without a `run_id`, nothing is saved.

`FileCheckpointStore(directory)` writes one `<directory>/<run_id>.json` per run. A store is anything with `async save(checkpoint)` and `async load(run_id)`.

For `Crew` checkpoints (`sequential`, `loop_until`, `pipeline`), use the same store with the crew's record type:

```python
import dataclasses
from berth_agents import CheckpointedCrewRun, FileCheckpointStore

store = FileCheckpointStore(
    "checkpoints",
    to_dict=dataclasses.asdict,
    from_dict=lambda d: CheckpointedCrewRun(**d),
)
```

A crew saves under `checkpoint_key_for(run_id)` (`crew__<run_id>`), so it doesn't collide with its agents' own checkpoints.

## Structured output

Pass a pydantic model as `response_schema=` and the final answer is validated as JSON against it. On a failure the model is asked to fix its answer, up to `max_repair_attempts` times (default 2); after that, `StructuredOutputError` is raised. `result.text` holds the valid JSON.

`parse_structured_output(text, schema)` returns `(success, data, error)` if you want to validate text yourself.

## Guardrails

Guardrails check the agent's own input and final answer, not its tool calls.

```python
from berth_agents import Agent, create_keyword_guardrail, create_regex_guardrail, create_llm_guardrail

agent = Agent(
    llm=llm,
    tools=tools,
    input_guardrails=[create_keyword_guardrail(["password"])],
    output_guardrails=[create_llm_guardrail(judge=llm, rubric="No personal data.")],
)
```

- A guardrail is a function `(text) -> GuardrailResult(tripwire_triggered, message=None)`, sync or async.
- Built in: `create_keyword_guardrail(words, case_sensitive=False)`, `create_regex_guardrail(pattern, message=None)`, `create_llm_guardrail(judge=, rubric=)`. The LLM guardrail counts an unparseable judge answer as tripped.
- A tripped guardrail raises `GuardrailTripwireError(stage, guardrail_message)`. Input guardrails run before the first model call, on `run()` only. Output guardrails run on every final answer, including after `resume()`, and mark the checkpoint `error`.

## Sessions

A session carries conversation history across separate `run()` calls. Pass `session=` to `run()`: its items are loaded before the new input, and the new messages are added after a successful answer (not when an output guardrail trips).

| Backend | Where it stores history |
|---|---|
| `create_in_memory_session(initial=None)` | In memory, gone when the process exits |
| `create_semantic_fs_session(computer, session_id)` | `/context/agent-sessions/<session_id>.json` in the sandbox, through the `write_context_file`, `read_context_file` and `tag_context_file` exports (`apps/filesystem` has them). Fails at construction if they're missing |

A `Session` is anything with `async get_items()`, `async add_items(items)` and `async clear()`.

## Tracing

Pass a `StepTracer` as `trace=` and a `run_id` to `run()`. The agent emits one `AgentStepEvent` per model call (`kind="llm-turn"`, with `usage` when the provider reports it) and one per tool call (`kind="tool-call"`, with `tool_name`). Both carry `run_id`, `agent_name`, `turn`, `duration_ms`, and `error` when the step raised. Without a `run_id`, nothing is emitted.

`create_otel_step_tracer(tracer_name="berth_agents")` turns events into OpenTelemetry spans named `chat <agent>` or `execute_tool <tool>`, with the GenAI attributes (`gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.tool.name`, `gen_ai.usage.input_tokens` / `output_tokens`) plus `berth.run_id` and `berth.turn`. It uses `opentelemetry-api`'s global tracer, so you must register an `opentelemetry-sdk` tracer provider and exporter yourself; without one, spans go nowhere.

## External MCP servers: `create_mcp_client_tools()`

```python
from berth_agents import create_mcp_client_tools

mcp = await create_mcp_client_tools(command="python", args=["my_mcp_server.py"])
# or: await create_mcp_client_tools(url="https://example.com/mcp", headers={"Authorization": "Bearer ..."})
agent = Agent(llm=llm, tools=[*computer.tools, *mcp.tools])
...
await mcp.close()
```

Pass `command=` / `args=` / `env=` for a local server over stdio, or `url=` / `headers=` for a remote one over Streamable HTTP, not both. A tool returns the result's structured content when present, otherwise its text (or the raw content list if it isn't all text). A result the server marks as an error raises `RuntimeError`, which the agent sees as a tool error. MCP tools are trusted as much as any other `Tool`; authentication beyond `headers` / `env` needs your own transport.

## Testing

```bash
cd experimental/agents-python
pip install -e ".[dev]"
pytest
```

The tests use fake providers and a local fake RPC server, so they need no API key, network or Docker.

## Limits

- **No sandbox creation from Python.** There's no `Computer.boot()`; start a sandbox with `berth os up --http-rpc` and connect to it.
- **One app per connection.** `Computer.connect()` only sees the app the HTTP bridge serves. Other apps in the same sandbox aren't in `computer.tools`.
- **No governance gate in the Python agent.** A `governs: true` app's `evaluate_action` still checks calls that arrive over the HTTP bridge, inside the sandbox, but the Python `Agent` doesn't gate calls itself the way the TypeScript `Computer` does. See the [governance reference](./governance-reference.md).
- **TypeScript-only features:** `Crew.networked`, serving an agent over HTTP (`serveAgent()`), YAML-declared agents (`createAgentFromYaml()`), A2A, retrieval, evals, the Semantic FS checkpoint store, and the Context Bus and Semantic FS tracers.
