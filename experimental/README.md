# `experimental/`

This directory holds Berth's agent framework: code that drives an LLM against the sandbox, rather than the sandbox itself. The sandbox (the `berth.yml` manifest, the kernel policy compiled from it, the apps that run under it, and the evidence that it held) lives in `packages/`, `apps/`, `spec/` and `bench/`.

| Package | What it is |
|---|---|
| [`agents`](./agents/README.md) | `@berthos/agents`: `Computer`, `Agent`, `Crew`, LLM providers, sessions, guardrails, tracing, an MCP client, A2A and evals |
| [`agents-python`](./agents-python/README.md) | `berthos-agents`: the Python `Agent` and `Crew`, which connect to a running sandbox |
| `seam-claude-agent-sdk`, `seam-openai-agents` | Adapters that hand Berth tools to the Claude Agent SDK and the OpenAI Agents SDK |

Everything here is built and tested with the rest of the repo, and it is frozen: bug and security fixes only, no new features ([why](../CONTRIBUTING.md#the-agents-packages-are-frozen)).

None of it is published to npm or PyPI. Releases ship the sandbox only. Use these packages from a clone of this repo. The CLI commands built on the framework (`berth agent run`, `berth crew run`, `berth eval`) work from a clone too; an installed `@berthos/cli` tells you so instead of running them.

To put your own agent on top of Berth without this framework, use `berth mcp`, the `toAiSdkTools` / `toLangChainTools` adapters, or the HTTP RPC bridge.
