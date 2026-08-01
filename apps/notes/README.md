# notes

A stateful resident app — persists notes to `/workspace` as JSON and publishes their lifecycle to the context bus.

## Exports

| Export | Input | Output | Does |
|---|---|---|---|
| `add_note` | `{ text: string }` | `{ id: string }` | Appends a note to `notes.json`, publishes `notes.added` |
| `list_notes` | — | `{ notes: Note[] }` | Returns every note (`{ id, text, completed }`) |
| `complete_note` | `{ id: string }` | `{ completed: boolean }` | Marks a note completed, publishes `notes.completed`. Idempotent — an unknown `id` returns `{ completed: false }` rather than throwing, so an agent retrying a completed/already-gone note doesn't get a hard failure. |

## Capabilities

```yaml
capabilities:
  - filesystem:write:/workspace
```

One capability beyond `hello-world`'s zero-capability baseline — enough to prove `filesystem:write:/workspace` is actually Landlock-enforced, not just a convention: writing outside `/workspace` is refused at the kernel level. See [docs/capability-tokens-reference.md](../../docs/capability-tokens-reference.md).

## Context bus events

`add_note` and `complete_note` each publish afterward — `notes.added` (`{ id, text }`) and `notes.completed` (`{ id }`) — so another app in the same sandbox can react without polling `list_notes`. [`apps/activity-feed`](../activity-feed/README.md) subscribes to both, alongside `apps/filesystem`'s `fs.file_created`, as a working example of one app fanning in events from several others. See [docs/context-bus-reference.md](../../docs/context-bus-reference.md).

## Running it

```bash
cd apps/notes
pnpm exec berth dev
```

This is also the walkthrough's second step after `hello-world` — see [docs/getting-started.md](../../docs/getting-started.md#3-run-the-notes-app-a-resident-app-with-a-real-capability).

## Testing

```bash
pnpm exec berth test
```

`src/index.test.ts` covers `add_note`/`list_notes`/`complete_note` against a temp `BERTH_WORKSPACE_ROOT`, including the idempotent-unknown-id case.
