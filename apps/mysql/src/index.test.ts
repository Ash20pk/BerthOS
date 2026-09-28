import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { allowsPrivileged, cell, Collector, configOf, modeFrom, privilegeProblem, riskyPrivileges, routeFor, shapeRows, targetOf } from "./index.js";
import { ProxyTunnel } from "./tunnel.js";

// --- pure: no database needed ------------------------------------------------

test("targetOf reads host, port, database and user, and never the password", () => {
  const t = targetOf("mysql://app%40corp:s3cret@db.example.com:6543/sales");
  assert.deepEqual(t, { host: "db.example.com", port: 6543, database: "sales", user: "app@corp" });
  assert.ok(!JSON.stringify(t).includes("s3cret"));
  assert.equal(targetOf("mysql://u@h/").port, 3306);
  assert.throws(() => targetOf("postgres://u@h/db"), /should start with mysql:\/\//);
  assert.throws(() => targetOf("not a url"), /isn't a valid URL/);
});

test("configOf builds the settings from the URL's parts, reading only its TLS options", () => {
  const { config, ignored } = configOf("mysql://app%40corp:p%40ss@db.example.com:3307/sales?multipleStatements=true&ssl=true&flags=-FOUND_ROWS");
  assert.deepEqual(config, { host: "db.example.com", port: 3307, user: "app@corp", password: "p@ss", database: "sales", ssl: { rejectUnauthorized: true } });
  assert.ok(!("multipleStatements" in config));
  assert.deepEqual(ignored, ["multipleStatements", "flags"]);
  assert.equal(configOf("mysql://u:p@h/db").config.ssl, undefined, "no TLS unless asked");
  assert.deepEqual(configOf("mysql://u:p@h/db?sslmode=REQUIRED").config.ssl, { rejectUnauthorized: true });
  assert.equal(configOf("mysql://u:p@h/db?sslmode=disabled").config.ssl, undefined);
  assert.deepEqual(configOf('mysql://u:p@h/db?ssl={"rejectUnauthorized":false}').config.ssl, { rejectUnauthorized: false });
  assert.equal(configOf("mysql://u:p@h/").config.database, undefined);
  assert.throws(() => configOf("mysql://u:p@h/db?ssl=maybe"), /ssl=maybe isn't understood/);
});

test("routeFor goes through the proxy for a declared public host, direct for a declared port, and refuses otherwise", () => {
  const pub = targetOf("mysql://u:p@db.example.com:3306/x");
  assert.equal(routeFor(pub, ["network:host:db.example.com:3306", "network:connect:8090"], "http://127.0.0.1:8090").kind, "proxy");
  assert.equal(routeFor(pub, ["network:connect:3306"], undefined).kind, "direct");
  assert.throws(() => routeFor(pub, ["network:host:other.example.com:3306"], "http://127.0.0.1:8090"), /doesn't allow.*network:host:db\.example\.com:3306.*network:connect:3306/s);

  const priv = targetOf("mysql://u:p@10.0.3.7:3306/x");
  assert.equal(routeFor(priv, ["network:connect:3306"], "http://127.0.0.1:8090").kind, "direct", "an internal address never goes through the proxy");
  assert.throws(() => routeFor(priv, ["network:host:10.0.3.7:3306"], "http://127.0.0.1:8090"), /internal address.*network:connect:3306/s);
});

test("the mode is read-only unless MYSQL_MODE says read-write", () => {
  assert.equal(modeFrom({}), "read-only");
  assert.equal(modeFrom({ MYSQL_MODE: "yes" }), "read-only");
  assert.equal(modeFrom({ MYSQL_MODE: "read-write" }), "read-write");
});

test("the risky global privileges are picked out of SHOW GRANTS, with what they allow and how to opt in", () => {
  const root = [
    "GRANT SELECT, INSERT, RELOAD, SHUTDOWN, PROCESS, FILE, SUPER, CREATE ROLE ON *.* TO `root`@`%` WITH GRANT OPTION",
    "GRANT APPLICATION_PASSWORD_ADMIN,BINLOG_ADMIN,FLUSH_PRIVILEGES,SHOW_ROUTINE,SYSTEM_VARIABLES_ADMIN ON *.* TO `root`@`%` WITH GRANT OPTION",
    "GRANT PROXY ON ``@`` TO `root`@`%` WITH GRANT OPTION",
  ];
  assert.deepEqual(riskyPrivileges(root), ["RELOAD", "SHUTDOWN", "FILE", "SUPER", "APPLICATION_PASSWORD_ADMIN", "BINLOG_ADMIN", "FLUSH_PRIVILEGES", "SYSTEM_VARIABLES_ADMIN"]);
  assert.deepEqual(riskyPrivileges(["GRANT ALL PRIVILEGES ON *.* TO `admin`@`%`"]), ["ALL PRIVILEGES"]);
  assert.deepEqual(riskyPrivileges(["GRANT BINLOG ADMIN ON *.* TO `m`@`%`"]), ["BINLOG ADMIN"], "MariaDB spells them with spaces");
  // Everything on one database, and nothing global but USAGE: fine.
  assert.deepEqual(riskyPrivileges(["GRANT USAGE ON *.* TO `app`@`%`", "GRANT ALL PRIVILEGES ON `shop`.* TO `app`@`%`", "GRANT `analyst`@`%` TO `app`@`%`"]), []);
  assert.equal(privilegeProblem("app", []), undefined);
  assert.match(privilegeProblem("root", ["FILE", "SUPER"])!, /root has global privileges \(FILE, SUPER\).*INTO OUTFILE.*MYSQL_ALLOW_PRIVILEGED=true/s);
  assert.equal(allowsPrivileged({}), false);
  assert.equal(allowsPrivileged({ MYSQL_ALLOW_PRIVILEGED: "true" }), true);
});

test("results are capped by row count and size, and values are JSON-safe", () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ id: i }));
  const shaped = shapeRows(many);
  assert.equal(shaped.rows.length, 500);
  assert.equal(shaped.truncated, true);
  assert.equal(cell(new Date("2026-01-04T00:00:00Z")), "2026-01-04T00:00:00.000Z");
  assert.equal(cell(BigInt("9007199254740993")), "9007199254740993");
  assert.equal(cell(Buffer.from([0xde, 0xad])), "0xdead");
  assert.equal((cell("x".repeat(20_000)) as string).length, 10_001);
});

