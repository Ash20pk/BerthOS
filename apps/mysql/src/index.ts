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

/** MYSQL_ALLOW_PRIVILEGED=true: serve a privileged user in read-only mode anyway. */
export function allowsPrivileged(env: NodeJS.ProcessEnv): boolean {
  return env.MYSQL_ALLOW_PRIVILEGED === "true";
}

// Global privileges whose statements act outside the data, where a
// read-only transaction doesn't reach: SELECT … INTO OUTFILE (FILE), SET
// GLOBAL and SET PERSIST (SUPER, SYSTEM_VARIABLES_ADMIN), FLUSH (RELOAD,
// FLUSH_*), KILL of other users' sessions (CONNECTION_ADMIN), PURGE BINARY
// LOGS (BINLOG_ADMIN), SHUTDOWN, and the rest of the *_ADMIN family.
const RISKY = new Set(["ALL", "ALL PRIVILEGES", "SUPER", "FILE", "RELOAD", "SHUTDOWN"]);

/** The risky global privileges among SHOW GRANTS lines. */
export function riskyPrivileges(grants: string[]): string[] {
  const found = new Set<string>();
  for (const line of grants) {
    const m = /^GRANT (.+?) ON \*\.\* TO /i.exec(line);
    if (!m) continue;
    for (const raw of m[1]!.split(",")) {
      const privilege = raw.trim().toUpperCase().replace(/\s+/g, " ");
      const joined = privilege.replace(/ /g, "_");
      if (RISKY.has(privilege) || /_ADMIN$/.test(joined) || /^FLUSH_/.test(joined)) found.add(privilege);
    }
  }
  return [...found];
}

export function privilegeProblem(user: string, risky: string[]): string | undefined {
  if (risky.length === 0) return undefined;
  const shown = risky.length > 6 ? `${risky.slice(0, 6).join(", ")} and ${risky.length - 6} more` : risky.join(", ");
  return `DATABASE_URL's user ${user} has global privileges (${shown}) that read-only mode can't hold back: it can still write files on the database server with SELECT … INTO OUTFILE, change server settings with SET GLOBAL or SET PERSIST, FLUSH, KILL other sessions or purge the binary logs, none of which a read-only transaction stops. Give DATABASE_URL a user that can only read what the agent should see, or, to accept that, set MYSQL_ALLOW_PRIVILEGED=true and restart the app.`;
}

/**
 * The user's grants, and those of the roles granted to it, which in MySQL 8
 * SHOW GRANTS names but doesn't expand.
 */
async function grantsOf(conn: mysql.PoolConnection): Promise<string[]> {
  const lines = async (sql: string) => ((await conn.query(sql))[0] as Record<string, unknown>[]).map((r) => String(Object.values(r)[0]));
  const own = await lines("SHOW GRANTS");
  const roles = own.flatMap((l) => /^GRANT ((?:`[^`]*`(?:@`[^`]*`)?)(?:\s*,\s*`[^`]*`(?:@`[^`]*`)?)*) TO /.exec(l)?.[1] ?? []);
  if (roles.length === 0) return own;
  try {
    return [...own, ...(await lines(`SHOW GRANTS FOR CURRENT_USER() USING ${roles.join(", ")}`))];
  } catch {
    // MariaDB has no USING: ask for each role's grants instead.
    const each = await Promise.all(roles.flatMap((r) => r.split(/\s*,\s*/)).map((r) => lines(`SHOW GRANTS FOR ${r}`).catch(() => [])));
    return [...own, ...each.flat()];
  }
}

const hex = (value: Buffer) => `0x${value.toString("hex")}`;

