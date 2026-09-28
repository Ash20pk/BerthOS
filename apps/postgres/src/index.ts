import { defineApp } from "@berthos/sdk";
import { loadManifest } from "@berthos/manifest-schema";
import { z } from "zod";
import pg from "pg";
import Cursor from "pg-cursor";
import { isAllowed, patternsFrom, type HostPattern } from "./hosts.js";
import { ProxyTunnel } from "./tunnel.js";

const MAX_ROWS = 500;
const MAX_RESULT_CHARS = 200_000;
const MAX_CELL_CHARS = 10_000;
// Rows fetched from the server at a time. The driver holds one batch in memory,
// never the whole result.
const FETCH_ROWS = 50;
const STATEMENT_TIMEOUT_MS = 30_000;

export type Mode = "read-only" | "read-write";
export type Route = { kind: "proxy"; proxy: URL } | { kind: "direct" };

export interface Target {
  host: string;
  port: number;
  database: string;
  user: string;
}

/** Where DATABASE_URL points, without its password. */
export function targetOf(connectionString: string): Target {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL isn't a valid URL: it should look like postgres://user:password@host:5432/database");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error(`DATABASE_URL should start with postgres://, not ${url.protocol}//`);
  return { host: url.hostname, port: Number(url.port) || 5432, database: decodeURIComponent(url.pathname.slice(1)) || "postgres", user: decodeURIComponent(url.username) };
}