test("the collector stops taking rows once it's full, by count or by size", () => {
  const byCount = new Collector(3);
  assert.deepEqual([1, 2, 3, 4, 5].map((id) => byCount.add({ id })), [true, true, true, false, false]);
  assert.equal(byCount.rows.length, 3);
  assert.equal(byCount.truncated, true);

  const exact = shapeRows([{ id: 1 }, { id: 2 }], 2);
  assert.deepEqual(exact, { rows: [{ id: 1 }, { id: 2 }], truncated: false }, "exactly the cap isn't truncated");

  const bySize = new Collector();
  let taken = 0;
  while (bySize.add({ text: "x".repeat(9_000) })) taken++;
  assert.equal(bySize.truncated, true);
  assert.ok(taken < 25, `took ${taken} rows of 9,000 characters under a 200,000-character cap`);
});

// Every socket method a driver may call on its stream: a missing one is a
// crash on the path that uses it (ref() was, for apps/postgres).
test("the tunnel has every socket method a driver calls", () => {
  const tunnel = new ProxyTunnel(new URL("http://127.0.0.1:1")) as unknown as Record<string, unknown>;
  for (const method of ["connect", "cork", "uncork", "destroy", "end", "write", "on", "once", "ref", "unref", "setKeepAlive", "setNoDelay"]) {
    assert.equal(typeof tunnel[method], "function", method);
  }
});

// --- against a real database, when MYSQL_TEST_URL is set ----------------------
// e.g. docker run -d -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=shop -p 127.0.0.1:53306:3306 mysql:8.4
// MYSQL_TEST_URL=mysql://root:test@127.0.0.1:53306/shop, an administrator:
// the suite creates what it needs itself (a customers table holding three
// rows, a user app/app with every privilege on that database and none
// beyond it, and a user reader/reader that can only SELECT the table), and
// connects as those users, not as the administrator.

const TEST_URL = process.env.MYSQL_TEST_URL;
const live = (name: string, fn: () => Promise<void>) => test(name, { skip: !TEST_URL && "set MYSQL_TEST_URL to run against a real database" }, fn);

/** MYSQL_TEST_URL, as another user. */
function urlAs(user: string): string {
  const url = new URL(TEST_URL!);
  url.username = user;
  url.password = user;
  return url.toString();
}

