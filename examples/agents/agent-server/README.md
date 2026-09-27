# `agent-server`

Serve an agent over HTTP. [`server.mjs`](./server.mjs) boots a sandbox with [`apps/filesystem`](../../../apps/filesystem) and an agent once at startup, then hands the agent to `serveAgent()` from `@berthos/agents`. The `/chat` endpoint speaks the Vercel AI SDK's `useChat` protocol, so you can point `useChat`'s `api` option at `http://localhost:8787/chat` with no glue code.

It uses the experimental agent framework, `@berthos/agents`, which isn't published. Run it from a clone.

## Run it

Needs Docker, and `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Without a key the script prints `SKIP` and exits cleanly.

```bash
pnpm install && pnpm build            # once, from the repo root
cd examples/agents/agent-server
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

On a machine whose kernel can't enforce (Docker Desktop on macOS or Windows), the boot is refused. Prefix the command with `BERTH_ALLOW_UNENFORCED=1` to run it unenforced.

Then call it:

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/task \
  -H 'content-type: application/json' \
  -d '{"task":"write a file called hello.txt with the text hi, then read it back"}'

curl -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"write a file called hello.txt with the text hi, then read it back"}]}]}'
```

## Endpoints

| Endpoint | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok: true, tools: string[] }` |
| `POST /task` | `{ task, runId?, sessionId? }` | `{ text, toolCalls }` |
| `POST /chat` | `{ messages: UIMessage[] }` | A `useChat`-compatible UI message stream |

Pass the same `sessionId` to `/task` to share history across requests (see Sessions in the [agents reference](../../../docs/agents-reference.md)). `/chat` doesn't need one, because `useChat` sends the full history on every request.

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `BERTH_OS_CONNECT` | unset | Attach to a running `berth os up <name>` instance instead of booting a new sandbox |

The sandbox boots once, before the server starts listening, and every request reuses it.

## Skip the boot on restart

The server still pays the build and boot cost each time it restarts. Point it at a running `berth os up` instance instead:

```bash
# from the repo root
berth os up my-agent --apps=apps/filesystem

cd examples/agents/agent-server
BERTH_OS_CONNECT=my-agent pnpm start   # connects in milliseconds

berth os down my-agent                 # from the repo root, when you're done
```

Ctrl+C always calls `computer.stop()`, which does nothing when `BERTH_OS_CONNECT` is set, so the server never tears down a shared instance. See the [Berth OS reference](../../../docs/berth-os-reference.md).