/** Addresses the egress proxy never tunnels to, whatever berth.yml says. */
export function isInternal(host: string): boolean {
  if (host === "localhost" || host === "host.docker.internal") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * How to reach the database, from what berth.yml declares:
 *
 * - `network:host:<host>:<port>` and a public host: through the egress
 *   proxy, which allows exactly that host and port.
 * - `network:connect:<port>`: directly. The kernel then allows that port to
 *   any host, not just this one, so it's the weaker of the two; it's what a
 *   database on a private network (a VPC, a Docker network) needs, because
 *   the proxy never tunnels to an internal address. The host itself still
 *   comes only from DATABASE_URL, which the agent can't change.
 */
export function routeFor(target: Target, capabilities: string[], proxyUrl: string | undefined): Route {
  const patterns: HostPattern[] = patternsFrom(capabilities);
  const directPorts = capabilities.filter((c) => c.startsWith("network:connect:")).map((c) => c.slice("network:connect:".length));
  const direct = directPorts.includes("*") || directPorts.includes(String(target.port));
  if (proxyUrl && !isInternal(target.host) && isAllowed(patterns, target.host, target.port)) return { kind: "proxy", proxy: new URL(proxyUrl) };
  if (direct) return { kind: "direct" };
  const where = `${target.host}:${target.port}`;
  throw new Error(
    isInternal(target.host)
      ? `DATABASE_URL points at ${where}, an internal address, which the egress proxy never tunnels to. Declare \`- network:connect:${target.port}\` in postgres's berth.yml to connect directly (the kernel then allows port ${target.port} to any host), and restart the app.`
      : `DATABASE_URL points at ${where}, which postgres's berth.yml doesn't allow. Add \`- network:host:${where}\` (through the egress proxy, this host only), or \`- network:connect:${target.port}\` (direct, any host on that port), and restart the app.`,
  );
}

export function modeFrom(env: NodeJS.ProcessEnv): Mode {
  return env.POSTGRES_MODE === "read-write" ? "read-write" : "read-only";
}

/** POSTGRES_ALLOW_PRIVILEGED=true: serve a privileged role in read-only mode anyway. */
export function allowsPrivileged(env: NodeJS.ProcessEnv): boolean {
  return env.POSTGRES_ALLOW_PRIVILEGED === "true";
}

/**
 * What a read-only transaction can't stop the role doing, if anything. A
 * superuser (or a role that can SET ROLE to one) can still run COPY … TO
 * PROGRAM, a shell command on the database host, and pg_reload_conf(),
 * pg_terminate_backend() and the like, none of which a transaction rolls
 * back; pg_execute_server_program and pg_write_server_files give the first
 * of those on their own.
 */
const PRIVILEGE_CHECK = `
  SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolsuper AND pg_has_role(current_user, r.oid, 'MEMBER')) AS superuser,
         COALESCE(pg_has_role(current_user, to_regrole('pg_execute_server_program'), 'MEMBER'), false) AS execute_server_program,
         COALESCE(pg_has_role(current_user, to_regrole('pg_write_server_files'), 'MEMBER'), false) AS write_server_files`;

export function privilegeProblem(user: string, row: { superuser: boolean; execute_server_program: boolean; write_server_files: boolean }): string | undefined {
  const what = row.superuser
    ? "is a superuser (or can become one with SET ROLE)"
    : row.execute_server_program
      ? "is a member of pg_execute_server_program"
      : row.write_server_files
        ? "is a member of pg_write_server_files"
        : undefined;
  if (!what) return undefined;
  return `DATABASE_URL's role ${user} ${what}, and read-only mode can't hold such a role back: it can still run COPY … TO PROGRAM (a shell command on the database server) or write files there, reload the server's configuration and end other sessions, none of which a read-only transaction stops. Give DATABASE_URL a role that can only read what the agent should see, or, to accept that, set POSTGRES_ALLOW_PRIVILEGED=true and restart the app.`;
}

// date, timestamp and timestamptz, and their arrays. node-postgres turns these
// into a JavaScript Date in the app's local time zone: a date became local
// midnight, which toISOString() then shifted to the day before east of UTC,
// and a timestamp without a time zone was read as local time. They come back
// as the text PostgreSQL sends instead.
const AS_TEXT = new Set([1082, 1114, 1184]);
const AS_TEXT_ARRAY = new Set([1182, 1115, 1185]);
const TEXT_ARRAY = 1009;

const builtin = pg.types.getTypeParser as (oid: number, format?: string) => (value: string) => unknown;

/** Type parsers for this app's queries only; pg.types itself is left alone. */
export const types = {
  getTypeParser: (oid: number, format?: string) => {
    if (AS_TEXT.has(oid)) return (value: string) => value;
    if (AS_TEXT_ARRAY.has(oid)) return builtin(TEXT_ARRAY, format);
    return builtin(oid, format);
  },
} as unknown as pg.CustomTypesConfig;

/** A value made safe to hand back as JSON, and small enough to read. */
export function cell(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.subarray(0, MAX_CELL_CHARS / 2).toString("hex")}${value.length > MAX_CELL_CHARS / 2 ? "…" : ""}`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : typeof value === "string" ? value : value;
}

/**
 * Rows, capped by count and by total size, so one query can't flood the
 * agent's context. Fed a row at a time: add() says false once it's full.
 */
export class Collector {
  readonly rows: Record<string, unknown>[] = [];
  truncated = false;
  private size = 0;

  constructor(private readonly max = MAX_ROWS) {}

  add(row: Record<string, unknown>): boolean {
    if (this.truncated) return false;
    if (this.rows.length >= this.max) return !(this.truncated = true);
    const shaped = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)]));
    this.size += JSON.stringify(shaped).length;
    if (this.size > MAX_RESULT_CHARS) return !(this.truncated = true);
    this.rows.push(shaped);
    return true;
  }
}

export function shapeRows(rows: Record<string, unknown>[], max = MAX_ROWS): { rows: Record<string, unknown>[]; truncated: boolean } {
  const out = new Collector(max);
  for (const row of rows) if (!out.add(row)) break;
  return { rows: out.rows, truncated: out.truncated };
}

interface Connection {
  pool: pg.Pool;
  target: Target;
  route: Route;
  mode: Mode;
}

// The promise, not the pool: two first calls at once would otherwise each
// build a pool, and one would leak. A failed attempt is forgotten, so the next
// call tries again.
let opened: Promise<Connection> | undefined;

function connection(): Promise<Connection> {
  opened ??= open().catch((err) => {
    opened = undefined;
    throw err;
  });
  return opened;
}

async function open(): Promise<Connection> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL isn't set: pass it when you boot the sandbox (berth os up --env DATABASE_URL, or Computer.boot({ env }))");
  const target = targetOf(connectionString);
  const manifest = await loadManifest(process.env.BERTH_MANIFEST_PATH ?? "berth.yml");
  const route = routeFor(target, manifest.capabilities, process.env.BERTH_EGRESS_PROXY_URL);
  const mode = modeFrom(process.env);
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    types,
    ...(route.kind === "proxy" ? { stream: () => new ProxyTunnel(route.proxy) as unknown as import("node:net").Socket } : {}),
  });
  pool.on("error", () => {
    // An idle client dropped (the server restarted, the network blipped): the
    // pool replaces it on next use. Without a listener this would crash the app.
  });
  if (mode === "read-only" && !allowsPrivileged(process.env)) {
    try {
      const { rows } = await pool.query(PRIVILEGE_CHECK);
      const problem = privilegeProblem(target.user, rows[0]);
      if (problem) throw new Error(problem);
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
  }
  return { pool, target, route, mode };
}

/** For tests: close the pool, whose idle connections would keep the process alive. */
export async function closeForTests(): Promise<void> {
  const current = opened;
  opened = undefined;
  await (await current?.catch(() => undefined))?.pool.end().catch(() => {});
}

export interface Rows {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows returned, for a statement that returns rows; otherwise rows changed. */
  rowCount: number;
  truncated: boolean;
}

function readBatch(cursor: Cursor, n: number): Promise<{ rows: Record<string, unknown>[]; result: pg.QueryResult }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) => (err ? reject(err) : resolve({ rows, result })));
  });
}

/**
 * The statement's rows, through a cursor: node-postgres would otherwise read
 * every row of the result into memory before any cap applied, and a SELECT
 * over a few million rows took the app down. This asks the server for a
 * batch at a time and stops once the collector is full, so memory stays at
 * one batch however large the result. A cursor is a portal in the extended
 * query protocol, which refuses a string holding several statements.
 */
async function collect(client: pg.PoolClient, sql: string, params: unknown[], max: number): Promise<Rows> {
  const cursor = client.query(new Cursor(sql, params, { types }));
  const out = new Collector(max);
  let result: pg.QueryResult | undefined;
  for (;;) {
    const want = Math.min(FETCH_ROWS, max + 1 - out.rows.length);
    const batch = await readBatch(cursor, want);
    result = batch.result;
    if (!batch.rows.every((row) => out.add(row)) || batch.rows.length < want) break;
  }
  // A no-op when the portal ran to the end; otherwise it closes it, and the
  // server stops producing rows.
  await cursor.close();
  const columns = (result?.fields ?? []).map((f) => f.name);
  // For a statement that returns rows, the server's count covers only the
  // last batch fetched, so count them here.
  return { columns, rows: out.rows, rowCount: columns.length > 0 ? out.rows.length : (result?.rowCount ?? 0), truncated: out.truncated };
}

/**
 * One statement per call. Every query goes through the extended query
 * protocol, which refuses a string holding several statements, so
 * "SELECT 1; DROP TABLE x" can't run in either mode. In read-only mode the
 * statement runs inside BEGIN READ ONLY … ROLLBACK, so it can't change data
 * even if it tries to (SET TRANSACTION READ WRITE comes too late inside it).
 * That's a guard in this app, not in the database: for a guarantee, give
 * DATABASE_URL a role that can only read.
 *
 * Each call also starts from a clean session. The statement timeout is set
 * again first, and afterwards the connection is put back as it was
 * (ROLLBACK, then DISCARD ALL) before it returns to the pool: otherwise a
 * `SET statement_timeout = 0` in read-write mode, or a session-level
 * advisory lock, which ROLLBACK doesn't release, would carry over to later
 * calls on that pooled connection. A connection that can't be put back is
 * closed instead.
 */
async function run(sql: string, params: unknown[], max = MAX_ROWS): Promise<Rows> {
  const { pool, mode } = await connection();
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    if (mode === "read-only") await client.query("BEGIN READ ONLY");
    return await collect(client, sql, params, max);
  } catch (err) {
    const e = err as { message?: string; code?: string };
    if (e.code === "25006") throw new Error(`${e.message}: this connector is read-only (set POSTGRES_MODE=read-write to allow changes)`);
    if (e.code === "42601" && /multiple commands/.test(e.message ?? "")) throw new Error("one statement per query: run them one at a time");
    throw err;
  } finally {
    await putBack(client);
  }
}

async function putBack(client: pg.PoolClient): Promise<void> {
  try {
    // Ends the read-only transaction, or one the statement left open in
    // read-write mode (each call stands alone). DISCARD ALL can't run inside
    // a transaction, so it comes second: it resets every setting, releases
    // advisory locks, drops temporary tables and stops LISTENing.
    await client.query("ROLLBACK");
    await client.query("DISCARD ALL");
    client.release();
  } catch (err) {
    client.release(err as Error);
  }
}

/**
 * The schema an unqualified table name means: the first on the search path
 * that has one, as PostgreSQL itself resolves it. Matching the name in every
 * schema instead mixed the columns of public.users and auth.users together.
 */
async function schemaOf(name: string): Promise<string> {
  const { rows } = await run(
    `SELECT t.table_schema AS schema, p.position
       FROM information_schema.tables t
       LEFT JOIN unnest(current_schemas(false)) WITH ORDINALITY AS p(schema, position) ON p.schema = t.table_schema
      WHERE t.table_name = $1
      ORDER BY p.position NULLS LAST, 1`,
    [name],
  );
  if (rows.length === 0) throw new Error(`no table called ${name} (list_tables shows what there is)`);
  if (rows[0]!.position !== null) return String(rows[0]!.schema);
  const schemas = rows.map((r) => String(r.schema));
  throw new Error(`no table called ${name} on the search path; there's one in ${schemas.join(", ")}: name it as ${schemas[0]}.${name}`);
}

