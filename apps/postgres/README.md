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
- **Each call starts from a clean session.** After every call the connection is rolled back and reset (`DISCARD ALL`) before it's reused, so a `SET` (say, `SET statement_timeout = 0`), an advisory lock, a temporary table or a transaction left open doesn't carry over to the next call. A `BEGIN` in one call and a `COMMIT` in the next is therefore not a transaction: in read-write mode each statement commits on its own.
- **A superuser is refused in read-only mode.** A read-only transaction doesn't stop what a superuser can do outside the data: `COPY … TO PROGRAM` runs a shell command on the database server, and `pg_reload_conf()`, `pg_terminate_backend()` and the like take effect whether or not the transaction rolls back. So in read-only mode the connector checks the role when it connects and refuses to serve (every export returns the error) if the role is a superuser, can `SET ROLE` to one, or is a member of `pg_execute_server_program` or `pg_write_server_files`. Set `POSTGRES_ALLOW_PRIVILEGED=true` to accept such a role anyway. Read-write mode doesn't check: it's asking for a role that can change things.
- **This is a guard in the connector, not in the database.** What a read-only transaction still allows, for a role that isn't refused above:
  - reading anything the role can see;
  - functions that act outside the transaction: `pg_cancel_backend()` and `pg_terminate_backend()` on the role's own other sessions (or on any non-superuser's, for a member of `pg_signal_backend`), and anything an extension such as `dblink` does over its own connection;
  - holding its connection, locks and CPU for up to the 30 s timeout (`pg_sleep`, a heavy query, a lock another session waits for).

  For a real guarantee, give `DATABASE_URL` a role that can only `SELECT` what the agent should see: the database then refuses everything else, whatever the mode.

## Exports

| Export | Input | Output |
|---|---|---|
| `query` | `{ sql, params }` | `{ columns, rows, row_count, truncated }`. `params` fills `$1`, `$2`…; pass `[]` for none |
| `list_tables` | `{ schema }` | `{ tables: [{ schema, name, type }] }`. `""` lists every non-system schema |
| `describe_table` | `{ table }` | `{ columns: [{ name, type, nullable, default }] }`. `table` or `schema.table`; a bare `table` is the one on the search path, as in a query |
| `connection_info` | | `{ host, port, database, user, mode, route }`, never the password |

Results are capped at 500 rows and 200,000 characters, and each value at 10,000 characters; `truncated` says when either cut in. Rows are fetched from the server through a cursor, a batch at a time, and the fetch stops at the cap, so a `SELECT` over millions of rows costs no more memory than one over a thousand. `row_count` is the rows returned for a statement that returns rows (so, when truncated, what came back rather than what matched), and the rows changed for one that doesn't. Dates come back as ISO strings, big integers as strings, and binary as `\x…` hex. Queries time out after 30 s.

## Other databases

This is the first database connector. MySQL is next; connectors for other engines will follow the same pattern: a declared `DATABASE_URL`, the same two network forms, read-only by default.
