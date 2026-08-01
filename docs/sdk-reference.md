# @berth/sdk Reference

`@berth/sdk` is what a resident app imports. It runs *inside* the sandboxed container — it has no knowledge of Docker, the CLI, or the host toolchain.

If you're consuming this from outside this monorepo (any real third-party app is), `berth init` vendors a self-contained build automatically — see [app registry reference](./app-registry-reference.md#making-berthsdk-installable-outside-this-monorepo) for what that build actually is and why it was needed.

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
  semanticFs: SemanticFsClient;
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

## `SemanticFsClient`

```ts
interface SemanticFsClient {
  register(info: { app: string }): Promise<void>;
  tag(path: string, meta: { task?: string; relatedApps?: string[] }): Promise<void>;
  query(text: string, limit?: number): Promise<SemanticFsQueryResult[]>;
}
```

**Real as of Phase 4.** Files written through `$BERTH_CONTEXT_MOUNT` (default `/context`, a FUSE mount served by `semantic-fs-daemon`, a Go process, one per sandbox) are automatically attributed to whichever app called `register()` from that process — `tag()` then attaches `task`/`related_apps` metadata explicitly (and, internally, an embedding computed from that same text), and `query()` searches all of it via a hybrid keyword + embedding-similarity ranking. Falls back to `createLocalSemanticFs()` (an always-empty no-op) if the daemon isn't reachable. See [semantic-fs-reference.md](./semantic-fs-reference.md) for the full design, the FUSE wire-up, the embedding model/calibration details, and a real, running verification.

## `requestCapability(appName, capability)`

```ts
import { requestCapability } from "@berth/sdk";

const grant = await requestCapability("my-app", "filesystem:write:/workspace");
// grant.granted reflects whether this was actually declared in berth.yml —
// and for filesystem:write:*, whether the kernel is actually enforcing it
// (see docs/capability-tokens-reference.md)
```

**Real as of Phase 3, for filesystem writes and (opt-in, when declared) reads and network ports.** `requestCapability()` checks the requested capability against `berth.yml`'s declared `capabilities:` (the same list `agent-init` turned into an enforced Landlock policy at boot) and reports `{ granted, token, issuedAt, expiresAt }` honestly — `granted: false` (and the rest `null`) for anything not declared. It does not itself decide or broker access; the kernel already decided that at process start. `token` is a real HMAC-SHA256 signature with a 5-minute expiry (`verifyCapabilityToken()` checks it), not just a marker. A full human-approval workflow is still separate work in progress — see [capability-tokens-reference.md](./capability-tokens-reference.md) for exactly what's enforced vs. reported-only right now (domain-scoped network filtering isn't kernel-enforced, only port-based).

## The RPC layer

You don't call this directly — `@berth/sdk`'s runtime starts a line-delimited JSON RPC server over stdio once your app boots, dispatching `{ id, export, input }` requests to your registered `app.export()` handlers. This is what `berth test`'s stub-payload invocation (and, eventually, an agent's own tool-calling layer) talks to.
