# @berthos/sdk reference

`@berthos/sdk` is the TypeScript library a resident app is written with. It runs inside the sandbox: it defines your exports, runs your startup hooks, connects you to the context bus and the semantic filesystem, and serves your exports to whoever calls them.

```bash
npm install @berthos/sdk zod
```

`berth init` sets this up for you. For the Python SDK, see [sdk-python-reference.md](./sdk-python-reference.md).

```ts
import { defineApp } from "@berthos/sdk";
import { z } from "zod";

export default defineApp((app) => {
  app.export({
    name: "ping",
    output: z.object({ message: z.string() }),
    handler: () => ({ message: "pong" }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: ctx.manifest.name });
  });
});
```

## How an app boots

1. Berth loads and validates `berth.yml`.
2. It imports your built entry file, `dist/index.js`, and reads its default export.
3. It checks your exports against `berth.yml`'s `exports:` list and stops with an error if they differ.
4. It connects to the context bus and semantic filesystem.
5. It runs your `onInstall` hooks, then your `onAgentReady` hooks, in the order you registered them.
6. It starts serving your exports and logs `[berth:runtime] "<name>" ready`.

By the time your code runs, the kernel policy compiled from your capabilities is already in force.

## `defineApp(setup)`

```ts
function defineApp(setup: (app: BerthApp) => void): BerthApp;
```

Calls `setup` with an app object you register exports and hooks on, and returns it. Your entry file must `export default` the result.

## `app.export(definition)`

```ts
interface ExportDefinition<In, Out> {
  name: string;
  input?: z.ZodType<In>;
  output?: z.ZodType<Out>;
  handler: (input: In) => Promise<Out> | Out;
}
```

Registers one export. The export becomes a tool, and `name` must match an entry in `berth.yml`'s `exports:` list ([manifest reference](./manifest-reference.md#exports-default-)).

- `input`, if given, parses the caller's input before `handler` sees it. A parse failure is returned to the caller as an error.
- `output`, if given, parses what `handler` returns, and the parsed value is what's sent back, so Zod defaults and transforms apply.
- A thrown error is returned to the caller as `{ id, error: message }`; it doesn't crash the app.
- Registering the same `name` twice throws.

## `app.onInstall(fn)`

```ts
app.onInstall(fn: () => Promise<void> | void): void;
```

Runs once at startup, before `onAgentReady`, inside your app's own sandboxed process and under its declared capabilities. Use it for setup that's easier in TypeScript than as a shell command. For build-time setup such as installing packages, use `berth.yml`'s [`on_install`](./manifest-reference.md#on_install-default-) instead.

## `app.onAgentReady(fn)`

```ts
app.onAgentReady(fn: (ctx: AppContext) => Promise<void> | void): void;

interface AppContext {
  contextBus: ContextBusClient;
  semanticFs: SemanticFsClient;
  manifest: BerthManifest; // your parsed, validated berth.yml
}
```

Runs once at startup, after `onInstall` and before your exports are served. This is where you register on the context bus, subscribe to topics, and keep references your export handlers need. A handler only receives its input, so store `ctx.contextBus` or `ctx.semanticFs` in a variable your handlers can reach.

Not to be confused with `berth.yml`'s `on_agent_ready` field, which is never run.

## `ContextBusClient`

```ts
interface ContextBusClient {
  register(info: { app: string }): Promise<void>;
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(topic: string, handler: (payload: unknown) => void): () => void; // returns unsubscribe
}
```

Publish and subscribe between apps in the same sandbox, through a daemon the sandbox runs. Payloads are JSON.

```ts
app.onAgentReady(async (ctx) => {
  await ctx.contextBus.register({ app: "code-editor" });
  ctx.contextBus.subscribe("fs.file_created", (payload) => {
    const { path } = payload as { path: string };
    console.error(`new file: ${path}`);
  });
});
```

Outside a sandbox (a bare `node dist/index.js`, a unit test), the runtime logs a warning and uses an in-process stand-in. `createLocalContextBus()` gives you the same stand-in for your own tests. See the [context bus reference](./context-bus-reference.md).

## `SemanticFsClient`

```ts
interface SemanticFsClient {
  register(info: { app: string }): Promise<void>;
  tag(path: string, meta: { task?: string; relatedApps?: string[] }): Promise<void>;
  query(text: string, limit?: number): Promise<SemanticFsQueryResult[]>;
}

interface SemanticFsQueryResult {
  path: string;
  createdBy?: string;
  task?: string;
  relatedApps?: string[];
  createdAt: number;
  updatedAt: number;
}
```

