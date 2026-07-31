import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { join } from "node:path";
import { RegistryDb } from "./db.js";
import { BlobStore } from "./storage.js";
import { registerRegistryRoutes } from "./routes.js";

export { RegistryDb, compareSemver, type AppRecord } from "./db.js";
export { BlobStore } from "./storage.js";

export interface CreateRegistryServerOptions {
  /** Directory for the SQLite index and blob storage. Created if missing. */
  dataDir: string;
  now?: () => string;
}

/** Builds a ready-to-listen Fastify instance; the caller decides host/port and when to close it. */
export async function createRegistryServer(opts: CreateRegistryServerOptions): Promise<FastifyInstance> {
  const db = new RegistryDb(join(opts.dataDir, "registry.sqlite"));
  const blobs = new BlobStore(join(opts.dataDir, "blobs"));

  const app = Fastify({ bodyLimit: 100 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await registerRegistryRoutes(app, { db, blobs, now: opts.now });

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
