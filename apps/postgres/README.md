# postgres

Lets an agent query a PostgreSQL database you point it at: run SQL, list tables, describe them. It's read-only unless you say otherwise. Berth doesn't host the database. This connects to yours, and nothing else.

## Run it

Point it at a database with the `DATABASE_URL` secret and boot it:

```bash
DATABASE_URL=postgres://reader:...@db.example.com:5432/sales \
  berth os up pg --apps=apps/postgres --env DATABASE_URL
```

Or from code: `Computer.boot({ apps: ["apps/postgres"], env: { DATABASE_URL } })`. As MCP tools: `berth mcp --app postgres --app-dir apps/postgres`. The agent never sees the connection string.

## Say where the database is

Edit `capabilities:` in `berth.yml`. There are two ways, and the difference matters:

| Your database is | Declare | What the sandbox allows |
|---|---|---|
| On the internet (Neon, Supabase, RDS with a public endpoint…) | `network:host:db.example.com:5432` and `network:connect:8090` | That host and port only, through the egress proxy |
| On a private network (a VPC, a Docker network, `localhost`) | `network:connect:5432` | Port 5432 to **any** host: the kernel sees ports, not hosts |

The egress proxy never connects to an internal address, which is why a private database needs the second form. The host itself still comes only from `DATABASE_URL`, which the agent can't change, but the sandbox no longer enforces it. If you pick the wrong form, the error says which line to add. Restart the app after editing.

## Read-only, and how far that goes

- **Default: read-only.** Every statement runs inside `BEGIN READ ONLY … ROLLBACK`, so `INSERT`, `UPDATE`, `DELETE` and DDL are refused. Set `POSTGRES_MODE=read-write` in the sandbox's environment to allow changes.
- **One statement per call, in both modes.** Queries use PostgreSQL's extended protocol, which refuses a string holding several statements, so `SELECT 1; DROP TABLE x` doesn't run.
- **This is a guard in the connector, not in the database.** A read-only transaction still allows reading anything the role can see, and functions with side effects. For a real guarantee, give `DATABASE_URL` a role that can only `SELECT` what the agent should see: the database then refuses everything else, whatever the mode.

## Exports

| Export | Input | Output |
|---|---|---|
| `query` | `{ sql, params }` | `{ columns, rows, row_count, truncated }`. `params` fills `$1`, `$2`…; pass `[]` for none |
| `list_tables` | `{ schema }` | `{ tables: [{ schema, name, type }] }`. `""` lists every non-system schema |
| `describe_table` | `{ table }` | `{ columns: [{ name, type, nullable, default }] }`. `table` or `schema.table` |
| `connection_info` | | `{ host, port, database, user, mode, route }`, never the password |

Results are capped at 500 rows and 200,000 characters, and each value at 10,000 characters; `truncated` says when either cut in. Dates come back as ISO strings, big integers as strings, and binary as `\x…` hex. Queries time out after 30 s.

## Other databases

This is the first database connector. MySQL is next; connectors for other engines will follow the same pattern: a declared `DATABASE_URL`, the same two network forms, read-only by default.