/**
 * A value with everything JSON can't carry turned into text, all the way
 * down: a Buffer inside a JSON column's array otherwise serialized as
 * {"type":"Buffer","data":[…]}, and a bigint threw.
 */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return hex(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") return plain((value as { toJSON: () => unknown }).toJSON());
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** A value made safe to hand back as JSON, and small enough to read. */
export function cell(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Buffer.isBuffer(value)) return value.length > MAX_CELL_CHARS / 2 ? `${hex(value.subarray(0, MAX_CELL_CHARS / 2))}…` : hex(value);
  if (typeof value === "string") return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value;
  const safe = plain(value);
  if (typeof safe === "string") return safe.length > MAX_CELL_CHARS ? `${safe.slice(0, MAX_CELL_CHARS)}…` : safe;
  const text = JSON.stringify(safe);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : safe;
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
  if (!isInternal(target.host) && !config.ssl) {
    console.error(`[mysql] DATABASE_URL points at ${target.host}, not a local address, without TLS: the password and every row cross the network unencrypted. Add ?ssl=true to DATABASE_URL.`);
  }
  const pool = mysql.createPool({
    ...config,
    connectionLimit: 2,
    connectTimeout: 15_000,
    // Off, so the server refuses a string holding more than one statement.
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // DATE, DATETIME and TIMESTAMP as the text the server sends. As a Date,
    // mysql2 read them in the app's local time zone: east of UTC a DATE
    // became local midnight, which toISOString() shifted to the day before.
    dateStrings: true,
    ...(route.kind === "proxy"
      ? { stream: () => new ProxyTunnel(route.proxy).connect(target.port, target.host) as unknown as import("node:net").Socket }
      : {}),
  });
  if (mode === "read-only" && !allowsPrivileged(process.env)) {
    try {
      const conn = await pool.getConnection();
      let problem: string | undefined;
      try {
        problem = privilegeProblem(target.user, riskyPrivileges(await grantsOf(conn)));
      } finally {
        conn.release();
      }
      if (problem) throw new Error(problem);
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
  }
  return { pool, target, route, mode };
}

export interface Rows {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows returned, for a statement that returns rows; otherwise rows changed. */
  rowCount: number;
  truncated: boolean;
  /** The result was cut off before its end, so the connection is mid-result and can't be reused. */
  abandoned: boolean;
}

interface CoreQuery {
  on(event: "fields", listener: (fields: { name: string }[] | undefined) => void): this;
  on(event: "result", listener: (row: Record<string, unknown>) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "end", listener: () => void): this;
}

interface CoreConnection {
  query(options: { sql: string; values: unknown[] }): CoreQuery;
  pause(): void;
  stream: { destroy(): void };
}

/**
 * The statement's rows, a row at a time. mysql2's promise query read every
 * row of the result into memory before any cap applied, and a SELECT over a
 * few million rows took the app down; without a callback, the driver hands
 * over each row as it's parsed and keeps none. Once the collector is full
 * this stops reading: the result is abandoned mid-stream, and the caller
 * closes the connection rather than read the rest.
 *
 * Of several result sets (a CALL returns its SELECT's rows, then a status),
 * the rows are the first set's; a statement that returns none reports the
 * rows it changed.
 */
function collect(conn: mysql.PoolConnection, sql: string, params: unknown[], max: number): Promise<Rows> {
  const core = (conn as unknown as { connection: CoreConnection }).connection;
  return new Promise((resolve, reject) => {
    const out = new Collector(max);
    let sets = 0;
    let current: { name: string }[] | undefined;
    // The result set the rows come from: the first that has columns.
    let rowSet: { index: number; columns: string[] } | undefined;
    let affected: number | undefined;
    let settled = false;
    // This app's own timer, not mysql2's timeout option: that one's timer
    // outlives a result abandoned mid-stream, and kept the process alive.
    const timer = setTimeout(() => fail(Object.assign(new Error(`the query took longer than ${QUERY_TIMEOUT_MS / 1000} s, and was abandoned`), { code: "QUERY_TIMEOUT" })), QUERY_TIMEOUT_MS);
    const finish = (abandoned: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ columns: rowSet?.columns ?? [], rows: out.rows, rowCount: rowSet ? out.rows.length : (affected ?? 0), truncated: out.truncated, abandoned });
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    core
      .query({ sql, values: params })
      .on("fields", (fields) => {
        sets++;
        current = fields;
        if (fields && !rowSet) rowSet = { index: sets, columns: fields.map((f) => f.name) };
      })
      .on("result", (row) => {
        if (settled) return;
        // A status, not a row: what an INSERT, UPDATE or DELETE changed.
        if (!current) affected ??= Number((row as { affectedRows?: number }).affectedRows ?? 0);
        else if (sets === rowSet?.index && !out.add(row)) {
          core.pause();
          finish(true);
        }
      })
      .on("error", fail)
      .on("end", () => finish(false));
  });
}

