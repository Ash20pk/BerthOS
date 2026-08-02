# `agent-server` example

The other direction from [`../simple-agent`](../simple-agent). Instead of an agent driving something (a file, a shell), the **agent itself is the thing being served**. `server.mjs` boots a `Computer` and `Agent` once at startup and exposes it over plain HTTP: `POST /task { task: string }` runs it and returns `{ text, toolCalls }`, `GET /health` reports the tools it has loaded.

Depends on `@berth/agents` as an ordinary `workspace:*` package dependency, same as every other example under `examples/agents/`. Nothing here reaches into this monorepo's source or build output by relative path.

## Why boot once, not per request

A naive version of this would call `createAgent()` inside the request handler. That rebuilds a Docker image and boots a fresh container on every single HTTP request, which makes the cold-start problem worse, not better. `server.mjs` boots (or connects) exactly once, before `listen()`, and reuses the same `Agent`/`Computer` for every request that comes in.

## Prerequisites

```bash
pnpm install
pnpm build          # from the repo root, builds @berth/agents and its deps
```

A local Docker daemon needs to be running, and either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` needs to be set. The script prints `SKIP` and exits cleanly if neither is, rather than failing.

## Running

```bash
cd examples/agents/agent-server
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/task \
  -H 'content-type: application/json' \
  -d '{"task":"write a file called hello.txt with the text hi, then read it back"}'
```

`PORT` overrides the default `8787`.

## Pairing with `berth os up`

Booting once at server startup already avoids per-request cold start, but the server process itself still pays the full build and boot cost every time it restarts, say on every code change during development. Point it at an already-running `berth os up` instance instead.

```bash
# from the repo root
berth os up my-agent --apps=apps/filesystem

cd examples/agents/agent-server
BERTH_OS_CONNECT=my-agent pnpm start   # connects in milliseconds, no build or boot

berth os down my-agent                 # from the repo root, when you're done
```

Shutting down the server (Ctrl+C) always calls `computer.stop()`, which is a no-op when `BERTH_OS_CONNECT` was used, so it never tears down a shared OS other processes might still be using. See [`docs/berth-os-reference.md`](../../../docs/berth-os-reference.md).