A filesystem mounted at `$BERTH_CONTEXT_MOUNT` (`/context` by default) that records why each file exists, so other apps can find it by searching instead of knowing its path.

| Method | What it does |
|---|---|
| `register({ app })` | Attributes your later writes under `/context` to this app (`createdBy`) |
| `tag(path, meta)` | Attaches a `task` and `relatedApps` to a file you already wrote. `path` is relative to the mount. |
| `query(text, limit?)` | Searches the tags of tagged files, ranking keyword matches above semantic similarity. Omit `limit` to get every match. |

`query` searches tag text (path, author, task, related apps), not file contents, and only finds files something tagged. Your app needs `filesystem:write:/context` to write there.

Inside a sandbox, if the daemon isn't reachable, `tag` and `query` throw instead of returning nothing. Outside one, they use an always-empty stand-in, also available as `createLocalSemanticFs()`. See the [semantic filesystem reference](./semantic-fs-reference.md#query-semantics--hybrid-keyword--embedding-similarity).

## `requestCapability(appName, capability)`

```ts
function requestCapability(appName: string, capability: string): Promise<{ granted: boolean }>;
```

```ts
import { requestCapability } from "@berthos/sdk";

const { granted } = await requestCapability("my-app", "filesystem:write:/workspace/reports");
if (!granted) throw new Error("declare filesystem:write:/workspace in berth.yml");
```

Reports whether a capability is covered by what your app declared, using the same glob matching as the policy. It reads the policy compiled at boot, falling back to `berth.yml` outside a sandbox. It doesn't grant anything: the kernel already enforces what you declared, and this lets your code check before it tries.

## `configureEgressProxy()`

```ts
import { configureEgressProxy } from "@berthos/sdk";

configureEgressProxy(); // once, at module load
```

Routes your process's `fetch()` traffic through the sandbox's egress proxy, which allows only the hosts your `network:host:` or `browser:navigate:` capabilities name. Does nothing when your app declares neither, so it's safe to call unconditionally. You also need `network:connect:8090` for the proxy's port. See the [egress proxy reference](./egress-broker-reference.md).

## `defineConnectorApp(config)`: a resident app from a declarative REST API description

For an app that is only "call this REST endpoint with these parameters", describe the API instead of writing handlers. Each operation becomes an export.

```ts
import { defineConnectorApp } from "@berthos/sdk";

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
      params: {
        name: { in: "body", type: "string" },
        color: { in: "body", type: "string", required: false },
      },
    },
  ],
});
```

```yaml
# berth.yml
capabilities:
  - network:host:api.example.com
  - network:connect:8090
secrets:
  - EXAMPLE_API_TOKEN
exports:
  - name: get_widget
    input: { id: string }
  - name: create_widget
    input: { name: string, color: string }
```

**`ConnectorConfig`**

| Field | Type | Notes |
|---|---|---|
| `baseUrl` | string | Operation paths resolve against it |
| `auth` | `ConnectorAuth` | Optional. Defaults to `{ type: "none" }` |
| `operations` | `ConnectorOperation[]` | One export each |

**`ConnectorOperation`**

| Field | Type | Notes |
|---|---|---|
| `export` | string | The export name. Must be in `berth.yml`'s `exports:` |
| `method` | `"GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE"` | |
| `path` | string | `{name}` placeholders are filled from `in: "path"` params |
| `params` | `Record<string, ConnectorParam>` | Optional |
| `description` | string | Optional |

**`ConnectorParam`**

| Field | Type | Notes |
|---|---|---|
| `in` | `"path" \| "query" \| "body"` | Path placeholder, query string, or field of a JSON body. A body is sent for every method except `GET` and `DELETE`. |
| `type` | `"string" \| "number" \| "boolean"` | |
| `required` | boolean | Defaults to `true` |
| `description` | string | Optional; attached to the input schema |

**`ConnectorAuth`**

| `type` | Sends |
|---|---|
| `"none"` | No credential |
| `"bearer"` | `Authorization: Bearer <value of envVar>` |
| `"header"` | `<headerName>: <value of envVar>` |

The credential is read from the environment on each request. If `type` isn't `"none"` and `envVar` is unset, the operation returns `{ stub: true, note: "set <envVar> for live data ..." }` instead of calling the API, so `berth test` can call every export without credentials.

