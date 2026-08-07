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
| `probe_network_udp` | `{ host: string, port: number }` | `{ sent: boolean }` | Diagnostic: tries a UDP `send()`, which Landlock cannot restrict — verifies agent-init's seccomp filter |
| `probe_raw_socket` | `{ host: string }` | `{ opened: boolean }` | Diagnostic: shells out to `ping`, verifying that raw/ICMP sockets are refused (`CAP_NET_RAW` dropped) |

## Capabilities

```yaml
capabilities:
  - filesystem:read:/workspace
  - filesystem:write:/workspace
  - filesystem:read:/context
  - filesystem:write:/context
```

No `network:connect:*` is declared, so under deny-by-default enforcement this app can never reach out over the network — `probe_network_connect` exists specifically so `capability-enforcement.mjs` can assert that from the outside.

That takes two mechanisms, not one. Landlock stops the TCP connect; it has no access right for UDP, ICMP, or raw sockets, so `agent-init` additionally drops `CAP_NET_RAW` and installs a seccomp filter refusing `socket(AF_INET|AF_INET6, SOCK_DGRAM|SOCK_RAW)` and `AF_PACKET` for apps in exactly this position. `probe_network_udp` and `probe_raw_socket` assert that half. Unlike the Landlock probes, they are expected to be denied even on Docker Desktop's kernel, where Landlock is inactive.

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
