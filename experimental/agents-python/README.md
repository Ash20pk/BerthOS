# berthos-agents

The Python side of Berth's agent framework: an `Agent` tool-use loop that works with any LLM provider, and `Crew` shapes for composing several agents. It mirrors [`@berthos/agents`](https://github.com/Ash20pk/BerthOS/tree/main/experimental/agents) field for field, in snake_case. The import name is `berth_agents`.

Experimental and frozen: bug and security fixes only. It isn't published to PyPI; releases ship the sandbox only. Install it from a clone of the [Berth repo](https://github.com/Ash20pk/BerthOS):

```bash
pip install -e experimental/agents-python
```

```python
import asyncio
from berth_agents import Agent, Computer, create_anthropic_provider

async def main():
    # started with: berth os up my-agent --apps=apps/filesystem --http-rpc
    computer = await Computer.connect("my-agent")
    agent = Agent(llm=create_anthropic_provider(), tools=computer.tools)
    result = await agent.run("write hello.txt with the text 'hi', then read it back")
    print(result.text)

asyncio.run(main())
```

## What's in it

- **`Agent`**: the tool-use loop, with checkpoint and resume, streaming, structured-output repair, guardrails, sessions and step tracing (including an OpenTelemetry tracer).
- **Providers**: Anthropic, OpenAI, Google Gemini (and Vertex AI), Azure OpenAI, Amazon Bedrock and Ollama, plus `create_fallback_provider()` to chain them.
- **`Crew`**: `sequential`, `with_manager`, `parallel`, `loop_until`, `route` and `pipeline`.
- **`create_mcp_client_tools()`**: use any external MCP server's tools (stdio or Streamable HTTP).
- **`Computer.connect(name)`**: use a running `berth os up --http-rpc` sandbox's tools over HTTP. No Docker access needed from Python.

## Limits

- Python can't create a sandbox. There's no `Computer.boot()`; start one with `berth os up --http-rpc` and connect to it.
- `Computer.connect()` reaches one app per sandbox: the one the HTTP bridge serves.
- No `Crew.networked`, no HTTP server, no YAML-declared agents, no A2A, no retrieval or evals. Those are TypeScript-only.

Full reference: [`docs/agents-python-reference.md`](https://github.com/Ash20pk/BerthOS/blob/main/docs/agents-python-reference.md).

## License

Apache-2.0. See [LICENSE](https://github.com/Ash20pk/BerthOS/blob/main/LICENSE).
