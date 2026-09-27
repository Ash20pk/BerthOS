# Context bus

The context bus is pub/sub between the resident apps in one sandbox. One app publishes an event on a topic, and every other app subscribed to that topic receives it. Use it when apps should react to each other (a filesystem app writes a file, an editor app opens it) without calling each other directly.

## Using it from a resident app

Register and subscribe in `onAgentReady`:

```ts
app.onAgentReady(async (ctx) => {
  await ctx.contextBus.register({ app: "my-app" });

  const unsubscribe = ctx.contextBus.subscribe("fs.file_created", (payload) => {
    // payload is whatever the publisher sent
  });
});
```

Export handlers receive only `input`, not `ctx`. To publish from a handler, keep the client from `onAgentReady`:

```ts
import type { ContextBusClient } from "@berthos/sdk";

let contextBus: ContextBusClient | undefined;

app.onAgentReady(async (ctx) => { contextBus = ctx.contextBus; });

app.export({
  name: "write_file",
  // ...
  handler: async (input) => {
    // ...
    await contextBus?.publish("fs.file_created", { path: input.path, createdBy: "filesystem" });
  },
});
```

| Method | What it does |
|---|---|
| `register({ app })` | Identify this connection. |
| `subscribe(topic, handler)` | Call `handler(payload)` for each event on `topic`. Returns an unsubscribe function. |
| `publish(topic, payload)` | Send a JSON-serialisable payload to every *other* subscriber of `topic`. The publisher doesn't receive its own event. |

If the daemon isn't reachable (a bare `node dist/index.js`, a unit test), `ctx.contextBus` logs a warning and falls back to an in-process bus that never leaves the app, so app code runs without a daemon. The Python SDK has the same client; see [the Python context bus reference](./sdk-python-context-bus-reference.md).

## Publishing from the host

A host process, such as an `Agent` from the experimental agent framework, can't reach the bus directly. `apps/filesystem` exports `publish_context_event({ topic, payload })` for this: call it like any other tool and it publishes inside the sandbox. The agent framework's step tracer uses it to publish `agent.step` events; see [tracing](./agents-reference.md#tracing-a-run-agentstep-events-not-a-langsmith-style-tracer).

## How it works

One `context-bus-daemon` (Rust) runs per sandbox, started before any app. Apps connect to its Unix socket at `$BERTH_CONTEXT_BUS_SOCKET` (default `/tmp/berth-context-bus.sock`) and exchange length-prefixed protobuf frames. The schema is `packages/context-bus-daemon/proto/context_bus.proto`.

The daemon identifies each connection by the kernel's report of its uid, not by the name passed to `register()`. An app can't register, publish or be logged as another app.

## Limits

- **Exact topics only.** No wildcard subscribe; to follow several topics, subscribe to each by name.
- **No persistence or replay.** A subscriber only sees events published after it subscribed, and a restored [snapshot](./computer-snapshots-reference.md) starts with no subscribers.
- **At-most-once delivery.** Each subscriber has a queue of 256 events; if it falls that far behind, further events to it are dropped (and logged) rather than slowing everyone else.
- **Any app can use any topic.** There's no per-topic permission; every app in the sandbox can publish and subscribe to every topic.
- **Frames are capped at 8 MiB.** The bus is for small events, not bulk data; put large content in `/context` and publish its path.
