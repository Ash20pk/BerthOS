# `@berthos/agents` examples

Three runnable scripts that show `Computer`, then `Agent`, then `Crew`. Each prints what it does and what came back.

## Run them

You need a running Docker daemon (every example boots a real container) and `OPENAI_API_KEY` (the examples use `createOpenAIProvider()`, which defaults to `gpt-4o`). Without the key, each example prints `SKIP` and exits cleanly.

```bash
pnpm install && pnpm build        # from the repo root
cd experimental/agents
export OPENAI_API_KEY=sk-...

node examples/single-agent.mjs
node examples/manager-crew.mjs
node examples/networked-crew.mjs
```

## What each one shows

Read them in order; each adds one idea.

- **`single-agent.mjs`**: `createAgent()` boots a `Computer` from `apps/filesystem` and returns an `Agent` whose tools are that app's exports.
- **`manager-crew.mjs`**: one `Computer` with `apps/filesystem` and `apps/notes`, one worker `Agent` per app, and a manager that delegates to them with `Crew.withManager()` (each worker becomes a tool via `Agent.asTool()`).
- **`networked-crew.mjs`**: the same delegation, but each worker runs its own agent loop in its own `Computer`, booted with `bootNetworkedAgent()` on a shared Docker network and reached through `Crew.networked()`.

Full API: [agents reference](../../../docs/agents-reference.md).
