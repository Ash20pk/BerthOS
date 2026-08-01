# hello-world-py

A minimal Python resident app. Its only job is to prove that [`@berth/sdk-python`](../../packages/sdk-python) is wire-protocol compatible with the TypeScript runtime — same manifest format, same RPC and context-bus semantics, different language.

## Exports

| Export | Input | Output | Does |
|---|---|---|---|
| `greet` | `{ name: string }` | `{ message: string }` | Returns a greeting string |
| `publish_file_created` | `{ path: string, created_by: string }` | — | Publishes `fs.file_created` on the context bus |

## Capabilities

```yaml
capabilities: []
```

None declared — this app doesn't touch the filesystem or network.

## Cross-language proof

[`apps/code-editor`](../code-editor/README.md) (TypeScript) subscribes to `fs.file_created` with a `{ path, createdBy }` shape. `publish_file_created` here publishes that exact event from Python, with no changes needed on the TypeScript side — a real end-to-end proof that the context bus works across languages, not just within one. See [docs/sdk-python-context-bus-reference.md](../../docs/sdk-python-context-bus-reference.md).

## Running it

```bash
cd apps/hello-world-py
pnpm exec berth dev
```

`on_install` runs `echo python-on-install-ran` — kept non-empty on purpose, to prove `on_install` genuinely executes for a Python app too (not just skipped as a no-op). `berth_sdk` itself needs no install step: `entrypoint.sh`'s Python branch puts the bind-mounted [`packages/sdk-python`](../../packages/sdk-python) source on `PYTHONPATH` directly, the same role a `node_modules` symlink plays for TypeScript apps.

Full Python SDK surface: [docs/sdk-python-reference.md](../../docs/sdk-python-reference.md).
