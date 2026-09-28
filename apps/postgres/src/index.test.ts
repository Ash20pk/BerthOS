import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { allowsPrivileged, cell, Collector, modeFrom, privilegeProblem, routeFor, shapeRows, targetOf, types, usesTls } from "./index.js";
import { ProxyTunnel } from "./tunnel.js";

// --- pure: no database needed ------------------------------------------------

test("targetOf reads host, port, database and user, and never the password", () => {
  const t = targetOf("postgres://app%40corp:s3cret@db.example.com:6543/sales");
  assert.deepEqual(t, { host: "db.example.com", port: 6543, database: "sales", user: "app@corp" });
  assert.ok(!JSON.stringify(t).includes("s3cret"));
  assert.equal(targetOf("postgresql://u@h/").port, 5432);
  assert.equal(targetOf("postgresql://analyst@h/").database, "analyst", "no database means the user's, as node-postgres connects to");
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

test("usesTls reads DATABASE_URL the way node-postgres does", () => {
  assert.equal(usesTls("postgres://u:p@db.example.com/x"), false);
  assert.equal(usesTls("postgres://u:p@db.example.com/x?sslmode=disable"), false);
  assert.equal(usesTls("postgres://u:p@db.example.com/x?sslmode=require"), true);
  assert.equal(usesTls("postgres://u:p@db.example.com/x?sslmode=verify-full"), true);
  assert.equal(usesTls("postgres://u:p@db.example.com/x?ssl=true"), true);
});

test("the mode is read-only unless POSTGRES_MODE says read-write", () => {
  assert.equal(modeFrom({}), "read-only");
  assert.equal(modeFrom({ POSTGRES_MODE: "yes" }), "read-only");
  assert.equal(modeFrom({ POSTGRES_MODE: "read-write" }), "read-write");
});

test("a privileged role is named, with what it could still do and how to opt in", () => {
  const none = { superuser: false, execute_server_program: false, write_server_files: false };
  assert.equal(privilegeProblem("app", none), undefined);
  assert.match(privilegeProblem("postgres", { ...none, superuser: true })!, /postgres is a superuser.*COPY … TO PROGRAM.*POSTGRES_ALLOW_PRIVILEGED=true/s);
  assert.match(privilegeProblem("ops", { ...none, execute_server_program: true })!, /pg_execute_server_program/);
  assert.equal(allowsPrivileged({}), false);
  assert.equal(allowsPrivileged({ POSTGRES_ALLOW_PRIVILEGED: "true" }), true);
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

test("dates and timestamps are parsed as the text PostgreSQL sends, and only for this app", () => {
  const parse = (oid: number, text: string) => (types.getTypeParser as (oid: number) => (v: string) => unknown)(oid)(text);
  assert.equal(parse(1082, "2026-01-04"), "2026-01-04");
  assert.equal(parse(1114, "2026-01-04 10:30:00"), "2026-01-04 10:30:00");
  assert.equal(parse(1184, "2026-01-04 10:30:00+00"), "2026-01-04 10:30:00+00");
  assert.deepEqual(parse(1182, "{2026-01-04,2026-02-11}"), ["2026-01-04", "2026-02-11"]);
  assert.equal(parse(23, "42"), 42, "everything else parses as before");
  assert.ok(pg.types.getTypeParser(1082)("2026-01-04") instanceof Date, "the global parsers are untouched");
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
    // Another schema with a table of the same name, and one only there.
    await db.query("DROP SCHEMA IF EXISTS berth_other CASCADE");
    await db.query("CREATE SCHEMA berth_other AUTHORIZATION app");
    await db.query("CREATE TABLE berth_other.customers (id int, email text)");
    await db.query("CREATE TABLE berth_other.invoices (id int, total numeric)");
    await db.query("ALTER TABLE berth_other.customers OWNER TO app");
    await db.query("ALTER TABLE berth_other.invoices OWNER TO app");
  });
});

async function appWith(env: Record<string, string | undefined>, capabilities: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "postgres-app-test-"));
  await writeFile(join(dir, "berth.yml"), `name: postgres\nversion: 0.1.0\ncapabilities:\n${capabilities.map((c) => `  - ${c}`).join("\n")}\nexports: []\n`);
  for (const k of ["DATABASE_URL", "POSTGRES_MODE", "POSTGRES_ALLOW_PRIVILEGED", "BERTH_EGRESS_PROXY_URL"]) delete process.env[k];
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

live("describe_table resolves an unqualified name through the search path, as PostgreSQL does", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  const names = async (table: string) => (await call("describe_table", { table })).columns.map((c: any) => c.name);
  assert.deepEqual(await names("customers"), ["id", "name", "signed_up", "plan"], "public.customers only, not mixed with berth_other.customers");
  assert.deepEqual(await names("berth_other.customers"), ["id", "email"]);
  assert.deepEqual(await names("public.customers"), ["id", "name", "signed_up", "plan"]);
  await assert.rejects(call("describe_table", { table: "invoices" }), /no table called invoices on the search path.*berth_other\.invoices/s);
  await assert.rejects(call("describe_table", { table: "nope" }), /no table called nope/);
  await assert.rejects(call("describe_table", { table: "a.b.c" }), /table or schema\.table/);
});

