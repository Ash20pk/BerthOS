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

**Real as of Phase 3, for filesystem writes and (opt-in, when declared) reads and network ports.** `requestCapability()` checks the requested capability against `berth.yml`'s declared `capabilities:` (the same list `agent-init` turned into an enforced Landlock policy at boot) and reports `{ granted, token, issuedAt, expiresAt, pending? }` honestly — `granted: false` (and the token fields `null`) for anything not declared. It does not itself decide or broker access; the kernel already decided that at process start. `token` is a real HMAC-SHA256 signature with a 5-minute expiry (`verifyCapabilityToken()` checks it), not just a marker. If a `--grants-server` was configured (`BERTH_GRANTS_SERVER_URL`), a denied request also gets submitted there for human approval and `pending: true` is set — see [capability-tokens-reference.md](./capability-tokens-reference.md) for the full human-approval flow (and why approval only takes effect on the app's next restart, never live) and exactly what's enforced vs. reported-only right now (domain-scoped network filtering isn't kernel-enforced, only port-based).

## `defineConnectorApp(config)`: a resident app from a declarative REST API description

`defineApp` still needs a hand-written `handler` per export — fine for an app with genuine custom logic, but every existing integration app (`apps/github-assistant`'s `create_issue`/`get_repo_summary`) is really just "call this REST endpoint with these params" repeated a few times, in bespoke TypeScript, once per integration. `defineConnectorApp` turns that same shape into config instead of code — wiring in the *next* integration (Slack, Jira, a weather API) becomes "write a `ConnectorConfig`," not "write a new app's TypeScript by hand":

```ts
import { defineConnectorApp } from "@berth/sdk";

export default defineConnectorApp({
  baseUrl: "https://api.example.com",
  auth: { type: "bearer", envVar: "EXAMPLE_API_TOKEN" },
  operations: [
    {
      export: "get_widget",
      method: "GET",
      path: "/widgets/{id}",
      params: { id: { in: "path", type: "string" } },
    },
    {
      export: "create_widget",
      method: "POST",
      path: "/widgets",
      params: { name: { in: "body", type: "string" }, color: { in: "body", type: "string", required: false } },
    },
  ],
});
```

Each `operations[]` entry becomes one export, exactly as if you'd called `app.export()` yourself — same `berth.yml` `exports:` bijection requirement applies. `params[key].in` decides where an input field lands on the actual HTTP request: `"path"` fills a `{name}` placeholder in `path`, `"query"` becomes a query-string parameter, `"body"` becomes a field in a JSON request body (sent for any method except `GET`/`DELETE`). The generated Zod input schema marks a param optional only when `required: false` is set — everything else is required.

**Auth**, read from an env var at request time (never baked into the config): `{type: "bearer", envVar}` sends `Authorization: Bearer <value>`; `{type: "header", envVar, headerName}` sends the value under whatever header name you give it; `{type: "none"}` (the default) sends no credential at all. When `type` isn't `"none"` and the env var is unset, an operation returns `{stub: true, note: "..."}` instead of making a real request — the same "no live credentials → stub, don't crash" posture `apps/github-assistant` already hand-wrote per export, generalized here so it applies to every operation for free, including whatever `berth test`'s automatic stub-invocation of every declared export calls with dummy input.

**Egress**: `defineConnectorApp` calls `@berth/sdk`'s `configureEgressProxy()` for you — a connector author never has to remember to wire that in themselves. Declare `network:host:<pattern>` in `berth.yml` (see [egress-broker-reference.md](./egress-broker-reference.md)) and every operation's traffic is already routed and host-scoped correctly.

**What this does and doesn't cover**: path/verb-level API scoping (e.g. "this token can only call `GET` endpoints, not `POST`") is deliberately out of scope — `apps/github-assistant`'s own `github-api-broker.cjs` does real TLS interception for exactly that harder problem (see [github-api-scoping-reference.md](./github-api-scoping-reference.md)), and `defineConnectorApp` doesn't attempt it. A connector's response is passed through as `{status, data}` (whatever the API returned, JSON-parsed if possible) — there's no per-operation output schema, since a config author would otherwise have to hand-describe every endpoint's response shape just to get validation `defineApp`'s own `output` already gives you for free when you *do* write a schema. See `examples/resident-apps/generic-connector` for a complete, runnable example against a real public API (JSONPlaceholder).

## The RPC layer

You don't call this directly — `@berth/sdk`'s runtime starts a line-delimited JSON RPC server over stdio once your app boots, dispatching `{ id, export, input }` requests to your registered `app.export()` handlers. This is what an agent's own tool-calling layer talks to at runtime.

`berth test`'s stub-payload invocation is a separate, non-overlapping path: `packages/cli/src/commands/test.ts` calls into `packages/sdk/src/check-exports.ts`, which invokes `def.handler(input)` directly in-process — it never goes through this RPC layer's line-delimited JSON framing at all.