A live call returns `{ status, data }`, where `data` is the response parsed as JSON, or the raw text if it isn't JSON. There's no output schema. `defineConnectorApp` calls `configureEgressProxy()` for you and registers the app on the context bus.

It scopes by hostname only. To restrict which methods and paths an API token can call, you need an API proxy such as the [GitHub one](./github-api-scoping-reference.md). A complete example against a public API: [`examples/resident-apps/generic-connector`](../examples/resident-apps/generic-connector).

## How exports are called

You don't call this layer yourself. The runtime serves your exports as line-delimited JSON: one request per line in, one response per line out.

```json
{"id": "1", "export": "ping", "input": {}}
{"id": "1", "result": {"message": "pong"}}
{"id": "2", "error": "no such export \"pong\""}
```

It listens on these transports:

| Transport | When | Who can reach it |
|---|---|---|
| stdio | Always | The host (`berth rpc`, `berth mcp`) |
| Unix socket at `$BERTH_RPC_SOCKET` | Several apps in one sandbox | This app and root on the host (mode `0600`) |
| `/run/berth/<app>/peers/<caller>/rpc.sock` | Another app declares `app:invoke:<app>` | That one app |
| HTTP(S) on `$BERTH_HTTP_RPC_PORT` | A sandbox deployed to a remote fleet | Anyone holding the bearer token |
| TCP on `$BERTH_NETWORK_PORT` | Only if you set it yourself | Other containers on the Docker network |

When a governing app is loaded ([`governs: true`](./manifest-reference.md#governs-default-false)), every call on every transport is checked with it first, and refused if it says no or can't be reached. See the [governance reference](./governance-reference.md).

### HTTP RPC server

A sandbox deployed to E2B, Daytona or Kubernetes has no stdio the host can attach to, so the runtime can serve your exports over HTTP instead. The deploy tooling sets this up; you only need it to call a deployed app from your own client.

| Endpoint | Auth | Body | Response |
|---|---|---|---|
| `GET /healthz` | none | | `{"ok": true}` |
| `POST /rpc` | `Authorization: Bearer <token>` | `{"id", "export", "input"}` | `{"id", "result"}` or `{"id", "error"}` |

A missing or wrong token gets `401`, a body that isn't JSON gets `400`, and any other path gets `404`.

| Env var | Meaning |
|---|---|
| `BERTH_HTTP_RPC_PORT` | Port to listen on. Unset means no HTTP server. |
| `BERTH_HTTP_RPC_TOKEN` | Required bearer token. The app refuses to start if the port is set without it. |
| `BERTH_HTTP_RPC_APP` | In a multi-app sandbox, the one app that listens. Unset means the only app does. |
| `BERTH_HTTP_RPC_TLS_CERT`, `BERTH_HTTP_RPC_TLS_KEY` | Paths to a PEM certificate and key to serve HTTPS. Set both or neither. |

Without TLS the server speaks plain HTTP. That's fine behind E2B's and Daytona's HTTPS URLs, which terminate TLS in front of it. Anywhere the port is reached directly, such as a Kubernetes NodePort, set the certificate and key, or the token crosses the network in the clear.

## Environment variables

Set by Berth inside the sandbox. You rarely need to change them.

| Variable | Default | Meaning |
|---|---|---|
| `BERTH_MANIFEST_PATH` | `./berth.yml` | Manifest to load |
| `BERTH_APP_ENTRY` | `./dist/index.js` | Built entry file |
| `BERTH_CONTEXT_BUS_SOCKET` | `/tmp/berth-context-bus.sock` | Context bus daemon |
| `BERTH_SEMANTIC_FS_SOCKET` | `/tmp/berth-semantic-fs.sock` | Semantic filesystem daemon |
| `BERTH_CONTEXT_MOUNT` | `/context` | Where the semantic filesystem is mounted |
| `BERTH_CAPABILITY_POLICY` | `./.berth/capability-policy.json` | Compiled policy `requestCapability()` reads |
| `BERTH_EGRESS_PROXY_URL` | set when needed | Proxy `configureEgressProxy()` uses |
| `BERTH_GOVERNANCE_TIMEOUT_MS` | `5000` | How long the governing app has to answer |

## Using the SDK outside this repo

`berth init` vendors a self-contained build of the SDK into your project so it installs anywhere. See [app registry reference](./app-registry-reference.md#making-berthossdk-installable-outside-this-monorepo).
