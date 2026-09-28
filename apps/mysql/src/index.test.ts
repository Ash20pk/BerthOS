import { test, after, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { allowsPrivileged, cell, Collector, configOf, modeFrom, privilegeProblem, riskyPrivileges, rolesIn, routeFor, shapeRows, targetOf } from "./index.js";
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
  assert.deepEqual(rolesIn("GRANT `analyst`@`%`,`ops`@`%` TO `app`@`%`"), ["`analyst`@`%`", "`ops`@`%`"]);
  assert.deepEqual(rolesIn("GRANT `inner_r` TO `outer_r`"), ["`inner_r`"], "MariaDB's roles have no host");
  assert.deepEqual(rolesIn("GRANT SELECT ON `shop`.* TO `app`@`%`"), []);
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

test("binary, big integers and dates nested in arrays and JSON are made JSON-safe too", () => {
  assert.deepEqual(cell([Buffer.from([0xde, 0xad]), null]), ["0xdead", null]);
  assert.deepEqual(cell({ id: BigInt(7), at: new Date("2026-01-04T00:00:00Z"), blobs: [Buffer.from([1])] }), { id: "7", at: "2026-01-04T00:00:00.000Z", blobs: ["0x01"] });
  assert.equal(typeof cell([Buffer.alloc(20_000)]), "string", "still capped once serialized");
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
// (or mariadb:10.11 / mariadb:11.4, with MARIADB_ROOT_PASSWORD and MARIADB_DATABASE)
// MYSQL_TEST_URL=mysql://root:test@127.0.0.1:53306/shop, an administrator:
// the suite creates what it needs itself (a customers table holding three
// rows, a user app/app with every privilege on that database and none
// beyond it, and a user reader/reader that can only SELECT the table), and
// connects as those users, not as the administrator.

const TEST_URL = process.env.MYSQL_TEST_URL;
const live = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { skip: !TEST_URL && "set MYSQL_TEST_URL to run against a real database" }, fn);

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

/** The live suite runs against MySQL and MariaDB, which differ in places. */
async function isMariaDB(): Promise<boolean> {
  const [rows] = await admin((db) => db.query("SELECT VERSION() AS v"));
  return /MariaDB/.test((rows as { v: string }[])[0]!.v);
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
    await db.query("DROP PROCEDURE IF EXISTS rows_then_write");
    // 600 rows, more than the cap, and then a write.
    await db.query(`CREATE PROCEDURE rows_then_write() BEGIN
      WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 600) SELECT n FROM g;
      DO SLEEP(1);
      INSERT INTO customers (name) VALUES ('After the rows');
    END`);
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
  return Object.assign(call, { mod });
}

/** Until nothing of user's is running sql on the server, for up to ms; how long that took. */
async function settled(user: string, like: string, ms = 5_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const [rows] = await admin((db) => db.query("SELECT count(*) AS n FROM information_schema.PROCESSLIST WHERE USER = ? AND INFO LIKE ?", [user, like]));
    if (Number((rows as { n: unknown }[])[0]!.n) === 0 || Date.now() - started > ms) return Date.now() - started;
    await new Promise((r) => setTimeout(r, 100));
  }
}

live("query, list_tables and describe_table against a real database", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  const res = await call("query", { sql: "SELECT name, plan FROM customers WHERE plan = ? ORDER BY id", params: ["pro"] });
  assert.deepEqual(res.columns, ["name", "plan"]);
  assert.deepEqual(res.rows, [{ name: "Ada", plan: "pro" }, { name: "Linus", plan: "pro" }]);
  assert.ok((await call("list_tables", { schema: "" })).tables.some((t: any) => t.name === "customers"));
  assert.deepEqual((await call("describe_table", { table: "customers" })).columns.map((c: any) => c.name), ["id", "name", "signed_up", "plan"]);
  await assert.rejects(call("describe_table", { table: "a.b.c" }), /table or database\.table/);
  // Placeholders are filled by the driver: ?? is an identifier, and a ? in a string is left alone.
  assert.deepEqual((await call("query", { sql: "SELECT '?' AS q, ?? AS n FROM customers WHERE id = ?", params: ["name", 1] })).rows, [{ q: "?", n: "Ada" }]);
  const info = await call("connection_info");
  assert.deepEqual({ mode: info.mode, route: info.route, user: info.user }, { mode: "read-only", route: "direct", user: "app" });
});

