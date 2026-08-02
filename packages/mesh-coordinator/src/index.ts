import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import { MeshCoordinatorDb } from "./db.js";
import { registerMeshCoordinatorRoutes } from "./routes.js";

export { MeshCoordinatorDb, generateOwnerToken, type PeerRecord, type PeerView } from "./db.js";
export { matchesAny, globToRegExp } from "./glob.js";

export interface CreateMeshCoordinatorServerOptions {
  /** Directory for the SQLite index. Created if missing. */
  dataDir: string;
  now?: () => string;
}

/** Builds a ready-to-listen Fastify instance; the caller decides host/port and when to close it. */
export async function createMeshCoordinatorServer(opts: CreateMeshCoordinatorServerOptions): Promise<FastifyInstance> {
  const db = new MeshCoordinatorDb(join(opts.dataDir, "mesh-coordinator.sqlite"));

  const app = Fastify();
  await registerMeshCoordinatorRoutes(app, { db, now: opts.now });

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
