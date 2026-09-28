import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { cell, Collector, modeFrom, routeFor, shapeRows, targetOf } from "./index.js";
import { ProxyTunnel } from "./tunnel.js";

// --- pure: no database needed ------------------------------------------------

test("targetOf reads host, port, database and user, and never the password", () => {
  const t = targetOf("postgres://app%40corp:s3cret@db.example.com:6543/sales");
  assert.deepEqual(t, { host: "db.example.com", port: 6543, database: "sales", user: "app@corp" });
  assert.ok(!JSON.stringify(t).includes("s3cret"));
  assert.equal(targetOf("postgresql://u@h/").port, 5432);
  assert.throws(() => targetOf("mysql://u@h/db"), /should start with postgres:\/\//);
  assert.throws(() => targetOf("not a url"), /isn't a valid URL/);
});

test("routeFor goes through the proxy for a declared public host, direct for a declared port, and refuses otherwise", () => {
  const pub = targetOf("postgres://u:p@db.example.com:5432/x");
  assert.equal(routeFor(pub, ["network:host:db.example.com:5432", "network:connect:8090"], "http://127.0.0.1:8090").kind, "proxy");
  assert.equal(routeFor(pub, ["network:connect:5432"], undefined).kind, "direct");
  assert.throws(() => routeFor(pub, ["network:host:other.example.com:5432"], "http://127.0.0.1:8090"), /doesn't allow.*network:host:db\.example\.com:5432.*network:connect:5432/s);

  const priv = targetOf("postgres://u:p@10.0.3.7:5432/x");
  assert.equal(routeFor(priv, ["network:connect:5432"], "http://127.0.0.1:8090").kind, "direct", "an internal address never goes through the proxy");
  assert.throws(() => routeFor(priv, ["network:host:10.0.3.7:5432"], "http://127.0.0.1:8090"), /internal address.*network:connect:5432/s);
});

test("the mode is read-only unless POSTGRES_MODE says read-write", () => {
  assert.equal(modeFrom({}), "read-only");
  assert.equal(modeFrom({ POSTGRES_MODE: "yes" }), "read-only");
  assert.equal(modeFrom({ POSTGRES_MODE: "read-write" }), "read-write");
});

test("results are capped by row count and size, and values are JSON-safe", () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ id: i }));
  const shaped = shapeRows(many);
  assert.equal(shaped.rows.length, 500);
  assert.equal(shaped.truncated, true);
  assert.equal(cell(new Date("2026-01-04T00:00:00Z")), "2026-01-04T00:00:00.000Z");
  assert.equal(cell(BigInt("9007199254740993")), "9007199254740993");
  assert.equal(cell(Buffer.from([0xde, 0xad])), "\\xdead");
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

// Every method pg and pg-pool call on their stream (grep for "stream." in
// pg/lib and pg-pool): a missing one is a crash on the path that uses it, as
// ref() was, on a pooled connection's second query.
test("the tunnel has every socket method pg and pg-pool call", () => {
  const tunnel = new ProxyTunnel(new URL("http://127.0.0.1:1")) as unknown as Record<string, unknown>;
  for (const method of ["connect", "cork", "uncork", "destroy", "end", "write", "on", "once", "ref", "unref", "setKeepAlive", "setNoDelay"]) {
    assert.equal(typeof tunnel[method], "function", method);
  }
});

// --- against a real database, when PG_TEST_URL is set -------------------------
// e.g. docker run -d -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16
// PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres, a superuser:
// the suite creates what it needs itself (a customers table holding three
// rows, owned by a role app/app, and a role reader/reader that can only
// SELECT it), and connects as those roles, not as the superuser.

const PG_TEST_URL = process.env.PG_TEST_URL;
const live = (name: string, fn: () => Promise<void>) => test(name, { skip: !PG_TEST_URL && "set PG_TEST_URL to run against a real database" }, fn);

/** PG_TEST_URL, as another role. */
function urlAs(user: string): string {
  const url = new URL(PG_TEST_URL!);
  url.username = user;
  url.password = user;
  return url.toString();
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: PG_TEST_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

before(async () => {
  if (!PG_TEST_URL) return;
  await admin(async (db) => {
    for (const role of ["app", "reader"]) {
      await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD '${role}'; END IF; END $$`);
    }
    await db.query("DROP TABLE IF EXISTS customers");
    await db.query("CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL, signed_up date NOT NULL DEFAULT current_date, plan text NOT NULL DEFAULT 'free')");
    await db.query("INSERT INTO customers (name, signed_up, plan) VALUES ('Ada', '2026-01-04', 'pro'), ('Grace', '2026-02-11', 'free'), ('Linus', '2026-03-20', 'pro')");
    await db.query("ALTER TABLE customers OWNER TO app");
    await db.query("GRANT SELECT ON customers TO reader");
  });
});

async function appWith(env: Record<string, string | undefined>, capabilities: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "postgres-app-test-"));
  await writeFile(join(dir, "berth.yml"), `name: postgres\nversion: 0.1.0\ncapabilities:\n${capabilities.map((c) => `  - ${c}`).join("\n")}\nexports: []\n`);
  for (const k of ["DATABASE_URL", "POSTGRES_MODE", "BERTH_EGRESS_PROXY_URL"]) delete process.env[k];
  Object.assign(process.env, { BERTH_MANIFEST_PATH: join(dir, "berth.yml") }, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));
  // A fresh module per configuration: the pool is created once per process.
  const mod = await import(`./index.js?case=${Math.random()}`);
  after(() => mod.closeForTests());
  const call = (name: string, input: unknown = {}) => mod.default._exports.get(name)!.handler(input) as Promise<any>;
  return call;
}

live("query, list_tables and describe_table against a real database", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  const res = await call("query", { sql: "SELECT name, plan FROM customers WHERE plan = $1 ORDER BY id", params: ["pro"] });
  assert.deepEqual(res.columns, ["name", "plan"]);
  assert.deepEqual(res.rows, [{ name: "Ada", plan: "pro" }, { name: "Linus", plan: "pro" }]);
  assert.ok((await call("list_tables", { schema: "" })).tables.some((t: any) => t.name === "customers"));
  assert.deepEqual((await call("describe_table", { table: "customers" })).columns.map((c: any) => c.name), ["id", "name", "signed_up", "plan"]);
  const info = await call("connection_info");
  assert.deepEqual({ mode: info.mode, route: info.route, user: info.user }, { mode: "read-only", route: "direct", user: "app" });
});

live("read-only mode refuses writes, even ones that try to switch the transaction", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  await assert.rejects(call("query", { sql: "INSERT INTO customers (name) VALUES ('Mallory')", params: [] }), /read-only/);
  await assert.rejects(call("query", { sql: "SET TRANSACTION READ WRITE", params: [] }).then(() => call("query", { sql: "DELETE FROM customers", params: [] })), /read-only/);
  await assert.rejects(call("query", { sql: "SELECT 1; DELETE FROM customers", params: [] }), /one statement per query/);
  assert.equal((await call("query", { sql: "SELECT count(*)::int AS n FROM customers", params: [] })).rows[0].n, 3);
});

live("read-write mode can change data, one statement at a time", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app"), POSTGRES_MODE: "read-write" }, [`network:connect:${port}`]);
  const inserted = await call("query", { sql: "INSERT INTO customers (name, plan) VALUES ($1, $2) RETURNING id", params: ["Temp", "free"] });
  assert.equal(inserted.row_count, 1);
  assert.equal((await call("query", { sql: "UPDATE customers SET plan = plan WHERE plan = $1", params: ["pro"] })).row_count, 2);
  await call("query", { sql: "DELETE FROM customers WHERE id = $1", params: [inserted.rows[0].id] });
  await assert.rejects(call("query", { sql: "SELECT 1; SELECT 2", params: [] }), /one statement per query/);
});

live("a huge result is read a batch at a time, never all into memory", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  await call("query", { sql: "SELECT 1", params: [] });
  const before = process.memoryUsage().rss;
  const started = Date.now();
  // ~1.5 GB if node-postgres buffered it: it did, and the app ran out of memory.
  const res = await call("query", { sql: "SELECT g, repeat('x', 500) AS pad FROM generate_series(1, 3000000) AS g", params: [] });
  assert.equal(res.truncated, true);
  assert.ok(res.rows.length <= 500);
  assert.deepEqual(res.columns, ["g", "pad"]);
  const grown = (process.memoryUsage().rss - before) / 1e6;
  assert.ok(grown < 150, `rss grew ${grown.toFixed(0)} MB`);
  assert.ok(Date.now() - started < 10_000, "stopped early rather than reading every row");
  // The same pooled connection is usable afterwards: the portal was closed.
  for (let i = 0; i < 3; i++) assert.equal((await call("query", { sql: "SELECT count(*)::int AS n FROM customers", params: [] })).rows[0].n, 3);
  // Exactly the cap comes back whole, and statements with no rows report what they changed.
  const five = await call("query", { sql: "SELECT g FROM generate_series(1, 500) AS g", params: [] });
  assert.deepEqual({ n: five.rows.length, truncated: five.truncated, row_count: five.row_count }, { n: 500, truncated: false, row_count: 500 });
});

live("concurrent first calls share one pool", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  const pids = await Promise.all(Array.from({ length: 6 }, () => call("query", { sql: "SELECT pg_backend_pid() AS pid", params: [] })));
  // max: 2 per pool. Six pools would have opened up to six backends.
  assert.ok(new Set(pids.map((r) => r.rows[0].pid)).size <= 2);
});

live("through a CONNECT proxy, as the egress proxy would carry it", async () => {
  const target = new URL(PG_TEST_URL!);
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
  const viaName = `postgres://app:app@db.test.example:${target.port}${target.pathname}`;
  const call = await appWith({ DATABASE_URL: viaName, BERTH_EGRESS_PROXY_URL: proxyUrl }, [`network:host:db.test.example:${target.port}`, "network:connect:8090"]);
  assert.equal((await call("connection_info")).route, "through the egress proxy");
  assert.equal((await call("query", { sql: "SELECT count(*)::int AS n FROM customers", params: [] })).rows[0].n, 3);
  // Again, on the pooled connection: the path that used to crash.
  assert.equal((await call("query", { sql: "SELECT count(*)::int AS n FROM customers", params: [] })).rows[0].n, 3);
  assert.deepEqual(seen.slice(0, 1), [`db.test.example:${target.port}`]);
});

live("a role that can only read is refused writes by the database itself, in either mode", async () => {
  const target = new URL(PG_TEST_URL!);
  const call = await appWith({ DATABASE_URL: urlAs("reader"), POSTGRES_MODE: "read-write" }, [`network:connect:${target.port}`]);
  await assert.rejects(call("query", { sql: "DELETE FROM customers", params: [] }), /permission denied/);
});
