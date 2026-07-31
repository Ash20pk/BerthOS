# @berth/sdk Reference

`@berth/sdk` is what a resident app imports. It runs *inside* the sandboxed container — it has no knowledge of Docker, the CLI, or the host toolchain.

## `defineApp(setup)`

```ts
import { defineApp } from "@berth/sdk";
import { z } from "zod";

export default defineApp((app) => {
  app.export({
    name: "ping",
    output: z.object({ message: z.string() }),
    handler: () => ({ message: "pong" }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "my-app" });
  });
});
```

Your app's entry file (`src/index.ts`) must have this as its **default export** — `@berth/sdk`'s runtime (`runtime.ts`) dynamically imports it at container boot.

## `app.export(definition)`

Registers one entry in your RPC surface. `input`/`output` are optional Zod schemas (`z.object({...})`, `z.string()`, etc.) — if provided, they validate the request/response at call time. Every `name` here must have a matching entry in your `berth.yml`'s `exports:` list, or the app fails to boot (see [manifest-reference.md](./manifest-reference.md)).

## `app.onInstall(fn)`

Runs after `berth.yml`'s shell-level `on_install` hooks, before `onAgentReady`. Use this for setup that's easier to express in TypeScript than as a shell command.

## `app.onAgentReady(fn)`

Runs once your app's exports are registered and `on_install` has completed. Receives an `AppContext`:

```ts
interface AppContext {
  contextBus: ContextBusClient;
  manifest: BerthManifest; // your parsed, validated berth.yml
}
```

## `ContextBusClient`

```ts
interface ContextBusClient {
  register(info: { app: string }): Promise<void>;
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}
```

**Real as of Phase 2.** `@berth/sdk`'s runtime connects to the Context Bus daemon (a Rust process, one per sandbox) over a Unix socket and falls back to Phase 1's in-process `createLocalContextBus()` no-op only if the daemon isn't reachable (e.g. running outside a sandbox, or in a unit test). See [context-bus-reference.md](./context-bus-reference.md) for the wire protocol and a real, running verification. App code written against this interface in Phase 1 needed zero changes for this to start working.

## `requestCapability(appName, capability)`

```ts
import { requestCapability } from "@berth/sdk";

const grant = await requestCapability("my-app", "browser:navigate:*.github.com");
// grant.granted === true, grant.token === null — unconditional in Phase 1
```

**Also a no-op today.** Every request is logged and granted unconditionally; `token` is always `null`. Phase 3 replaces this with a real call that blocks on human admin approval and returns a scoped, expiring token enforced at the kernel syscall boundary. Declare the capabilities you actually need in `berth.yml` now — Phase 3 will start enforcing exactly that list.

## The RPC layer

You don't call this directly — `@berth/sdk`'s runtime starts a line-delimited JSON RPC server over stdio once your app boots, dispatching `{ id, export, input }` requests to your registered `app.export()` handlers. This is what `berth test`'s stub-payload invocation (and, eventually, an agent's own tool-calling layer) talks to.
