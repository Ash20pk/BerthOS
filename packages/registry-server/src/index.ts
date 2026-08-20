import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { join } from "node:path";
import type { ServerTlsOptions } from "@berth/tls";
import { RegistryDb } from "./db.js";
import { BlobStore } from "./storage.js";
import { registerRegistryRoutes } from "./routes.js";

export { RegistryDb, compareSemver, type AppRecord } from "./db.js";
export { BlobStore } from "./storage.js";

export interface CreateRegistryServerOptions {
  /** Directory for the SQLite index and blob storage. Created if missing. */
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
   * `berth-registry` binary turns it on. REMEDIATION.md 5.1 counted "no HTTP
   * access logs on any server" among its findings — a request that reached
   * this server previously left no trace at all.
   */
  logger?: boolean;
}

/** Builds a ready-to-listen Fastify instance; the caller decides host/port and when to close it. */
export async function createRegistryServer(opts: CreateRegistryServerOptions): Promise<FastifyInstance> {
  const db = new RegistryDb(join(opts.dataDir, "registry.sqlite"));
  const blobs = new BlobStore(join(opts.dataDir, "blobs"));

  // `https: null` rather than conditionally spreading the option: a
  // `{https} | {}` union makes TypeScript pick Fastify's HTTP/2-secure
  // overload and the instance type stops matching FastifyInstance. `null` is
  // Fastify's own spelling for "no TLS" and resolves one overload cleanly.
  const app = Fastify({ bodyLimit: 100 * 1024 * 1024, https: opts.tls ?? null, logger: opts.logger ?? false });

  // Liveness for process supervisors and the CLI's status checks
  // (BUILD_PLAN M0.5). Deliberately unauthenticated and DB-free: it answers
  // "is the process serving" and nothing else.
  app.get("/health", async () => ({ status: "ok" }));
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await registerRegistryRoutes(app, { db, blobs, now: opts.now });

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
