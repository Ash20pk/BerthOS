# Building a resident app

A resident app is a tool your agent can use, running inside the Berth sandbox. It is a directory with a `berth.yml` manifest, which says what the app may touch and what it exports, and code that implements those exports. Each export becomes a tool in your agent. Every first-party app in [`apps/`](../apps) is built this way.

This guide takes you from `berth init` to an app that fetches web pages from one allowed host. Field details are in the [manifest reference](./manifest-reference.md) and the API in the [SDK reference](./sdk-reference.md).

## Before you start

You need Docker, Node 22+, pnpm and the Berth CLI:

```bash
npm install -g @berthos/cli
berth doctor
```

`berth doctor` tells you whether this machine's kernel can enforce capabilities. Enforcement needs Landlock (Linux 6.7+); Docker Desktop doesn't have it. Without it, `berth dev` runs your app unrestricted and warns you. On a Mac, `berth doctor --fix` sets up a VM that can enforce. Set `BERTH_REQUIRE_ENFORCEMENT=1` to refuse to run an app that can't be locked down.

## 1. Scaffold

```bash
berth init my-app --template hello-world
cd my-app
```

`berth init` writes the app, runs `pnpm install`, and validates the manifest. The other template is `browser-native` (headless Chromium you can watch over VNC); `--registry=<url>` starts from a published app instead ([app registry](./app-registry-reference.md)).

You get:

```
my-app/
  berth.yml        # name, capabilities, exports
  src/index.ts     # the code behind the exports
  package.json
  tsconfig.json
  vendor/          # a bundled copy of @berthos/sdk
```

`berth.yml`:

```yaml
name: my-app
version: 0.1.0

capabilities: []

exports:
  - name: ping
    output: { message: string }

on_install: []
on_agent_ready:
  - "register_with_context_bus"
```

The `on_agent_ready:` lines do nothing; the runtime never runs them. You can delete them.

`src/index.ts`:

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
    await ctx.contextBus.register({ app: "my-app" });
  });
});
```

## 2. Run it

Berth runs your compiled `dist/index.js`, so build first, then boot:

```bash
pnpm build
berth dev
```

```
Building dev image for "my-app"...
Container started. Watching .../my-app/src and berth.yml for changes...
[berth:dev] "my-app" declares no browser:* capability: no VNC ports exposed
[berth:dev] "my-app" declares no terminal:* capability: no terminal port exposed
[berth:dev] [berth:runtime] "my-app" ready
```

In another terminal, call the export:

```bash
berth rpc my-app --export ping
```

```json
{
  "message": "pong"
}
```

`berth dev` restarts the container when `src/` or `berth.yml` changes. It doesn't compile TypeScript, so keep `pnpm exec tsc -p tsconfig.json --watch` running in a third terminal, or rebuild before each change is picked up.

## 3. Add an export that needs a capability

An app starts with no network. To fetch pages from one host, declare that host and the port of the sandbox's egress proxy, which checks every request against the hosts you declared:

```yaml
name: my-app
version: 0.1.0

capabilities:
  - network:host:example.com     # which host the proxy allows
  - network:connect:8090         # the kernel lets the app reach the proxy's port

exports:
  - name: ping
    output: { message: string }
  - name: fetch_text
    input: { url: string }
    output: { text: string }
```

```ts
import { defineApp, configureEgressProxy } from "@berthos/sdk";
import { z } from "zod";

configureEgressProxy(); // route fetch() through the egress proxy

