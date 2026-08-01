# activity-feed

A resident app that fans context-bus events **in** from other first-party apps into one queryable feed — the mirror image of [`apps/code-editor`](../code-editor/README.md), which fans **out** by reacting to a single event.

## Export

| Export | Input | Output | Does |
|---|---|---|---|
| `get_recent_activity` | — | `{ events: Event[] }` | Returns up to the last 50 events, most-recent-first. Each `Event` is `{ topic, payload, receivedAt }`. |

## Capabilities

```yaml
capabilities: []
```

None — this app only listens on the context bus, which every app gets regardless of declared capabilities.

## What it subscribes to

The context bus has no wildcard subscribe (see [docs/context-bus-reference.md](../../docs/context-bus-reference.md)), so fanning in means naming every topic another first-party app is known to publish — the same explicit-topic-string dependency `apps/code-editor` already has on `apps/filesystem`'s `fs.file_created`:

| Topic | Published by |
|---|---|
| `fs.file_created` | [`apps/filesystem`](../filesystem/README.md) (`write_file`) |
| `notes.added` | [`apps/notes`](../notes/README.md) (`add_note`) |
| `notes.completed` | [`apps/notes`](../notes/README.md) (`complete_note`) |

## Known limitations

Same as `apps/code-editor`'s: no message replay (a subscriber only sees events published after it subscribes) and a publisher never gets its own event echoed back. The feed itself is in-memory only — it resets on restart, and only the most recent 50 events are kept.

## Running it

Only interesting alongside apps that actually publish something. In multi-app mode (see [docs/multi-app-reference.md](../../docs/multi-app-reference.md)):

```bash
cd apps/activity-feed
pnpm exec berth dev --apps=apps/filesystem,apps/notes
```

Call `apps/filesystem`'s `write_file` or `apps/notes`' `add_note`/`complete_note`, then call this app's `get_recent_activity` (e.g. via `berth rpc` or the MCP bridge) to see them show up.

## Testing

```bash
pnpm exec berth test
```

`src/index.test.ts` drives the app against `@berth/sdk`'s local (in-process) context bus directly — the same fallback the real runtime uses when no daemon is reachable — publishing across all three known topics and asserting ordering and the 50-event cap.
