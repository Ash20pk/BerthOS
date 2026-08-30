import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import type { AuditSink } from "@berth/audit";
import type { ServerTlsOptions } from "@berth/tls";
import { GrantsDb } from "./db.js";
import { registerGrantsRoutes } from "./routes.js";
import { loadOperatorRegistry, singleTokenRegistry, type OperatorRegistry } from "./operators.js";

export { GrantsDb, type GrantRecord, type GrantStatus } from "./db.js";
/** @deprecated Superseded by loadOperatorRegistry(), which names the operator behind a token instead of treating one shared secret as anonymous. Still exported so an existing caller keeps working. */
export { readOrCreateOperatorToken } from "./operator-token.js";
export {
  addOperator,
  LEGACY_OPERATOR_NAME,
  loadOperatorRegistry,
  singleTokenRegistry,
  type LoadedRegistry,
  type OperatorEntry,
  type OperatorRegistry,
} from "./operators.js";

export interface CreateGrantsServerOptions {
  /** Directory for the SQLite index. Created if missing. */
  dataDir: string;
  now?: () => string;
  webhookUrl?: string;
  /**
   * A single shared secret, for a caller that supplies its own
   * (`BERTH_GRANTS_OPERATOR_TOKEN`) rather than using the on-disk registry.
   * Decisions made with it are attributed to "operator" — a shared token
   * cannot honestly say more. Prefer named operators: see `operators`.
   */
  operatorToken?: string;
  /**
   * Serve HTTPS instead of plain HTTP. Built by `resolveServerTls()` from
   * cert/key paths — see @berth/tls and docs/tls-reference.md. Undefined
   * means plain HTTP, which is the default and what every existing
   * deployment keeps getting (REMEDIATION.md 5.3).
   */
  tls?: ServerTlsOptions;
  /**
   * Maps bearer tokens to operator names, so `decided_by` reflects the
   * credential presented rather than a string from the request body. Defaults
   * to the registry at `<dataDir>/operators.json`.
   */
  operators?: OperatorRegistry;
  /** Where grant requests, decisions, and failed authentications are recorded. */
  audit?: AuditSink;
  /**
   * Fastify's request logger. Off by default to keep test output clean;
   * `berth-grants` turns it on. REMEDIATION.md 5.1 counted "no HTTP access
   * logs on any server" among its findings.
   */
  logger?: boolean;
}

/** Builds a ready-to-listen Fastify instance; the caller decides host/port and when to close it. */
export async function createGrantsServer(opts: CreateGrantsServerOptions): Promise<FastifyInstance> {
  const db = new GrantsDb(join(opts.dataDir, "grants.sqlite"));
  const operators =
    opts.operators ??
    (opts.operatorToken ? singleTokenRegistry(opts.operatorToken) : loadOperatorRegistry(opts.dataDir).registry);

  // `https: null` rather than conditionally spreading the option: a
  // `{https} | {}` union makes TypeScript pick Fastify's HTTP/2-secure
  // overload and the instance type stops matching FastifyInstance. `null` is
  // Fastify's own spelling for "no TLS" and resolves one overload cleanly.
  const app = Fastify({ https: opts.tls ?? null, logger: opts.logger ?? false });

  // Liveness for process supervisors and the CLI's status checks
  // (BUILD_PLAN M0.5). Deliberately unauthenticated and DB-free: it answers
  // "is the process serving" and nothing else.
  app.get("/health", async () => ({ status: "ok" }));
  await registerGrantsRoutes(app, {
    db,
    now: opts.now,
    webhookUrl: opts.webhookUrl,
    operators,
    audit: opts.audit,
  });

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