live("a date comes back as the same date, whatever the app's time zone", async () => {
  const port = new URL(TEST_URL!).port;
  const tz = process.env.TZ;
  // East of UTC, a date read as local midnight turned into the day before.
  process.env.TZ = "Asia/Tokyo";
  try {
    const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
    const res = await call("query", { sql: "SELECT signed_up, CAST('2026-01-04 00:30:00' AS DATETIME) AS at FROM customers WHERE name = ?", params: ["Ada"] });
    assert.deepEqual(res.rows, [{ signed_up: "2026-01-04", at: "2026-01-04 00:30:00" }]);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

live("with no database in DATABASE_URL, list_tables and describe_table say so rather than finding nothing", async () => {
  const url = new URL(urlAs("app"));
  const database = url.pathname.slice(1);
  url.pathname = "/";
  const call = await appWith({ DATABASE_URL: url.toString() }, [`network:connect:${url.port}`]);
  await assert.rejects(call("list_tables", { schema: "" }), /names no database.*SHOW DATABASES/s);
  await assert.rejects(call("describe_table", { table: "customers" }), /names no database/);
  assert.ok((await call("list_tables", { schema: database })).tables.some((t: any) => t.name === "customers"));
  assert.equal((await call("describe_table", { table: `${database}.customers` })).columns.length, 4);
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
  await call("query", { sql: "SET SESSION TRANSACTION READ WRITE", params: [] });
  await assert.rejects(call("query", { sql: "DROP TABLE customers", params: [] }), /read-only/);
  assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
});

live("multipleStatements=true in DATABASE_URL doesn't turn multi-statement strings back on", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: `${urlAs("app")}?multipleStatements=true`, MYSQL_MODE: "read-write" }, [`network:connect:${port}`]);
  await assert.rejects(call("query", { sql: "SELECT 1; DELETE FROM customers", params: [] }), /one statement per query/);
  assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
});

