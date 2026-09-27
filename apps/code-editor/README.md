# code-editor

Gives an agent read-only access to files in `/workspace`. It also opens files on its own when another app announces them, with no one telling it to: the working example of apps cooperating over the context bus.

## Run it

```bash
cd apps/code-editor
berth dev
berth test
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone.

To see the reactive path, run it with [`filesystem`](../filesystem) in the same sandbox and write a file:

```bash
berth dev --apps=apps/filesystem
berth rpc filesystem --container berth-dev-code-editor --export write_file --input '{"path":"hello.txt","content":"hi"}'
```

`code-editor`'s log then shows it opening `hello.txt`. `--apps` paths are relative to the repo root; see [multi-app sandboxes](../../docs/multi-app-reference.md).

## Capabilities

```yaml
capabilities:
  - filesystem:read:/workspace
```

Read-only. The app can't write anywhere.

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `open_file` | `{ path }` | `{ content }` | Reads a file under `/workspace` |

## Reacting to other apps

When it starts, the app subscribes to `fs.file_created`. `filesystem` publishes that event on every `write_file`, and `code-editor` opens the new file in response:

```
filesystem --publish("fs.file_created", { path, createdBy })--> context bus --> code-editor
```

See the [context bus reference](../../docs/context-bus-reference.md).

## Limits

- A subscriber only sees events published after it subscribed. There is no replay.