export default defineApp((app) => {
  app.export({
    name: "query",
    input: z.object({ sql: z.string(), params: z.array(z.any()) }),
    output: z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.any())), row_count: z.number(), truncated: z.boolean() }),
    handler: async ({ sql, params }) => {
      if (!sql.trim()) throw new Error("sql is empty");
      const { columns, rows, rowCount, truncated } = await run(sql, params);
      return { columns, rows, row_count: rowCount, truncated };
    },
  });

  app.export({
    name: "list_tables",
    input: z.object({ schema: z.string() }),
    output: z.object({ tables: z.array(z.object({ schema: z.string(), name: z.string(), type: z.string() })) }),
    handler: async ({ schema }) => {
      const result = await run(
        `SELECT table_schema AS schema, table_name AS name, table_type AS type
           FROM information_schema.tables
          WHERE ($1 = '' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%')
             OR table_schema = $1
          ORDER BY 1, 2 LIMIT 1000`,
        [schema],
        1000,
      );
      return { tables: result.rows as { schema: string; name: string; type: string }[] };
    },
  });

  app.export({
    name: "describe_table",
    input: z.object({ table: z.string() }),
    output: z.object({ columns: z.array(z.object({ name: z.string(), type: z.string(), nullable: z.boolean(), default: z.string().nullable() })) }),
    handler: async ({ table }) => {
      const parts = table.split(".");
      if (parts.length > 2 || parts.some((p) => !p)) throw new Error(`${table}: name a table as table or schema.table`);
      const [schema, name] = parts.length === 2 ? (parts as [string, string]) : [await schemaOf(parts[0]!), parts[0]!];
      const result = await run(
        `SELECT column_name AS name, data_type AS type, is_nullable = 'YES' AS nullable, column_default AS default
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [schema, name],
      );
      if (result.rows.length === 0) throw new Error(`no table called ${table} (list_tables shows what there is)`);
      return { columns: result.rows as { name: string; type: string; nullable: boolean; default: string | null }[] };
    },
  });

  app.export({
    name: "connection_info",
    output: z.object({ host: z.string(), port: z.number(), database: z.string(), user: z.string(), mode: z.string(), route: z.string() }),
    handler: async () => {
      const { target, route, mode } = await connection();
      return { ...target, mode, route: route.kind === "proxy" ? "through the egress proxy" : "direct" };
    },
  });
});
