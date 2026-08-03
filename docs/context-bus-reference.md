# Context Bus Reference

The Context Bus is Phase 2's first real agent runtime primitive: shared semantic working memory that every resident app in one agent sandbox can publish to and subscribe from. It's what lets apps react to each other — a filesystem app writes a file, a code-editor app notices and opens it — without either app calling the other directly or any orchestration layer wiring them together.

## Architecture

One `context-bus-daemon` process (Rust, `packages/context-bus-daemon`) runs per agent sandbox (per container), started by `entrypoint.sh` before any resident app's runtime. Every resident app process in that sandbox connects to the same Unix socket (`$BERTH_CONTEXT_BUS_SOCKET`, default `/tmp/berth-context-bus.sock`) and exchanges length-prefixed protobuf `Envelope` frames — the schema lives at `packages/context-bus-daemon/proto/context_bus.proto` (canonical) with identical copies shipped in `@berth/sdk` (for the TypeScript client) and `packages/sdk-python` (for the Python client) to load at runtime.

```
resident app A ──┐                      ┌── resident app B
  (filesystem)    │                      │    (code-editor)
                  ▼                      ▼
         @berth/sdk ContextBusClient (unix-socket.ts)
                  │                      │
                  └────► context-bus-daemon ◄────┘
                       (one per sandbox, Unix socket)
```

The daemon's protocol is deliberately simple: `register` (identify yourself), `subscribe`/`unsubscribe` (topic), `publish` (topic + opaque JSON payload bytes), and `event` (server → client push for a subscribed topic). Publishing to a topic broadcasts to every *other* connection subscribed to it — a publisher never gets its own event echoed back.

## Using it from a resident app

`ctx.contextBus` (available in `onAgentReady`) is the same `ContextBusClient` interface Phase 1 shipped as a local no-op — no resident app code needs to change to go from Phase 1 to Phase 2:

```ts
app.onAgentReady(async (ctx) => {
  await ctx.contextBus.register({ app: "my-app" });

  ctx.contextBus.subscribe("fs.file_created", (payload) => {
    const event = payload; // whatever shape the publisher sent
    // react — no one told you to do this, you just noticed
  });
});
```

Export handlers only receive `input`, not `ctx` — if a handler needs to publish, capture the context bus reference in a closure during `onAgentReady`:

```ts
let contextBus;
app.export({ name: "write_file", /* ... */, handler: async (input) => {
  // ...
  await contextBus?.publish("fs.file_created", { path: input.path, createdBy: "filesystem" });
}});
app.onAgentReady(async (ctx) => { contextBus = ctx.contextBus; });
```

`@berth/sdk`'s `runtime.ts` tries the real Unix-socket client first and falls back to the Phase 1 local no-op if the daemon isn't reachable (e.g. running a bare `node dist/index.js` outside a sandbox, or in a unit test) — so app code is never forced to depend on a daemon being present.

## Verifying it

`packages/docker-orchestrator/test/context-bus-milestone.mjs` is a real (not mocked) integration test: it boots a container for `apps/filesystem`, starts `apps/code-editor`'s runtime as a second process in the *same* sandbox via `docker exec`, invokes `filesystem`'s `write_file` export over its live RPC interface, and asserts that `code-editor` reactively opens the new file — proving apps can react to each other end-to-end rather than just compiling. Run it with:

```bash
cd packages/docker-orchestrator
node test/context-bus-milestone.mjs
```

## Known limitations (Phase 2 scope)

- One daemon per sandbox, but this is no longer a hard one-app-per-container limitation: `--apps=<dir1>,<dir2>` (see [Multi-App Sandbox Reference](./multi-app-reference.md)) and `berth os up --apps=...` / `--config=<path>` (see [`berth os` reference](./berth-os-reference.md)) both run multiple resident apps together in one sandbox, each with its own enforced process. The bind-mount-plus-`docker exec` approach in `context-bus-milestone.mjs` predates both of those and is kept as a from-scratch protocol check for the daemon itself, not as the recommended way to actually run multiple apps today.
- No message persistence or replay — a subscriber only sees events published after it subscribes.
- The `.proto` schema is duplicated (by hand) across three places — `packages/context-bus-daemon`, `packages/sdk`, and `packages/sdk-python` — rather than living in one shared package. This is overdue debt, not a future hypothetical: the third copy has already landed.
