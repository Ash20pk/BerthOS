# notes

Gives an agent a notes list that survives restarts. Notes are saved as JSON in `/workspace`, and each add and completion is announced on the context bus.

## Run it

```bash
cd apps/notes
berth dev
berth test
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone. Call it with `berth rpc notes --export add_note --input '{"text":"buy milk"}'`. The [quickstart](../../docs/quickstart.md#run-a-resident-app-directly) walks through it as the step after `hello-world`.

## Capabilities

```yaml
capabilities:
  - filesystem:write:/workspace
```

A write outside `/workspace` is refused by the kernel.

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `add_note` | `{ text }` | `{ id }` | Adds a note to `notes.json` and publishes `notes.added` |
| `list_notes` | | `{ notes: Note[] }` | Returns every note as `{ id, text, completed }` |
| `complete_note` | `{ id }` | `{ completed: boolean }` | Marks a note done and publishes `notes.completed`. An unknown `id` returns `{ completed: false }` instead of an error, so retries are safe. |

## Context bus events

| Topic | Payload | Published by |
|---|---|---|
| `notes.added` | `{ id, text }` | `add_note` |
| `notes.completed` | `{ id }` | `complete_note` |

Other apps in the sandbox can react to these without polling `list_notes`. [`activity-feed`](../activity-feed) subscribes to both. See the [context bus reference](../../docs/context-bus-reference.md).
