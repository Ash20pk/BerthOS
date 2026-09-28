# filesystem

Gives an agent a folder to read and write: `/workspace`. It also writes to the shared `/context` folder, where other apps can find files by what they're for, and announces every new file on the context bus.

## Run it

```bash
cd apps/filesystem
berth dev      # boots it in a sandbox, reloads on save
berth test     # builds the production image, checks the exports, runs the app's own tests
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone. Call an export with `berth rpc filesystem --export list_files`, or connect an MCP client with `berth mcp --app filesystem` (add `--only=read_file,write_file,list_files` to bridge just those exports). See the [MCP quickstart](../../docs/mcp-quickstart.md).

## Capabilities

```yaml
capabilities:
  - filesystem:read:/workspace
  - filesystem:write:/workspace
  - filesystem:read:/context
  - filesystem:write:/context
```

No `network:*` capability is declared, so the app can't open any outbound connection. The kernel refuses TCP (Landlock), UDP and raw sockets (seccomp, plus a dropped `CAP_NET_RAW`).

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `write_file` | `{ path, content }` | | Writes a file under `/workspace`, then publishes `fs.file_created` |
| `read_file` | `{ path }` | `{ content }` | Reads a file under `/workspace` |
| `list_files` | | `{ files: string[] }` | Lists `/workspace` |
| `write_context_file` | `{ path, content }` | | Writes a file under `/context` |
| `read_context_file` | `{ path }` | `{ content }` | Reads a file under `/context` |
| `tag_context_file` | `{ path, task, relatedApps: string[] }` | | Tags a `/context` file so `query_context` can find it |
| `query_context` | `{ text }` | `{ results: [] }` | Searches `/context` by tag text and returns metadata for each match |
| `publish_context_event` | `{ topic, payload }` | | Publishes any event on the context bus |

## Working with other apps

- **Context bus.** After every `write_file`, the app publishes `fs.file_created` with `{ path, createdBy: "filesystem" }`. [`code-editor`](../code-editor) and [`activity-feed`](../activity-feed) subscribe to it. See [Talking to other apps](../../docs/resident-apps.md#talking-to-other-apps).
- **Semantic FS.** Write a file to `/context`, tag it with a task and related apps, and any app in the sandbox can find it later by describing what it needs. Search ranks over the tag text, the path and `created_by`, never the file contents, so tag what you want found. `query_context` returns metadata only; call `read_context_file` for each hit you need. See [semantic FS](../../docs/semantic-fs-reference.md#query-semantics--hybrid-keyword--embedding-similarity).
