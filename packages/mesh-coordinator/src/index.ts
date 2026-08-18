import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import type { ServerTlsOptions } from "@berth/tls";
import { MeshCoordinatorDb } from "./db.js";
import { registerMeshCoordinatorRoutes } from "./routes.js";

export { MeshCoordinatorDb, generateOwnerToken, type PeerRecord, type PeerView } from "./db.js";
export { matchesAny, globToRegExp } from "./glob.js";

export interface CreateMeshCoordinatorServerOptions {
  /** Directory for the SQLite index. Created if missing. */
  dataDir: string;
  now?: () => string;
  /**
   * Serve HTTPS instead of plain HTTP. Built by `resolveServerTls()` from
   * cert/key paths — see @berth/tls and docs/tls-reference.md. Undefined
   * means plain HTTP, which is the default and what every existing
   * deployment keeps getting (REMEDIATION.md 5.3).
   */
  tls?: ServerTlsOptions;
  /**
   * Fastify's request logger. Off by default so tests stay quiet; the
   * `berth-mesh-coordinator` binary turns it on. REMEDIATION.md 5.1 counted "no HTTP
   * access logs on any server" among its findings — a request that reached
   * this server previously left no trace at all.
   */
  logger?: boolean;
}

/** Builds a ready-to-listen Fastify instance; the caller decides host/port and when to close it. */
export async function createMeshCoordinatorServer(opts: CreateMeshCoordinatorServerOptions): Promise<FastifyInstance> {
  const db = new MeshCoordinatorDb(join(opts.dataDir, "mesh-coordinator.sqlite"));

  // `https: null` rather than conditionally spreading the option: a
  // `{https} | {}` union makes TypeScript pick Fastify's HTTP/2-secure
  // overload and the instance type stops matching FastifyInstance. `null` is
  // Fastify's own spelling for "no TLS" and resolves one overload cleanly.
  const app = Fastify({ https: opts.tls ?? null, logger: opts.logger ?? false });
  await registerMeshCoordinatorRoutes(app, { db, now: opts.now });

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