async function admin<T>(fn: (db: mysql.Connection) => Promise<T>): Promise<T> {
  const db = await mysql.createConnection(TEST_URL!);
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

before(async () => {
  if (!TEST_URL) return;
  const database = new URL(TEST_URL).pathname.slice(1);
  await admin(async (db) => {
    for (const user of ["app", "reader"]) {
      await db.query(`CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${user}'`);
    }
    await db.query(`GRANT ALL ON \`${database}\`.* TO 'app'@'%'`);
    await db.query("DROP TABLE IF EXISTS customers");
    await db.query("CREATE TABLE customers (id int AUTO_INCREMENT PRIMARY KEY, name varchar(100) NOT NULL, signed_up date NOT NULL DEFAULT (CURRENT_DATE), plan varchar(20) NOT NULL DEFAULT 'free')");
    await db.query("INSERT INTO customers (name, signed_up, plan) VALUES ('Ada', '2026-01-04', 'pro'), ('Grace', '2026-02-11', 'free'), ('Linus', '2026-03-20', 'pro')");
    await db.query("GRANT SELECT ON customers TO 'reader'@'%'");
    await db.query("DROP PROCEDURE IF EXISTS customer_names");
    await db.query("CREATE PROCEDURE customer_names(IN p varchar(20)) SELECT name FROM customers WHERE plan = p ORDER BY id");
    await db.query("DROP PROCEDURE IF EXISTS two_sets");
    await db.query("CREATE PROCEDURE two_sets() BEGIN SELECT 1 AS a; SELECT 2 AS b, 3 AS c; END");
  });
});

async function appWith(env: Record<string, string | undefined>, capabilities: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "mysql-app-test-"));
  await writeFile(join(dir, "berth.yml"), `name: mysql\nversion: 0.1.0\ncapabilities:\n${capabilities.map((c) => `  - ${c}`).join("\n")}\nexports: []\n`);
  for (const k of ["DATABASE_URL", "MYSQL_MODE", "MYSQL_ALLOW_PRIVILEGED", "BERTH_EGRESS_PROXY_URL"]) delete process.env[k];
  Object.assign(process.env, { BERTH_MANIFEST_PATH: join(dir, "berth.yml") }, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));
  // A fresh module per configuration: the pool is created once per process.
  const mod = await import(`./index.js?case=${Math.random()}`);
  after(() => mod.closeForTests());
  const call = (name: string, input: unknown = {}) => mod.default._exports.get(name)!.handler(input) as Promise<any>;
  return call;
}

live("query, list_tables and describe_table against a real database", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  const res = await call("query", { sql: "SELECT name, plan FROM customers WHERE plan = ? ORDER BY id", params: ["pro"] });
  assert.deepEqual(res.columns, ["name", "plan"]);
  assert.deepEqual(res.rows, [{ name: "Ada", plan: "pro" }, { name: "Linus", plan: "pro" }]);
  assert.ok((await call("list_tables", { schema: "" })).tables.some((t: any) => t.name === "customers"));
  assert.deepEqual((await call("describe_table", { table: "customers" })).columns.map((c: any) => c.name), ["id", "name", "signed_up", "plan"]);
  const info = await call("connection_info");
  assert.deepEqual({ mode: info.mode, route: info.route, user: info.user }, { mode: "read-only", route: "direct", user: "app" });
});

live("read-only mode refuses writes, even ones that try to switch the transaction", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  await assert.rejects(call("query", { sql: "INSERT INTO customers (name) VALUES ('Mallory')", params: [] }), /read-only/);
  await assert.rejects(call("query", { sql: "SET SESSION TRANSACTION READ WRITE", params: [] }).then(() => call("query", { sql: "DELETE FROM customers", params: [] })), /read-only/);
  await assert.rejects(call("query", { sql: "SELECT 1; DELETE FROM customers", params: [] }), /one statement per query/);
  assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
});

// MySQL commits DDL implicitly, outside any transaction, so a read-only
// transaction alone let CREATE and DROP TABLE through for a user allowed to
// run them. Run as app, which may, so no grant gets in the way.
live("read-only mode refuses DDL too, and can't be switched off by a statement", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  await assert.rejects(call("query", { sql: "CREATE TABLE berth_ddl_probe (x int)", params: [] }), /read-only/);
  await assert.rejects(call("query", { sql: "DROP TABLE customers", params: [] }), /read-only/);
  await call("query", { sql: "SET SESSION transaction_read_only = OFF", params: [] });
  await assert.rejects(call("query", { sql: "DROP TABLE customers", params: [] }), /read-only/);
  assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
});

live("multipleStatements=true in DATABASE_URL doesn't turn multi-statement strings back on", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: `${urlAs("app")}?multipleStatements=true`, MYSQL_MODE: "read-write" }, [`network:connect:${port}`]);
  await assert.rejects(call("query", { sql: "SELECT 1; DELETE FROM customers", params: [] }), /one statement per query/);
  assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
});

