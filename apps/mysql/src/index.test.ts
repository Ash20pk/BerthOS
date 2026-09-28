import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { cell, modeFrom, routeFor, shapeRows, targetOf } from "./index.js";
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
  });
});

async function appWith(env: Record<string, string | undefined>, capabilities: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "mysql-app-test-"));
  await writeFile(join(dir, "berth.yml"), `name: mysql\nversion: 0.1.0\ncapabilities:\n${capabilities.map((c) => `  - ${c}`).join("\n")}\nexports: []\n`);
  for (const k of ["DATABASE_URL", "MYSQL_MODE", "BERTH_EGRESS_PROXY_URL"]) delete process.env[k];
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

live("read-write mode can change data, one statement at a time", async () => {
  const port = new URL(TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app"), MYSQL_MODE: "read-write" }, [`network:connect:${port}`]);
  const inserted = await call("query", { sql: "INSERT INTO customers (name, plan) VALUES (?, ?)", params: ["Temp", "free"] });
  assert.equal(inserted.row_count, 1);
  await call("query", { sql: "DELETE FROM customers WHERE name = ?", params: ["Temp"] });
  await assert.rejects(call("query", { sql: "SELECT 1; SELECT 2", params: [] }), /one statement per query/);
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
