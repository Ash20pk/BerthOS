# activity-feed

Gives an agent one place to see what the other apps in its sandbox just did. It listens for events from [`filesystem`](../filesystem) and [`notes`](../notes) on the context bus and keeps them in a feed the agent can query.

## Run it

It's only useful next to apps that publish events, so run it with them in one sandbox:

```bash
cd apps/activity-feed
berth dev --apps=apps/filesystem,apps/notes
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone. `--apps` paths are relative to the repo root; see [multi-app sandboxes](../../docs/multi-app-reference.md).

Then make something happen and read the feed:

```bash
berth rpc notes --container berth-dev-activity-feed --export add_note --input '{"text":"ship it"}'
berth rpc activity-feed --export get_recent_activity
```

`berth test` runs the app's tests, which drive it against the SDK's in-process context bus.

## Capabilities

```yaml
capabilities: []
```

None. Every app can use the context bus without declaring anything.

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `get_recent_activity` | | `{ events: Event[] }` | Returns up to the last 50 events, newest first. Each is `{ topic, payload, receivedAt }`. |

## Topics it listens to

The context bus has no wildcard subscribe, so the app names each topic:

| Topic | Published by |
|---|---|
| `fs.file_created` | `filesystem` (`write_file`) |
| `notes.added` | `notes` (`add_note`) |
| `notes.completed` | `notes` (`complete_note`) |

## Limits

- It only sees events published after it subscribed. There is no replay.
- The feed is in memory: it keeps the latest 50 events and resets on restart.