live("ssl in DATABASE_URL encrypts the connection", async () => {
  const port = new URL(TEST_URL!).port;
  // The test server's certificate is self-signed, so this one isn't verified.
  const call = await appWith({ DATABASE_URL: `${urlAs("app")}?ssl=${encodeURIComponent('{"rejectUnauthorized":false}')}` }, [`network:connect:${port}`]);
  const res = await call("query", { sql: "SHOW SESSION STATUS LIKE 'Ssl_cipher'", params: [] });
  assert.notEqual(res.rows[0].Value, "", "a TLS cipher is in use");
  // Verified, a self-signed certificate is refused.
  const strict = await appWith({ DATABASE_URL: `${urlAs("app")}?ssl=true` }, [`network:connect:${port}`]);
  await assert.rejects(strict("query", { sql: "SELECT 1", params: [] }), /self[- ]signed|certificate/i);
});

live("read-write mode can change data, one statement at a time", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app"), MYSQL_MODE: "read-write" }, [`network:connect:${port}`]);
  const inserted = await call("query", { sql: "INSERT INTO customers (name, plan) VALUES (?, ?)", params: ["Temp", "free"] });
  assert.equal(inserted.row_count, 1);
  assert.equal((await call("query", { sql: "UPDATE customers SET plan = 'pro' WHERE plan = ?", params: ["free"] })).row_count, 2);
  await call("query", { sql: "UPDATE customers SET plan = 'free' WHERE name IN ('Grace', 'Temp')", params: [] });
  await call("query", { sql: "DELETE FROM customers WHERE name = ?", params: ["Temp"] });
  await assert.rejects(call("query", { sql: "SELECT 1; SELECT 2", params: [] }), /one statement per query/);
});

live("a huge result is read a row at a time, never all into memory", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  await call("query", { sql: "SELECT 1", params: [] });
  const before = process.memoryUsage().rss;
  const started = Date.now();
  // 3,000,000 rows of ~500 bytes: ~1.5 GB if mysql2 buffered it, as it did.
  const digits = "SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9";
  const sql = `WITH d AS (${digits}) SELECT a.n, REPEAT('x', 500) AS pad FROM d a, d b, d c, d e, d f, d g, (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2) h`;
  const res = await call("query", { sql, params: [] });
  assert.equal(res.truncated, true);
  assert.ok(res.rows.length <= 500);
  assert.deepEqual(res.columns, ["n", "pad"]);
  const grown = (process.memoryUsage().rss - before) / 1e6;
  assert.ok(grown < 150, `rss grew ${grown.toFixed(0)} MB`);
  assert.ok(Date.now() - started < 10_000, "stopped early rather than reading every row");
  // The abandoned connection was closed, not handed out again mid-result.
  for (let i = 0; i < 3; i++) assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
  const exact = await call("query", { sql: `WITH d AS (${digits}) SELECT a.n FROM d a, d b, (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) c`, params: [] });
  assert.deepEqual({ n: exact.rows.length, truncated: exact.truncated, row_count: exact.row_count }, { n: 500, truncated: false, row_count: 500 });
});

live("CALL returns the procedure's rows, not its result sets jumbled together", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  const res = await call("query", { sql: "CALL customer_names(?)", params: ["pro"] });
  assert.deepEqual({ columns: res.columns, rows: res.rows, row_count: res.row_count }, { columns: ["name"], rows: [{ name: "Ada" }, { name: "Linus" }], row_count: 2 });
  const two = await call("query", { sql: "CALL two_sets()", params: [] });
  assert.deepEqual({ columns: two.columns, rows: two.rows }, { columns: ["a"], rows: [{ a: "1" }] }, "the first result set (a literal is a BIGINT, so a string)");
});

live("a call's session settings and locks don't carry over to the next one", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app"), MYSQL_MODE: "read-write" }, [`network:connect:${port}`]);
  const one = async (sql: string, params: unknown[] = []) => Object.values((await call("query", { sql, params })).rows[0])[0];
  await call("query", { sql: "SET SESSION sql_mode = 'ANSI_QUOTES'", params: [] });
  assert.ok(!String(await one("SELECT @@SESSION.sql_mode")).includes("ANSI_QUOTES"), "sql_mode is back for the next call");
  await call("query", { sql: "SET @leftover = 1", params: [] });
  assert.equal(await one("SELECT @leftover"), null);
  assert.equal(await one("SELECT ? AS s", ["héllo ✓"]), "héllo ✓", "the character set is set again after the reset");
  // A transaction left open is rolled back, not committed by a later call.
  await call("query", { sql: "START TRANSACTION", params: [] });
  await call("query", { sql: "INSERT INTO customers (name) VALUES ('Uncommitted')", params: [] });
  await call("query", { sql: "DELETE FROM customers WHERE name = 'Uncommitted'", params: [] });

  // A GET_LOCK() lock outlives ROLLBACK, so read-only mode doesn't stop it.
  const ro = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  await ro("query", { sql: "SELECT GET_LOCK('berth_probe', 0) AS got", params: [] });
  const [rows] = await admin((db) => db.query("SELECT IS_USED_LOCK('berth_probe') AS holder"));
  assert.equal((rows as { holder: unknown }[])[0]!.holder, null, "the lock was released before the connection went back to the pool");
  // The read-only flag is set again after the reset.
  await assert.rejects(ro("query", { sql: "DROP TABLE customers", params: [] }), /read-only/);
});