export default defineApp((app) => {
  app.export({
    name: "ping",
    output: z.object({ message: z.string() }),
    handler: () => ({ message: "pong" }),
  });

  app.export({
    name: "fetch_text",
    input: z.object({ url: z.string() }),
    output: z.object({ text: z.string() }),
    handler: async ({ url }) => {
      const res = await fetch(url);
      return { text: await res.text() };
    },
  });
});
```

Rebuild, then try an allowed and a disallowed host:

```bash
berth rpc my-app --export fetch_text --input '{"url":"https://example.com"}'
berth rpc my-app --export fetch_text --input '{"url":"https://api.github.com"}'   # refused by the proxy
```

On an enforcing kernel, a direct connection that skips the proxy is refused too, because the app may only connect to port 8090. This is the same pattern as [`examples/resident-apps/http-fetch`](../examples/resident-apps/http-fetch). Every capability you can declare is listed in the [manifest reference](./manifest-reference.md#capabilities).

## 4. Test it

```bash
berth test
```

`berth test` builds the production image, checks that your code's exports match `berth.yml`, calls each export with a generated input that fits its schema, and runs your `npm test` if `package.json` has one (for a `runtime: python` app, `pytest` if it has a `tests/` directory). `--json` prints a summary for CI.

## 5. Use it from an agent

`berth mcp` serves your app's exports as MCP tools, so any MCP client can use them:

```bash
berth mcp --app my-app --warm      # build the image once; MCP clients time out on a first build
claude mcp add my-app -- berth mcp --app my-app --app-dir /abs/path/to/my-app
```

`--only=<exports>` limits which exports the client sees. See the [MCP quickstart](./mcp-quickstart.md) for Claude Desktop and Cursor. To publish your app for others, see `berth publish` in the [app registry reference](./app-registry-reference.md).

## Rules that trip people up

- **Exports must match on both sides.** Every `app.export({ name })` needs an entry in `berth.yml`'s `exports:`, and every entry needs an `app.export`. A mismatch stops the app at boot.
- **Anything undeclared is denied.** Filesystem writes, outbound connections and listening ports are refused by the kernel unless `berth.yml` declares them. Filesystem paths must be under `/workspace`, `/context`, `/tmp` or `/app`.
- **Use a hostname, not an open port.** Reach the outside world with `network:host:<pattern>` through the egress proxy, not `network:connect:*`, which opens every port. The proxy can chain through an upstream proxy of your own; see [egress proxy](./egress-broker-reference.md#optional-chaining-through-an-upstream-proxy-eg-residential).
- **`on_install` runs at image build time.** Changing it needs a restart of `berth dev`, which rebuilds; a file-change restart doesn't. For setup inside your app's process at startup, use `app.onInstall(fn)` ([manifest reference](./manifest-reference.md#on_install-default-)).
- **Declaring a capability and exposing it are separate.** A `browser:*` or `terminal:*` capability makes `berth dev` publish a noVNC or ttyd port on `127.0.0.1`, behind a password it prints each boot. Turn that off with `expose: { browser: false }` or `expose: { terminal: false }`. A deployed instance only gets a viewing URL with `expose: { preview: true }`.
- **Credentials go in `secrets:`.** List the env var names your app needs, and each is delivered only to the apps that declare it. See the [secrets reference](./secrets-reference.md).
- **Your project folder is read-only inside `berth dev`.** An app can't modify your repository. App data written under `$BERTH_WORKSPACE_ROOT` lands in `.berth/dev-workspace/` in your project.

## Talking to other apps

Apps in the same sandbox can share events, files and exports. The first two are reachable from the `AppContext` your `onAgentReady` hook receives.

- **Context bus** (`ctx.contextBus`): `register`, `publish(topic, payload)`, `subscribe(topic, handler)`. Pub/sub between apps. One app publishes `fs.file_created`, another reacts, and neither knows the other exists. See the [context bus reference](./context-bus-reference.md).
- **Semantic filesystem** (`ctx.semanticFs`): `register`, `tag(path, meta)`, `query(text, limit)`. A filesystem at `/context` that records who wrote each file and why, so other apps can find files by searching. The search covers tags (`task`, `relatedApps`, path, author), not file contents, and only files something tagged. See the [semantic filesystem reference](./semantic-fs-reference.md#query-semantics--hybrid-keyword--embedding-similarity).
- **Direct calls**: declare `app:invoke:<name>` and your app gets its own socket to that app's exports, at `/run/berth/<name>/peers/<your-app>/rpc.sock`. Send one JSON request per line (`{"id": "1", "export": "list_notes", "input": {}}`) and read one response per line. Apps that don't declare it get `EACCES`. See the [manifest reference](./manifest-reference.md#calling-another-app).

[`apps/filesystem`](../apps/filesystem) and [`apps/code-editor`](../apps/code-editor) show the context bus in use: the first publishes `fs.file_created`, the second reacts to it.

To run several apps in one sandbox, each with its own kernel policy, pass `--apps=<paths>` to `berth dev` or `berth os up`. See the [multi-app reference](./multi-app-reference.md).

## Other ways to build one

- **From a REST API description.** For an app that only calls REST endpoints, [`defineConnectorApp`](./sdk-reference.md#defineconnectorappconfig-a-resident-app-from-a-declarative-rest-api-description) turns a config into exports, with no handlers to write.
- **In Python.** The [Python SDK](./sdk-python-reference.md) (`pip install berthos-sdk`) speaks the same protocol.

**Looking for something to build?** [CONTRIBUTING.md](../CONTRIBUTING.md#resident-apps-wed-love-to-see) has a wishlist (Slack, Postgres, Gmail, Stripe, and more) and the path from `berth init` to a PR.