/**
 * One statement per call; multipleStatements is off, so the server refuses
 * a second one. In read-only mode it runs with the session read-only and
 * inside START TRANSACTION READ ONLY … ROLLBACK, so it can't change data or
 * the schema. That's a guard in this app, not in the
 * database: for a guarantee, give DATABASE_URL a user that can only read.
 */
async function run(sql: string, params: unknown[], max = MAX_ROWS): Promise<Rows> {
  const { pool, mode } = await connection();
  const conn = await pool.getConnection();
  // Whether the connection can go back to the pool: not if a result was
  // abandoned mid-stream, or the connection itself failed.
  let reusable = true;
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
    const result = await collect(conn, sql, params, max);
    if (result.abandoned) reusable = false;
    return result;
  } catch (err) {
    const e = err as { message?: string; errno?: number; fatal?: boolean; code?: string };
    // After a timeout the query may still be running, and its rows arriving.
    if (e.fatal || e.code === "QUERY_TIMEOUT") reusable = false;
    if (e.errno === 1792) throw new Error(`${e.message}: this connector is read-only (set MYSQL_MODE=read-write to allow changes)`);
    if (e.errno === 1064 && /;\s*\S/.test(sql)) throw new Error(`${e.message} (one statement per query: run them one at a time)`);
    throw err;
  } finally {
    if (reusable) await putBack(conn);
    else discard(conn);
  }
}

/**
 * Returns a connection to the pool as it was when it connected. Without this
 * a statement's session state stayed on the pooled connection for later
 * calls: a SET SESSION sql_mode, a user variable, a GET_LOCK() lock, which
 * no ROLLBACK releases. COM_RESET_CONNECTION rolls back, resets every session
 * variable to its global value (the character set too, so it's set again),
 * and releases locks and temporary tables. The per-call flags (read-only,
 * above) are set again at the start of the next call. A connection that
 * can't be reset is closed instead.
 */
async function putBack(conn: mysql.PoolConnection): Promise<void> {
  try {
    await conn.reset();
    await conn.query("SET NAMES utf8mb4");
    conn.release();
  } catch {
    discard(conn);
  }
}

/**
 * Closes a connection the pool mustn't hand out again. The socket is torn
 * down, not ended: the server is still sending the rest of an abandoned
 * result, and gives up on the query once it can't.
 */
function discard(conn: mysql.PoolConnection): void {
  const core = (conn as unknown as { connection: CoreConnection & { on(event: "error", listener: () => void): void } }).connection;
  core.on("error", () => {});
  conn.destroy();
  core.stream.destroy();
}

/** For tests: close the pool, whose idle connections would keep the process alive. */
export async function closeForTests(): Promise<void> {
  const current = opened;
  opened = undefined;
  await (await current?.catch(() => undefined))?.pool.end().catch(() => {});
}

/**
 * With no database in DATABASE_URL, DATABASE() is NULL, and a lookup in "the
 * URL's database" quietly matched nothing: list_tables said there were no
 * tables. Say so instead.
 */
async function requireDefaultDatabase(what: string): Promise<void> {
  const { target } = await connection();
  if (!target.database) {
    throw new Error(`DATABASE_URL names no database, so ${what} has none to default to: name one (query SHOW DATABASES lists them), or add /<database> to DATABASE_URL`);
  }
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
      if (!schema) await requireDefaultDatabase("list_tables with schema \"\"");
      const result = await run(
        `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS type
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = IF(? = '', DATABASE(), ?)
          ORDER BY 1, 2 LIMIT 1000`,
        [schema, schema],
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
      const [schema, name] = table.includes(".") ? (table.split(".", 2) as [string, string]) : ["", table];
      if (!schema) await requireDefaultDatabase(`describe_table of a bare ${table}`);
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