live("ssl in DATABASE_URL encrypts the connection", async (t) => {
  const port = new URL(TEST_URL!).port;
  // MariaDB before 11.4 comes with TLS off. (MySQL 8.4 has no have_ssl: TLS is always on.)
  const [have] = await admin((db) => db.query("SHOW VARIABLES LIKE 'have_ssl'"));
  if ((have as { Value: string }[]).some((r) => r.Value !== "YES")) return t.skip("the test server has TLS turned off");
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
  // The first result set. A literal is a BIGINT in MySQL, so a string, and an INT in MariaDB.
  assert.deepEqual({ columns: two.columns, rows: two.rows.map((r: any) => ({ a: String(r.a) })) }, { columns: ["a"], rows: [{ a: "1" }] });
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
  // SUPER among them in MySQL; ALL PRIVILEGES in MariaDB.
  await assert.rejects(call("query", { sql: "SET GLOBAL max_connections = 152", params: [] }), /root has global privileges \((ALL PRIVILEGES|.*SUPER).*MYSQL_ALLOW_PRIVILEGED=true/s);
  await assert.rejects(call("connection_info"), /global privileges/, "every export is refused, not only query");

  // A user with just FILE, and one whose only risky privilege comes from a role.
  // MariaDB has no SYSTEM_VARIABLES_ADMIN, and sets a default role its own way.
  const maria = await isMariaDB();
  const tunerPrivilege = maria ? "CONNECTION ADMIN" : "SYSTEM_VARIABLES_ADMIN";
  await admin(async (db) => {
    await db.query("CREATE USER IF NOT EXISTS 'filer'@'%' IDENTIFIED BY 'filer'");
    await db.query("GRANT FILE ON *.* TO 'filer'@'%'");
    await db.query("GRANT SELECT ON customers TO 'filer'@'%'");
    await db.query("CREATE ROLE IF NOT EXISTS 'tuner'");
    await db.query(`GRANT ${tunerPrivilege} ON *.* TO 'tuner'`);
    await db.query("CREATE USER IF NOT EXISTS 'sneaky'@'%' IDENTIFIED BY 'sneaky'");
    await db.query("GRANT SELECT ON customers TO 'sneaky'@'%'");
    await db.query("GRANT 'tuner' TO 'sneaky'@'%'");
    await db.query(maria ? "SET DEFAULT ROLE tuner FOR 'sneaky'@'%'" : "SET DEFAULT ROLE ALL TO 'sneaky'@'%'");
    // Three roles deep, none of them a default: the privilege is on the last.
    for (const role of ["deep_1", "deep_2", "deep_3"]) await db.query(`CREATE ROLE IF NOT EXISTS '${role}'`);
    await db.query("GRANT RELOAD ON *.* TO 'deep_3'");
    await db.query("GRANT 'deep_3' TO 'deep_2'");
    await db.query("GRANT 'deep_2' TO 'deep_1'");
    await db.query("CREATE USER IF NOT EXISTS 'nested'@'%' IDENTIFIED BY 'nested'");
    await db.query("GRANT SELECT ON customers TO 'nested'@'%'");
    await db.query("GRANT 'deep_1' TO 'nested'@'%'");
  });
  const filer = await appWith({ DATABASE_URL: urlAs("filer") }, [`network:connect:${port}`]);
  await assert.rejects(filer("query", { sql: "SELECT 1", params: [] }), /filer has global privileges \(FILE\)/);
  const sneaky = await appWith({ DATABASE_URL: urlAs("sneaky") }, [`network:connect:${port}`]);
  await assert.rejects(sneaky("query", { sql: "SELECT 1", params: [] }), new RegExp(`sneaky has global privileges \\(${tunerPrivilege}\\)`));
  const nested = await appWith({ DATABASE_URL: urlAs("nested") }, [`network:connect:${port}`]);
  await assert.rejects(nested("query", { sql: "SELECT 1", params: [] }), /nested has global privileges \(RELOAD\)/);
  // The check set a role on the connection it used (MariaDB), and a reset
  // doesn't undo that: a user allowed through gets a connection without it.
  const nestedAllowed = await appWith({ DATABASE_URL: urlAs("nested"), MYSQL_ALLOW_PRIVILEGED: "true" }, [`network:connect:${port}`]);
  assert.equal((await nestedAllowed("query", { sql: "SELECT CURRENT_ROLE() AS r", params: [] })).rows[0].r, maria ? null : "NONE");

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

live("a query that runs out of time is stopped on the server, and a write it made isn't committed", async () => {
  const port = new URL(TEST_URL!).port;
  const count = async (call: (name: string, input?: unknown) => Promise<any>) => Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n);
  const rw = await appWith({ DATABASE_URL: urlAs("app"), MYSQL_MODE: "read-write" }, [`network:connect:${port}`]);
  rw.mod.setQueryTimeoutForTests(1_000);
  // With autocommit, closing the connection didn't stop the INSERT: it was
  // reported abandoned, and committed a few seconds later.
  await assert.rejects(rw("query", { sql: "INSERT INTO customers (name) SELECT CONCAT('Slow ', SLEEP(4))", params: [] }), /took longer than 1 s, and it was stopped on the server\. It ran in a transaction that wasn't committed/);
  assert.ok((await settled("app", "%SLEEP(4)%")) < 1_000, "nothing is left running on the server");
  await new Promise((r) => setTimeout(r, 4_000));
  assert.equal(Number((await rw("query", { sql: "SELECT count(*) AS n FROM customers WHERE name LIKE 'Slow%'", params: [] })).rows[0].n), 0, "the INSERT wasn't committed, even after SLEEP would have ended");
  assert.equal(await count(rw), 3);

  // Read-only, a query that takes a while to compute, rather than a SLEEP(),
  // which MySQL and MariaDB both let return early and call it success. As a
  // SELECT, the server's own limit stops it; as a DO, MySQL's
  // max_execution_time doesn't cover it and this app's timer does. (MariaDB's
  // max_statement_time stops a DO too, but calls that a warning, not an error.)
  const ro = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  ro.mod.setQueryTimeoutForTests(1_000);
  const digits = "SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9";
  const heavy = `(WITH d AS (${digits}) SELECT count(*) FROM d a, d b, d c, d e, d f, d g, d h, d i, d j, d k) /* berth heavy */`;
  for (const sql of (await isMariaDB()) ? [`SELECT ${heavy} AS n`] : [`SELECT ${heavy} AS n`, `DO ${heavy}`]) {
    const started = Date.now();
    await assert.rejects(ro("query", { sql, params: [] }), (err: Error) => /took longer than 1 s, and it was stopped on the server$/.test(err.message), sql.slice(0, 6));
    assert.ok(Date.now() - started < 4_000);
    assert.ok((await settled("app", "%berth heavy%")) < 1_000, "nothing is left running on the server");
  }
  assert.equal(await count(ro), 3);
});

live("a result cut off at the cap stops the statement, and in read-write mode commits nothing it went on to do", async () => {
  const port = new URL(TEST_URL!).port;
  const rw = await appWith({ DATABASE_URL: urlAs("app"), MYSQL_MODE: "read-write" }, [`network:connect:${port}`]);
  const res = await rw("query", { sql: "CALL rows_then_write()", params: [] });
  assert.deepEqual({ n: res.rows.length, truncated: res.truncated }, { n: 500, truncated: true });
  assert.ok((await settled("app", "%rows_then_write%")) < 1_000, "the CALL isn't left running on the server");
  // Past the procedure's SLEEP(1): with autocommit, and the connection only closed, its INSERT ran and committed.
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(Number((await rw("query", { sql: "SELECT count(*) AS n FROM customers WHERE name = 'After the rows'", params: [] })).rows[0].n), 0);
  if (await isMariaDB()) {
    // Its INSERT … RETURNING, which returns a row per row written.
    const returned = await rw("query", { sql: "INSERT INTO customers (name) WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 600) SELECT CONCAT('Returned ', n) FROM g RETURNING id", params: [] });
    assert.equal(returned.truncated, true);
    assert.equal(Number((await rw("query", { sql: "SELECT count(*) AS n FROM customers WHERE name LIKE 'Returned %'", params: [] })).rows[0].n), 0, "cut off, so not committed");
  }
  // A result read to the end is committed as before.
  const done = await rw("query", { sql: "INSERT INTO customers (name) VALUES ('Kept')", params: [] });
  assert.equal(done.row_count, 1);
  assert.equal(Number((await rw("query", { sql: "SELECT count(*) AS n FROM customers WHERE name = 'Kept'", params: [] })).rows[0].n), 1);
  await rw("query", { sql: "DELETE FROM customers WHERE name = 'Kept'", params: [] });
});

live("a connection lost mid-query fails the call at once, and the next call gets a new one", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  const started = Date.now();
  const [lost] = await Promise.all([
    call("query", { sql: "SELECT SLEEP(10) AS s /* berth lost */", params: [] }).then(
      () => undefined,
      (err: Error) => err,
    ),
    (async () => {
      for (let i = 0; i < 50; i++) {
        const [rows] = await admin((db) => db.query("SELECT ID AS id FROM information_schema.PROCESSLIST WHERE USER = 'app' AND INFO LIKE '%berth lost%'"));
        const id = (rows as { id: number }[])[0]?.id;
        if (id !== undefined) return admin((db) => db.query(`KILL CONNECTION ${Number(id)}`));
        await new Promise((r) => setTimeout(r, 50));
      }
    })(),
  ]);
  // It used to go unnoticed until the 30 s timeout, which then called it one.
  assert.match(String(lost), /Connection lost|closed the connection/);
  assert.ok(Date.now() - started < 5_000);
  for (let i = 0; i < 3; i++) assert.equal(Number((await call("query", { sql: "SELECT count(*) AS n FROM customers", params: [] })).rows[0].n), 3);
});