live("read-only mode refuses an administrator, which could still write files or change the server, unless told to allow it", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: TEST_URL }, [`network:connect:${port}`]);
  await assert.rejects(call("query", { sql: "SET GLOBAL max_connections = 152", params: [] }), /root has global privileges.*SUPER.*MYSQL_ALLOW_PRIVILEGED=true/s);
  await assert.rejects(call("connection_info"), /global privileges/, "every export is refused, not only query");

  // A user with just FILE, and one whose only risky privilege comes from a role.
  await admin(async (db) => {
    await db.query("CREATE USER IF NOT EXISTS 'filer'@'%' IDENTIFIED BY 'filer'");
    await db.query("GRANT FILE ON *.* TO 'filer'@'%'");
    await db.query("GRANT SELECT ON customers TO 'filer'@'%'");
    await db.query("CREATE ROLE IF NOT EXISTS 'tuner'");
    await db.query("GRANT SYSTEM_VARIABLES_ADMIN ON *.* TO 'tuner'");
    await db.query("CREATE USER IF NOT EXISTS 'sneaky'@'%' IDENTIFIED BY 'sneaky'");
    await db.query("GRANT SELECT ON customers TO 'sneaky'@'%'");
    await db.query("GRANT 'tuner' TO 'sneaky'@'%'");
    await db.query("SET DEFAULT ROLE ALL TO 'sneaky'@'%'");
  });
  const filer = await appWith({ DATABASE_URL: urlAs("filer") }, [`network:connect:${port}`]);
  await assert.rejects(filer("query", { sql: "SELECT 1", params: [] }), /filer has global privileges \(FILE\)/);
  const sneaky = await appWith({ DATABASE_URL: urlAs("sneaky") }, [`network:connect:${port}`]);
  await assert.rejects(sneaky("query", { sql: "SELECT 1", params: [] }), /sneaky has global privileges \(SYSTEM_VARIABLES_ADMIN\)/);

  const allowed = await appWith({ DATABASE_URL: TEST_URL, MYSQL_ALLOW_PRIVILEGED: "true" }, [`network:connect:${port}`]);
  assert.equal(Number((await allowed("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
  // Read-write mode is asking for a user that can change things: no check.
  const rw = await appWith({ DATABASE_URL: TEST_URL, MYSQL_MODE: "read-write" }, [`network:connect:${port}`]);
  assert.equal((await rw("connection_info")).mode, "read-write");
});

live("concurrent first calls share one pool", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  const ids = await Promise.all(Array.from({ length: 6 }, () => call("query", { sql: "SELECT CONNECTION_ID() AS id", params: [] })));
  // connectionLimit: 2 per pool. Six pools would have opened up to six connections.
  assert.ok(new Set(ids.map((r) => String(r.rows[0].id))).size <= 2);
});

live("through a CONNECT proxy, as the egress proxy would carry it", async () => {
  const target = new URL(TEST_URL!);
  const seen: string[] = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    seen.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    // Stands in for the real proxy, which would resolve the declared name.
    const upstream = net.connect(Number(port), host === "db.test.example" ? "127.0.0.1" : host!, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  after(() => proxy.close());
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const viaName = `mysql://app:app@db.test.example:${target.port}${target.pathname}`;
  const call = await appWith({ DATABASE_URL: viaName, BERTH_EGRESS_PROXY_URL: proxyUrl }, [`network:host:db.test.example:${target.port}`, "network:connect:8090"]);
  assert.equal((await call("connection_info")).route, "through the egress proxy");
  assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
  // Again, on the pooled connection.
  assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
  assert.deepEqual(seen.slice(0, 1), [`db.test.example:${target.port}`]);
});

live("a role that can only read is refused writes by the database itself, in either mode", async () => {
  const target = new URL(TEST_URL!);
  const call = await appWith({ DATABASE_URL: urlAs("reader"), MYSQL_MODE: "read-write" }, [`network:connect:${target.port}`]);
  await assert.rejects(call("query", { sql: "DELETE FROM customers", params: [] }), /DELETE command denied/);
});
