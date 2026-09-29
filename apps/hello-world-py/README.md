# hello-world-py

A minimal resident app written in Python with [`berthos-sdk`](../../packages/sdk-python). Start here if you want to build an app in Python: it uses the same manifest, RPC and context bus as the TypeScript apps.

## Run it

The manifest says `runtime: python`, so every way of running an app runs it as Python:

```bash
cd apps/hello-world-py
berth dev
berth mcp --app hello-world-py --app-dir .   # as MCP tools
```

From agent code it's `Computer.boot({ apps: ["apps/hello-world-py"] })`, alone or next to TypeScript apps in one sandbox. `berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone.

The SDK needs no install step: every sandbox image carries it, and in a clone the repo's own `packages/sdk-python` is used instead, so edits to the SDK show up without a rebuild. The manifest's `on_install` runs `echo python-on-install-ran`, which shows that `on_install` runs for Python apps too.

## Capabilities

```yaml
capabilities: []
```

None. The app touches no files and no network.

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `greet` | `{ name }` | `{ message }` | Returns a greeting |
| `publish_file_created` | `{ path, created_by }` | | Publishes `fs.file_created` on the context bus |

## Talking to TypeScript apps

[`code-editor`](../code-editor) (TypeScript) subscribes to `fs.file_created`. `publish_file_created` sends that event from Python and `code-editor` reacts to it unchanged. See [Python and the context bus](../../docs/sdk-python-context-bus-reference.md) and the [Python SDK reference](../../docs/sdk-python-reference.md).
