# `simple-agent`

Boot a sandbox from a resident app and let an LLM agent use it. This example boots [`apps/filesystem`](../../../apps/filesystem), turns its exports (`write_file`, `read_file` and the rest) into tools, and asks the agent to write a file and read it back. It is the agent-side counterpart to the [`hello-world`](../../resident-apps/hello-world) resident app.

It uses the experimental agent framework, `@berthos/agents`, which isn't published. Run it from a clone.

## Run it

Needs Docker, and `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Without a key the script prints `SKIP` and exits cleanly.

```bash
pnpm install && pnpm build            # once, from the repo root
cd examples/agents/simple-agent
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

On a machine whose kernel can't enforce (Docker Desktop on macOS or Windows), the boot is refused. Prefix the command with `BERTH_ALLOW_UNENFORCED=1` to run it unenforced, or see [enforcement by platform](../../../docs/kernel-enforcement.md#kernel-enforcement-by-platform).

The script prints what the agent said and the tools it called.

## Two scripts

- **`index.mjs`** is the shortest form: `runAgent({ apps, task })` with no `llm` passed. It picks up whichever of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, boots, runs one task and cleans up.
- **`index-manual.mjs`** is the fuller form: an explicit `LLMProvider`, and `Agent` and `Computer` handles you keep for more than one turn. It also accepts `--connect=<name>` to attach to a running `berth os up` instance.

## Skip the boot on every run

Building the image and starting the container on every run adds seconds. Boot once with `berth os up`, then reconnect:

```bash
# from the repo root
berth os up my-agent --apps=apps/filesystem

cd examples/agents/simple-agent
node index-manual.mjs --connect=my-agent   # reconnects in milliseconds

berth os down my-agent                     # from the repo root, when you're done
```

See the [Berth OS reference](../../../docs/berth-os-reference.md).

## Multi-agent crews

For `Crew.withManager()` and `Crew.networked()`, see [`experimental/agents/examples`](../../../experimental/agents/examples) and the [agents reference](../../../docs/agents-reference.md).
