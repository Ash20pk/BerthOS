# mysql

Lets an agent query a MySQL or MariaDB database you point it at: run SQL, list tables, describe them. It's read-only unless you say otherwise. Berth doesn't host the database. This connects to yours, and nothing else.

## Run it

Point it at a database with the `DATABASE_URL` secret and boot it:

```bash
DATABASE_URL=mysql://reader:...@db.example.com:3306/sales \
  berth os up db --apps=apps/mysql --env DATABASE_URL
```

Or from code: `Computer.boot({ apps: ["apps/mysql"], env: { DATABASE_URL } })`. As MCP tools: `berth mcp --app mysql --app-dir apps/mysql`. The agent never sees the connection string.

## Say where the database is

Edit `capabilities:` in `berth.yml`. There are two ways, and the difference matters:

| Your database is | Declare | What the sandbox allows |
|---|---|---|
| On the internet (PlanetScale, RDS or Cloud SQL with a public endpoint…) | `network:host:db.example.com:3306` and `network:connect:8090` | That host and port only, through the egress proxy |
| On a private network (a VPC, a Docker network, `localhost`) | `network:connect:3306` | Port 3306 to **any** host: the kernel sees ports, not hosts |

The egress proxy never connects to an internal address, which is why a private database needs the second form. The host itself still comes only from `DATABASE_URL`, which the agent can't change, but the sandbox no longer enforces it. If you pick the wrong form, the error says which line to add. Restart the app after editing.

## Read-only, and how far that goes

- **Default: read-only.** Every statement runs with the session set read-only and inside `START TRANSACTION READ ONLY … ROLLBACK`, so `INSERT`, `UPDATE`, `DELETE` and DDL (`CREATE`, `DROP`, `ALTER`) are all refused. Both are needed: MySQL commits DDL implicitly, outside any transaction, so the transaction alone doesn't stop a `DROP TABLE`. The session setting is reapplied on every call, so a statement that turns it off doesn't carry over. Set `MYSQL_MODE=read-write` in the sandbox's environment to allow changes.
- **One statement per call, in both modes.** Multi-statement support is off, so the server refuses `SELECT 1; DROP TABLE x`.
- **This is a guard in the connector, not in the database.** For a real guarantee, give `DATABASE_URL` a user with only `SELECT` on what the agent should see: the database then refuses everything else, whatever the mode.

## Exports

| Export | Input | Output |
|---|---|---|
| `query` | `{ sql, params }` | `{ columns, rows, row_count, truncated }`. `params` fills `?` placeholders in order; pass `[]` for none |
| `list_tables` | `{ schema }` | `{ tables: [{ schema, name, type }] }`. `""` means the URL's database |
| `describe_table` | `{ table }` | `{ columns: [{ name, type, nullable, default }] }`. `table` or `database.table` |
| `connection_info` | | `{ host, port, database, user, mode, route }`, never the password |

Results are capped at 500 rows and 200,000 characters, and each value at 10,000 characters; `truncated` says when either cut in. Dates come back as ISO strings, `BIGINT` and `DECIMAL` as strings so no precision is lost, and binary as `0x…` hex. Queries time out after 30 s.

## Other databases

[`postgres`](../postgres) is the same connector for PostgreSQL.
