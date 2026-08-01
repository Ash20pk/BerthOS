import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import { GrantsDb } from "./db.js";
import { registerGrantsRoutes } from "./routes.js";

export { GrantsDb, type GrantRecord, type GrantStatus } from "./db.js";

export interface CreateGrantsServerOptions {
  /** Directory for the SQLite index. Created if missing. */
  dataDir: string;
  now?: () => string;
  webhookUrl?: string;
}

/** Builds a ready-to-listen Fastify instance; the caller decides host/port and when to close it. */
export async function createGrantsServer(opts: CreateGrantsServerOptions): Promise<FastifyInstance> {
  const db = new GrantsDb(join(opts.dataDir, "grants.sqlite"));

  const app = Fastify();
  await registerGrantsRoutes(app, { db, now: opts.now, webhookUrl: opts.webhookUrl });

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
