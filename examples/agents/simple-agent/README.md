# `simple-agent` example

The agent-side counterpart to [`../../resident-apps/hello-world`](../../resident-apps/hello-world)
(a resident app example): this one boots a `Computer` from a resident app and drives it
with an `Agent`, using `@berth/agents` as an ordinary installed dependency —
see `package.json`'s `"@berth/agents": "workspace:*"` and `index.mjs`'s
`import ... from "@berth/agents"`. That's the same shape an external project
would use once `@berth/agents` is published; nothing here reaches into this
monorepo's source or build output by relative path.

Two scripts, two levels of the API:

- **`index.mjs`** — the dead-simple form: `runAgent({ apps, task })`, no
  `llm` passed at all. `createAgent()`/`runAgent()` auto-detect whichever of
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set, so this is the whole thing —
  boot, run one task, clean up.
- **`index-manual.mjs`** — the fuller form: an explicit `LLMProvider`, and
  the `Agent`/`Computer` handles kept around for more than one turn, calling
  tools directly, or snapshotting before stopping. Also shows `--connect=<name>`
  — attach to an already-running `berth os up <name>` instance instead of
  booting a fresh one (see "Cold start" below).

## Prerequisites

```bash
pnpm install
pnpm build          # from the repo root — builds @berth/agents and its deps
```

A local Docker daemon must be running (this example boots a real container,
not a mock), and either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` must be set —
the script prints `SKIP` and exits cleanly if neither is, rather than failing.

## Running

```bash
cd examples/agents/simple-agent
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

This boots `apps/filesystem` as the resident app, wires its exports
(`write_file`, `read_file`, ...) up as tools, and asks the agent to write and
then read back a file.

## Cold start: skip the boot on every run

Booting a fresh Computer (image build + container start) on every single run
of this script is real seconds of latency you don't want to pay while
iterating. Boot once with `berth os up`, then reconnect instantly:

```bash
# from the repo root
berth os up my-agent --apps=apps/filesystem

cd examples/agents/simple-agent
node index-manual.mjs --connect=my-agent   # reconnects in milliseconds, no build/boot

berth os down my-agent                     # from the repo root, when you're done
```

See [`docs/berth-os-reference.md`](../../../docs/berth-os-reference.md).

## Multi-agent composition

For `Crew.withManager()`/`Crew.networked()`, see
[`packages/agents/examples`](../../../packages/agents/examples) and
[`docs/agents-reference.md`](../../../docs/agents-reference.md).
