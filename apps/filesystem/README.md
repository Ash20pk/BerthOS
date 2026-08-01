# filesystem

A resident app that reads and writes `/workspace`, and bridges files into the shared context bus and semantic FS so other apps can react to them.

## Exports

| Export | Input | Output | Does |
|---|---|---|---|
| `write_file` | `{ path: string, content: string }` | — | Writes a file under `/workspace`, then publishes `fs.file_created` on the context bus |
| `read_file` | `{ path: string }` | `{ content: string }` | Reads a file under `/workspace` |
| `list_files` | — | `{ files: string[] }` | Lists `/workspace`'s contents |
| `write_context_file` | `{ path: string, content: string }` | — | Writes a file under the semantic-fs mount (`/context`) |
| `tag_context_file` | `{ path: string, task: string, relatedApps: string[] }` | — | Tags a context file so it's queryable by intent |
| `query_context` | `{ text: string }` | `{ results: any[] }` | Queries the semantic FS by natural-language description |
| `probe_network_connect` | `{ host: string, port: number }` | `{ connected: boolean }` | Diagnostic: tries a raw TCP connect, used to verify deny-by-default network enforcement in CI |

## Capabilities

```yaml
capabilities:
  - filesystem:read:/workspace
  - filesystem:write:/workspace
  - filesystem:read:/context
  - filesystem:write:/context
```

No `network:connect:*` is declared, so under deny-by-default enforcement this app can never reach out over the network — `probe_network_connect` exists specifically so `capability-enforcement.mjs` can assert that from the outside.

## The context-bus / semantic-fs pattern

`write_file` publishes `fs.file_created` with `{ path, createdBy: "filesystem" }` after every write. [`apps/code-editor`](../code-editor/README.md) subscribes to that topic and reacts — no orchestration wires the two apps together; one just publishes and the other listens. This is the working example referenced from the root README's ["Talking to other apps"](../../README.md#talking-to-other-apps) section.

`write_context_file` / `tag_context_file` / `query_context` are the semantic-fs half: write something to `/context`, tag it with a task and related apps, and any app in the sandbox can later find it by describing what it needs rather than knowing the exact path. See [docs/semantic-fs-reference.md](../../docs/semantic-fs-reference.md).

## Running it

```bash
cd apps/filesystem
pnpm exec berth dev
```

## Testing

```bash
pnpm exec berth test
```

Runs `node --test dist/*.test.js` in addition to the standard export-schema validation.
