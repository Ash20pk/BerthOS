import type { FastifyInstance, FastifyRequest } from "fastify";
import { parse as parseYaml } from "yaml";
import { validateManifest, ManifestValidationError } from "@berth/manifest-schema";
import type { RegistryDb, AppRecord } from "./db.js";
import type { BlobStore } from "./storage.js";

export interface RegistryRouteOptions {
  db: RegistryDb;
  blobs: BlobStore;
  /** Injected so tests can pin a deterministic value instead of asserting against wall-clock time. */
  now?: () => string;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function summarize(record: AppRecord) {
  return {
    name: record.name,
    version: record.version,
    description: record.description,
    author: record.author,
    capabilities: record.capabilities,
    exports: record.exports,
    publishedAt: record.publishedAt,
  };
}

export async function registerRegistryRoutes(app: FastifyInstance, opts: RegistryRouteOptions): Promise<void> {
  const { db, blobs } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  app.post("/apps", async (request, reply) => {
    const parts = request.parts();
    let manifestText: string | undefined;
    let author = "";
    let bundleBytes: Buffer | undefined;

    for await (const part of parts) {
      if (part.type === "file" && part.fieldname === "bundle") {
        bundleBytes = await part.toBuffer();
      } else if (part.type === "field" && part.fieldname === "manifest") {
        manifestText = String(part.value);
      } else if (part.type === "field" && part.fieldname === "author") {
        author = String(part.value);
      }
    }

    if (!manifestText) return reply.code(400).send({ error: "missing 'manifest' field (berth.yml contents)" });
    if (!bundleBytes) return reply.code(400).send({ error: "missing 'bundle' file (publish-bundle.tar.gz)" });

    let manifest;
    try {
      manifest = validateManifest(parseYaml(manifestText));
    } catch (err) {
      if (err instanceof ManifestValidationError) return reply.code(400).send({ error: err.message });
      return reply.code(400).send({ error: `could not parse manifest: ${err instanceof Error ? err.message : String(err)}` });
    }

    // Namespace ownership, npm/PyPI-style: the first publish of a name mints
    // its owner token (returned once, below); every later publish of that
    // same name must present it. A brand-new name needs no token — nothing
    // to prove ownership of yet.
    const isNewName = !db.ownerExists(manifest.name);
    if (!isNewName && !db.verifyOwnerToken(manifest.name, bearerToken(request))) {
      return reply.code(401).send({ error: `"${manifest.name}" is already published by someone else — provide its owner token to publish a new version` });
    }

    const bundlePath = await blobs.write(manifest.name, manifest.version, bundleBytes);

    try {
      db.insert({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author,
        capabilities: manifest.capabilities,
        exports: manifest.exports.map((e) => e.name),
        manifest: manifest as unknown as Record<string, unknown>,
        bundlePath,
        bundleSize: bundleBytes.length,
        publishedAt: now(),
      });
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }

    // Minted only after insert() actually succeeds — a rejected first
    // publish (e.g. a duplicate version somehow raced in) shouldn't claim
    // the namespace with no app behind it.
    const ownerToken = isNewName ? db.registerOwner(manifest.name, now()) : undefined;

    return reply.code(201).send({
      name: manifest.name,
      version: manifest.version,
      publishedAt: now(),
      ...(ownerToken ? { ownerToken } : {}),
    });
  });

  app.get("/apps", async (request) => {
    const { q } = request.query as { q?: string };
    return db.listLatestPerApp(q).map(summarize);
  });

  app.get<{ Params: { name: string } }>("/apps/:name", async (request, reply) => {
    const versions = db.listVersions(request.params.name);
    if (versions.length === 0) return reply.code(404).send({ error: `no app named "${request.params.name}"` });
    return versions.map(summarize);
  });

  app.get<{ Params: { name: string; version: string } }>("/apps/:name/:version", async (request, reply) => {
    const record = resolveVersion(db, request.params.name, request.params.version);
    if (!record) return reply.code(404).send({ error: `${request.params.name}@${request.params.version} not found` });
    return summarize(record);
  });

  app.get<{ Params: { name: string; version: string } }>("/apps/:name/:version/download", async (request, reply) => {
    const record = resolveVersion(db, request.params.name, request.params.version);
    if (!record) return reply.code(404).send({ error: `${request.params.name}@${request.params.version} not found` });
    const bytes = await blobs.read(record.bundlePath);
    return reply.header("content-type", "application/gzip").send(bytes);
  });
}

function resolveVersion(db: RegistryDb, name: string, version: string): AppRecord | undefined {
  return version === "latest" ? db.getLatest(name) : db.get(name, version);
}
