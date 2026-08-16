import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import type { AuditSink } from "@berth/audit";
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

  const app = Fastify({ logger: opts.logger ?? false });
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
