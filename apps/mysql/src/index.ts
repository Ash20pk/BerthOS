import { defineApp } from "@berthos/sdk";
import { loadManifest } from "@berthos/manifest-schema";
import { z } from "zod";
import mysql from "mysql2/promise";
import { isAllowed, patternsFrom, type HostPattern } from "./hosts.js";
import { ProxyTunnel } from "./tunnel.js";

const MAX_ROWS = 500;
const MAX_RESULT_CHARS = 200_000;
const MAX_CELL_CHARS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

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
    throw new Error("DATABASE_URL isn't a valid URL: it should look like mysql://user:password@host:3306/database");
  }
  if (url.protocol !== "mysql:") throw new Error(`DATABASE_URL should start with mysql://, not ${url.protocol}//`);
  return { host: url.hostname, port: Number(url.port) || 3306, database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username) };
}

export interface Config {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | undefined;
  ssl: { rejectUnauthorized: boolean } | undefined;
}

/**
 * The connection settings, built from DATABASE_URL's parts rather than handed
 * to mysql2 as a uri: mysql2 applies every query option of the URL over the
 * config, so `?multipleStatements=true` turned multi-statement strings back
 * on. The only options read are the TLS ones; the rest are returned as
 * ignored.
 */
export function configOf(connectionString: string): { config: Config; ignored: string[] } {
  const target = targetOf(connectionString);
  const url = new URL(connectionString);
  let ssl: Config["ssl"];
  const ignored: string[] = [];
  for (const [key, value] of url.searchParams) {
    if (key === "ssl") ssl = sslFrom(value);
    else if (key === "sslmode" || key === "ssl-mode") ssl = /^disabled?$/i.test(value) ? undefined : { rejectUnauthorized: true };
    else ignored.push(key);
  }
  return {
    config: { host: target.host, port: target.port, user: target.user, password: decodeURIComponent(url.password), database: target.database || undefined, ssl },
    ignored,
  };
}

/** `ssl=true`, or mysql2's JSON form, of which only rejectUnauthorized is read. */
function sslFrom(value: string): Config["ssl"] {
  if (value === "true" || value === "1") return { rejectUnauthorized: true };
  if (value === "false" || value === "0" || value === "") return undefined;
  try {
    const parsed = JSON.parse(value) as { rejectUnauthorized?: unknown };
    return { rejectUnauthorized: parsed.rejectUnauthorized !== false };
  } catch {
    throw new Error(`DATABASE_URL's ssl=${value} isn't understood: use ssl=true (or sslmode=required), which verifies the server's certificate`);
  }
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
 * How to reach the database, from what berth.yml declares: through the
 * egress proxy for a declared public `network:host:<host>:<port>`, or
 * directly with `network:connect:<port>` (the kernel then allows that port to
 * any host; it's what a database on a private network needs, since the proxy
 * never tunnels to an internal address). Same rule as apps/postgres.
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
      ? `DATABASE_URL points at ${where}, an internal address, which the egress proxy never tunnels to. Declare \`- network:connect:${target.port}\` in mysql's berth.yml to connect directly (the kernel then allows port ${target.port} to any host), and restart the app.`
      : `DATABASE_URL points at ${where}, which mysql's berth.yml doesn't allow. Add \`- network:host:${where}\` (through the egress proxy, this host only), or \`- network:connect:${target.port}\` (direct, any host on that port), and restart the app.`,
  );
}

export function modeFrom(env: NodeJS.ProcessEnv): Mode {
  return env.MYSQL_MODE === "read-write" ? "read-write" : "read-only";
}

export function cell(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `0x${value.subarray(0, MAX_CELL_CHARS / 2).toString("hex")}${value.length > MAX_CELL_CHARS / 2 ? "…" : ""}`;
  if (typeof value === "string") return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value;
  const text = JSON.stringify(value);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : value;
}

export function shapeRows(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; truncated: boolean } {
  const out: Record<string, unknown>[] = [];
  let size = 0;
  for (const row of rows.slice(0, MAX_ROWS)) {
    const shaped = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)]));
    size += JSON.stringify(shaped).length;
    if (size > MAX_RESULT_CHARS) return { rows: out, truncated: true };
    out.push(shaped);
  }
  return { rows: out, truncated: rows.length > MAX_ROWS };
}

