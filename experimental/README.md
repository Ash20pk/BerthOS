# `experimental/` — the agent framework, frozen

Everything in this directory works, is tested, and still runs in CI. It is here
because it is **not part of the sandbox**, not because it is broken.

The product is the sandbox: a `berth.yml` capability manifest compiled into a
kernel-enforced Landlock/seccomp policy applied before an app's first line
runs, the headless apps that run under it, the places it can be deployed, and
the evidence that enforcement happened. That is `packages/`, `apps/`, `spec/`
and `bench/`.

What is here drives an LLM against that sandbox:

| Package | What it is |
|---|---|
| `agents` | A full agent framework: providers, Agent, Crew, sessions, guardrails, tracing, A2A, MCP client, evals. `Computer` — boot a sandbox, get its tools — lives here too, and is what the capability demos use |
| `agents-python` | Python parity for the above |
| `seam-claude-agent-sdk`, `seam-openai-agents` | Adapters exposing Berth tools to other vendors' agent SDKs |

## What "frozen" means here

- **Still built, still linted, still tested.** These are workspace members;
  `pnpm build`, `pnpm lint` and `pnpm test` cover them exactly as before, and
  `agents-milestone.yml` still runs.
- **Bug and security fixes only.** No new Crew shapes, providers, or
  framework-parity features — see
  [CONTRIBUTING.md](../CONTRIBUTING.md#the-agents-packages-are-frozen). The
  supported way to put a richer agent loop on top of Berth is the sandbox's
  own seams: `berth mcp`, `toAiSdkTools`/`toLangChainTools`, the HTTP RPC
  bridge, or the SDK directly.
- **Not released.** These packages are private on npm and unpublished on
  PyPI; releases ship the sandbox only. They are used from a clone of this
  repository: `berth agent run`, `berth crew run` and `berth eval` load
  `@berthos/agents` on demand there, and an installed `@berthos/cli` says so
  instead of pulling in an LLM framework.

Everything else that used to sit here — the deploy adapters, the app registry,
the mesh coordinator — is back in `packages/`, because each one exists to run
or contain a sandbox. The grants server was removed.
