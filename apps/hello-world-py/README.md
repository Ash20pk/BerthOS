# hello-world-py

A minimal resident app written in Python with [`berthos-sdk`](../../packages/sdk-python). Start here if you want to build an app in Python: it uses the same manifest, RPC and context bus as the TypeScript apps.

## Run it

`berth dev` doesn't pick the Python runtime yet, so start this app the way its test does: build the dev image and boot it with `BERTH_APP_RUNTIME=python`. The quickest way is the milestone test, from the repo root:

```bash
pnpm build
node packages/docker-orchestrator/test/python-sdk-milestone.mjs
```

It builds the image, starts the sandbox, calls `greet`, and checks the reply. To boot it from your own script, call `startContainer()` from `@berthos/docker-orchestrator` with `env: { BERTH_APP_RUNTIME: "python" }`, as that test does.

The SDK needs no install step: the sandbox puts the SDK source from `packages/sdk-python` on `PYTHONPATH`. The manifest's `on_install` runs `echo python-on-install-ran`, which shows that `on_install` runs for Python apps too.

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