interface Connection {
  pool: mysql.Pool;
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
  const { config, ignored } = configOf(connectionString);
  if (ignored.length > 0) console.error(`[mysql] DATABASE_URL options ignored: ${ignored.join(", ")} (only ssl and sslmode are read)`);
  const pool = mysql.createPool({
    ...config,
    connectionLimit: 2,
    connectTimeout: 15_000,
    // Off, so the server refuses a string holding more than one statement.
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...(route.kind === "proxy"
      ? { stream: () => new ProxyTunnel(route.proxy).connect(target.port, target.host) as unknown as import("node:net").Socket }
      : {}),
  });
  return { pool, target, route, mode };
}

/**
 * One statement per call; multipleStatements is off, so the server refuses
 * a second one. In read-only mode it runs with the session read-only and
 * inside START TRANSACTION READ ONLY … ROLLBACK, so it can't change data or
 * the schema. That's a guard in this app, not in the
 * database: for a guarantee, give DATABASE_URL a user that can only read.
 */
async function run(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[]; affected: number }> {
  const { pool, mode } = await connection();
  const conn = await pool.getConnection();
  try {
    // Both, on every call. START TRANSACTION READ ONLY stops INSERT, UPDATE
    // and DELETE, but MySQL commits DDL implicitly, outside the transaction:
    // CREATE and DROP TABLE ran in a read-only transaction until the session
    // flag was set too. The flag is set again on each call because an agent
    // could turn it off with one statement, which would otherwise stay in
    // effect on this pooled connection.
    if (mode === "read-only") {
      await conn.query("SET SESSION transaction_read_only = ON");
      await conn.query("START TRANSACTION READ ONLY");
    }
    try {
      const [result, fields] = await conn.query({ sql, values: params, timeout: QUERY_TIMEOUT_MS });
      if (Array.isArray(result)) return { rows: result as Record<string, unknown>[], fields: (fields ?? []) as { name: string }[], affected: (result as unknown[]).length };
      return { rows: [], fields: [], affected: (result as mysql.ResultSetHeader).affectedRows ?? 0 };
    } finally {
      if (mode === "read-only") await conn.query("ROLLBACK").catch(() => {});
    }
  } catch (err) {
    const e = err as { message?: string; errno?: number };
    if (e.errno === 1792) throw new Error(`${e.message}: this connector is read-only (set MYSQL_MODE=read-write to allow changes)`);
    if (e.errno === 1064 && /;\s*\S/.test(sql)) throw new Error(`${e.message} (one statement per query: run them one at a time)`);
    throw err;
  } finally {
    conn.release();
  }
}

/** For tests: close the pool, whose idle connections would keep the process alive. */
export async function closeForTests(): Promise<void> {
  const current = opened;
  opened = undefined;
  await (await current?.catch(() => undefined))?.pool.end().catch(() => {});
}

export default defineApp((app) => {
  app.export({
    name: "query",
    input: z.object({ sql: z.string(), params: z.array(z.any()) }),
    output: z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.any())), row_count: z.number(), truncated: z.boolean() }),
    handler: async ({ sql, params }) => {
      if (!sql.trim()) throw new Error("sql is empty");
      const result = await run(sql, params);
      const { rows, truncated } = shapeRows(result.rows);
      return { columns: result.fields.map((f) => f.name), rows, row_count: result.affected, truncated };
    },
  });

  app.export({
    name: "list_tables",
    input: z.object({ schema: z.string() }),
    output: z.object({ tables: z.array(z.object({ schema: z.string(), name: z.string(), type: z.string() })) }),
    handler: async ({ schema }) => {
      const result = await run(
        `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS type
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = IF(? = '', DATABASE(), ?)
          ORDER BY 1, 2 LIMIT 1000`,
        [schema, schema],
      );
      return { tables: result.rows as { schema: string; name: string; type: string }[] };
    },
  });

  app.export({
    name: "describe_table",
    input: z.object({ table: z.string() }),
    output: z.object({ columns: z.array(z.object({ name: z.string(), type: z.string(), nullable: z.boolean(), default: z.string().nullable() })) }),
    handler: async ({ table }) => {
      const [schema, name] = table.includes(".") ? (table.split(".", 2) as [string, string]) : ["", table];
      const result = await run(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS \`default\`
           FROM information_schema.COLUMNS
          WHERE TABLE_NAME = ? AND TABLE_SCHEMA = IF(? = '', DATABASE(), ?)
          ORDER BY ORDINAL_POSITION`,
        [name, schema, schema],
      );
      if (result.rows.length === 0) throw new Error(`no table called ${table} (list_tables shows what there is)`);
      return {
        columns: result.rows.map((r) => ({ name: String(r.name), type: String(r.type), nullable: Boolean(Number(r.nullable)), default: r.default === null || r.default === undefined ? null : String(r.default) })),
      };
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
