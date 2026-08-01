# `@berth/agent-runtime` examples

Runnable, narrative demonstrations of `Computer` -> `Agent` -> `Crew`. These
print what they're doing and what came back — for hard-assertion
verification of the same code paths, see `../test/*-milestone.mjs` instead
(those are wired into CI where they don't need external credentials).

## Prerequisites

```bash
pnpm install
pnpm build          # from the repo root, or `pnpm --filter @berth/agent-runtime... build`
```

A local Docker daemon must be running — every example boots at least one
real `Computer` (a real container, not a mock).

All three examples need `ANTHROPIC_API_KEY` in the environment (they drive
`createAnthropicProvider()`); each prints `SKIP` and exits cleanly if it's
unset, rather than failing.

## Running

```bash
cd packages/agent-runtime
export ANTHROPIC_API_KEY=sk-...

node examples/single-agent.mjs      # one Computer (apps/filesystem), one Agent
node examples/manager-crew.mjs      # one Computer, two apps, Crew.withManager() delegates in-process
node examples/networked-crew.mjs    # two independent Computers, Crew.networked() delegates across them
```

Read them in that order — each introduces one new idea on top of the last:

- **`single-agent.mjs`** — the one-call entry point, `createAgent()`: boot a
  `Computer` from a resident app directory, get back an `Agent` whose tools
  are that app's exports.
- **`manager-crew.mjs`** — one `Computer` loaded with two resident apps
  (`apps/filesystem` + `examples/notes`), one worker `Agent` per app, and a
  manager `Agent` that delegates via `Crew.withManager()` — the
  "agent-as-tool" pattern (`Agent.asTool()`).
- **`networked-crew.mjs`** — the same delegation shape, but each worker is a
  genuinely independent `Computer` (its own container, its own in-container
  agent loop via `bootNetworkedAgent()`), joined on a shared Docker network
  and reachable through `Crew.networked()`.

See [`docs/agent-runtime-reference.md`](../../../docs/agent-runtime-reference.md)
for the full API reference and what's real vs. deferred about the networked
pattern.
