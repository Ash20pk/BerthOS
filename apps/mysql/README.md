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

## Encrypt the connection

The connector doesn't use TLS unless `DATABASE_URL` asks for it, so by default the password and every row cross the network in the clear. For any database that isn't on the same machine or a private network you trust, add `ssl=true`:

```
mysql://reader:...@db.example.com:3306/sales?ssl=true
```

That verifies the server's certificate against the system's trusted CAs, and its name against the host. `sslmode=REQUIRED` (or `VERIFY_IDENTITY`, or `require`) means the same; `sslmode=DISABLED` turns it off. For a server whose certificate can't be verified (a self-signed one on a private network), `ssl={"rejectUnauthorized":false}`, URL-encoded, encrypts without checking who's at the other end. Through the egress proxy TLS still runs end to end: the proxy only carries the bytes. The connector writes a warning to stderr when it connects to a host that isn't a local or private address without TLS.

## Read-only, and how far that goes

- **Default: read-only.** Every statement runs with the session set read-only and inside `START TRANSACTION READ ONLY … ROLLBACK`, so `INSERT`, `UPDATE`, `DELETE` and DDL (`CREATE`, `DROP`, `ALTER`) are all refused. Both are needed: MySQL commits DDL implicitly, outside any transaction, so the transaction alone doesn't stop a `DROP TABLE`. The session setting is reapplied on every call, so a statement that turns it off doesn't carry over. Set `MYSQL_MODE=read-write` in the sandbox's environment to allow changes.
- **One statement per call, in both modes.** Multi-statement support is off, so the server refuses `SELECT 1; DROP TABLE x`. The connection settings are built from `DATABASE_URL`'s host, port, user, password and database, not handed to the driver whole, so an option in the URL such as `?multipleStatements=true` can't turn it back on: the only options read are `ssl` and `sslmode` (above), and any others are ignored, with a warning on stderr.
- **Each call starts from a clean session.** After every call the connection is reset (`COM_RESET_CONNECTION`) before it's reused, so a `SET SESSION` (say, of `sql_mode`), a user variable, a `GET_LOCK()` lock, a temporary table or a transaction left open doesn't carry over to the next call. A `START TRANSACTION` in one call and a `COMMIT` in the next is therefore not a transaction: in read-write mode each statement commits on its own.
- **A statement that runs out of time is stopped, not just abandoned.** Queries time out after 30 s. The server's own limit comes first where there is one (MySQL's `max_execution_time`, which covers `SELECT` only; MariaDB's `max_statement_time`, which covers every statement); otherwise the connector has the server end the query with `KILL CONNECTION` from a separate connection. In read-write mode each statement runs inside a transaction that's committed only once it has finished within the limit, so a write that runs out of time isn't kept, even where `KILL` can't stop it (MySQL lets `SLEEP()` swallow one and the statement carry on). Only DDL, which MySQL commits as it goes, and a write to a table without transactions (MyISAM) can be kept regardless; the error says so. The same goes for a result cut off at the cap below: the statement is stopped there and, in read-write mode, not committed, so a `CALL` or MariaDB's `INSERT … RETURNING` that returns more than 500 rows keeps none of its changes (a `SELECT` loses nothing).
- **An administrator is refused in read-only mode.** The read-only session and transaction stop changes to data and schema, not what a privileged user can do to the server: as `root`, `SELECT … INTO OUTFILE` writes a file on the database server, `SET GLOBAL` and `SET PERSIST` change its settings, and `FLUSH PRIVILEGES`, `KILL` of other users' sessions and `PURGE BINARY LOGS` all run. So in read-only mode the connector reads the user's grants, and those of every role it holds (nested roles too, and on MariaDB as well as MySQL), when it connects, and refuses to serve (every export returns the error) if it holds a global `ALL PRIVILEGES`, `SUPER`, `FILE`, `RELOAD`, `SHUTDOWN`, `FLUSH_*` or `*_ADMIN` privilege. Set `MYSQL_ALLOW_PRIVILEGED=true` to accept such a user anyway. Read-write mode doesn't check: it's asking for a user that can change things.
- **This is a guard in the connector, not in the database.** What read-only mode still allows, for a user that isn't refused above:
  - reading anything the user can see;
  - `GET_LOCK()` and `LOCK TABLES … READ`, which make other sessions wait until the call ends;
  - `KILL` of the same user's other sessions;
  - `COMMIT`, which ends the read-only transaction early but leaves the session read-only, and nothing else runs in that call;
  - holding its connection, locks and CPU for up to the 30 s timeout (`SLEEP()`, a heavy query).

  For a real guarantee, give `DATABASE_URL` a user with only `SELECT` on what the agent should see: the database then refuses everything else, whatever the mode.

## Exports

| Export | Input | Output |
|---|---|---|
| `query` | `{ sql, params }` | `{ columns, rows, row_count, truncated }`. `params` fills `?` placeholders in order; pass `[]` for none. The driver escapes each value and writes it into the SQL before sending it (client side, not a server-side prepared statement): a `?` is a value, `??` an identifier, an array becomes a comma-separated list, and a `?` inside a quoted string is left alone |
| `list_tables` | `{ schema }` | `{ tables: [{ schema, name, type }] }`. `""` means the URL's database (an error if the URL names none) |
| `describe_table` | `{ table }` | `{ columns: [{ name, type, nullable, default }] }`. `table` or `database.table` |
| `connection_info` | | `{ host, port, database, user, mode, route }`, never the password |

Results are capped at 500 rows and 200,000 characters, and each value at 10,000 characters; `truncated` says when either cut in. Rows are read from the server one at a time and the read stops at the cap (the connection is then closed rather than drained), so a `SELECT` over millions of rows costs no more memory than one over a thousand. `row_count` is the rows returned for a statement that returns rows (so, when truncated, what came back rather than what matched), and the rows changed for one that doesn't. A `CALL` returns its procedure's first result set. `DATE`, `DATETIME` and `TIMESTAMP` values come back as the text MySQL sends (`2026-01-04`, `2026-01-04 10:30:00`, a `TIMESTAMP` in the session's `time_zone`), so no time zone of the app's shifts them; `BIGINT` and `DECIMAL` as strings so no precision is lost, and binary as `0x…` hex. Queries time out after 30 s (see above).

## Other databases

[`postgres`](../postgres) is the same connector for PostgreSQL.