live("a date comes back as the same date, whatever the app's time zone", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const tz = process.env.TZ;
  // East of UTC, a date read as local midnight turned into the day before.
  process.env.TZ = "Asia/Tokyo";
  try {
    const call = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
    const res = await call("query", { sql: "SELECT signed_up, TIMESTAMP '2026-01-04 00:30:00' AS ts, ARRAY[DATE '2026-01-04'] AS ds FROM customers WHERE name = $1", params: ["Ada"] });
    assert.deepEqual(res.rows, [{ signed_up: "2026-01-04", ts: "2026-01-04 00:30:00", ds: ["2026-01-04"] }]);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
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

live("a call's session settings and locks don't carry over to the next one", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: urlAs("app"), POSTGRES_MODE: "read-write" }, [`network:connect:${port}`]);
  const show = async (name: string) => Object.values((await call("query", { sql: `SHOW ${name}`, params: [] })).rows[0])[0];
  await call("query", { sql: "SET statement_timeout = 0", params: [] });
  assert.equal(await show("statement_timeout"), "30s", "the timeout is back for the next call");
  await call("query", { sql: "SET search_path = pg_catalog", params: [] });
  assert.equal((await call("query", { sql: "SELECT count(*)::int AS n FROM customers", params: [] })).rows[0].n, 3);
  // A transaction left open is rolled back, not committed by a later call.
  await call("query", { sql: "BEGIN", params: [] });
  await call("query", { sql: "INSERT INTO customers (name) VALUES ('Uncommitted')", params: [] });
  await call("query", { sql: "DELETE FROM customers WHERE name = 'Uncommitted'", params: [] });

  // A session-level advisory lock survives ROLLBACK, so read-only mode doesn't stop it.
  const ro = await appWith({ DATABASE_URL: urlAs("app") }, [`network:connect:${port}`]);
  await ro("query", { sql: "SELECT pg_advisory_lock(4242)", params: [] });
  const held = await admin((db) => db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 4242"));
  assert.equal(held.rows[0].n, 0, "the advisory lock was released before the connection went back to the pool");
});

live("read-only mode refuses a superuser, which could still run COPY … TO PROGRAM, unless told to allow it", async () => {
  const port = new URL(PG_TEST_URL!).port;
  const call = await appWith({ DATABASE_URL: PG_TEST_URL }, [`network:connect:${port}`]);
  await assert.rejects(call("query", { sql: "COPY (SELECT 1) TO PROGRAM 'true'", params: [] }), /postgres is a superuser.*POSTGRES_ALLOW_PRIVILEGED=true/s);
  await assert.rejects(call("connection_info"), /is a superuser/, "every export is refused, not only query");

  // A role that can SET ROLE to a superuser is refused the same way.
  await admin(async (db) => {
    await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sneaky') THEN CREATE ROLE sneaky LOGIN PASSWORD 'sneaky'; END IF; END $$");
    await db.query("GRANT postgres TO sneaky");
  });
  const sneaky = await appWith({ DATABASE_URL: urlAs("sneaky") }, [`network:connect:${port}`]);
  await assert.rejects(sneaky("query", { sql: "SELECT 1", params: [] }), /sneaky is a superuser \(or can become one/);

  const allowed = await appWith({ DATABASE_URL: PG_TEST_URL, POSTGRES_ALLOW_PRIVILEGED: "true" }, [`network:connect:${port}`]);
  assert.equal((await allowed("query", { sql: "SELECT count(*)::int AS n FROM customers", params: [] })).rows[0].n, 3);
  // Read-write mode is asking for a role that can change things: no check.
  const rw = await appWith({ DATABASE_URL: PG_TEST_URL, POSTGRES_MODE: "read-write" }, [`network:connect:${port}`]);
  assert.equal((await rw("connection_info")).mode, "read-write");
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
