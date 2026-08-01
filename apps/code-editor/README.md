# code-editor

A resident app that reads files from `/workspace` — directly on request, or reactively whenever another app announces a file was created.

## Exports

| Export | Input | Output | Does |
|---|---|---|---|
| `open_file` | `{ path: string }` | `{ content: string }` | Reads a file under `/workspace` |

## Capabilities

```yaml
capabilities:
  - filesystem:read:/workspace
```

Read-only — this app never writes.

## The reactive path

Beyond its one export, `code-editor` subscribes to `fs.file_created` on the context bus at `onAgentReady` time. [`apps/filesystem`](../filesystem/README.md) publishes that event on every `write_file` call; `code-editor` never receives an explicit command to open the file — it just reacts:

```
apps/filesystem  --publish("fs.file_created", {path, createdBy})-->  context bus  --> apps/code-editor (subscribed)
```

This is the pair the root README points to as a working example of cross-app collaboration with no explicit orchestration — see [docs/context-bus-reference.md](../../docs/context-bus-reference.md).

## Running it

```bash
cd apps/code-editor
pnpm exec berth dev
```

To see the reactive path fire, run this alongside `apps/filesystem` in the same sandbox (`--apps` flag — see [docs/multi-app-reference.md](../../docs/multi-app-reference.md)) and call `write_file` on the filesystem app; `code-editor`'s logs will show it reactively opening the new file.

## Testing

```bash
pnpm exec berth test
```
