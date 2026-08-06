import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import { GrantsDb } from "./db.js";
import { registerGrantsRoutes } from "./routes.js";
import { readOrCreateOperatorToken } from "./operator-token.js";

export { GrantsDb, type GrantRecord, type GrantStatus } from "./db.js";
export { readOrCreateOperatorToken } from "./operator-token.js";

export interface CreateGrantsServerOptions {
  /** Directory for the SQLite index. Created if missing. */
  dataDir: string;
  now?: () => string;
  webhookUrl?: string;
  /**
   * Bearer token required on POST /grants/:id/approve|deny. Defaults to a
   * value persisted at `<dataDir>/operator.token` (minted on first use) so a
   * caller that doesn't pass one explicitly still gets a real, restart-stable
   * secret rather than an unauthenticated approve/deny endpoint.
   */
  operatorToken?: string;
}

/** Builds a ready-to-listen Fastify instance; the caller decides host/port and when to close it. */
export async function createGrantsServer(opts: CreateGrantsServerOptions): Promise<FastifyInstance> {
  const db = new GrantsDb(join(opts.dataDir, "grants.sqlite"));
  const operatorToken = opts.operatorToken ?? readOrCreateOperatorToken(opts.dataDir);

  const app = Fastify();
  await registerGrantsRoutes(app, { db, now: opts.now, webhookUrl: opts.webhookUrl, operatorToken });

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
