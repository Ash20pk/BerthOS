import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MeshCoordinatorDb } from "./db.js";

export interface MeshCoordinatorRouteOptions {
  db: MeshCoordinatorDb;
  /** Injected so tests can pin a deterministic value instead of asserting against wall-clock time. */
  now?: () => string;
}

const NAME_RE = /^[a-z0-9-]+$/;

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

interface RegisterBody {
  name: string;
  publicKey: string;
  endpointHost: string;
  endpointPort: number;
  meshPeerPatterns?: string[];
}

export async function registerMeshCoordinatorRoutes(app: FastifyInstance, opts: MeshCoordinatorRouteOptions): Promise<void> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  app.post<{ Body: RegisterBody }>("/peers", async (request, reply) => {
    const { name, publicKey, endpointHost, endpointPort } = request.body;
    const meshPeerPatterns = request.body.meshPeerPatterns ?? [];

    if (!name || !NAME_RE.test(name)) {
      return reply.code(400).send({ error: "name must be lowercase alphanumeric with dashes" });
    }
    if (!publicKey || !endpointHost || !Number.isInteger(endpointPort)) {
      return reply.code(400).send({ error: "publicKey, endpointHost, and endpointPort (integer) are required" });
    }

    // Re-registration of an existing name (e.g. a container restart) must
    // present the token minted on first registration — the one thing
    // stopping any other TCP-reachable peer from hijacking that identity by
    // re-POSTing the same name with a different key/endpoint. A brand-new
    // name needs no token; one is minted and returned exactly once.
    if (db.exists(name) && !db.verifyToken(name, bearerToken(request))) {
      return reply.code(401).send({ error: `"${name}" is already registered — provide its owner token to update it` });
    }

    const { record, ownerToken } = db.upsert({
      name,
      publicKey,
      endpointHost,
      endpointPort,
      meshPeerPatterns,
      now: now(),
    });

    return reply.code(ownerToken ? 201 : 200).send({
      meshIp: record.meshIp,
      ...(ownerToken ? { ownerToken } : {}),
      peers: db.mutualPeersFor(name),
    });
  });

  app.get("/peers", async (request, reply) => {
    const { name } = request.query as { name?: string };
    if (!name) return reply.code(400).send({ error: "?name=<your-registered-name> is required" });
    if (!db.exists(name)) return reply.code(404).send({ error: `no peer named "${name}"` });
    if (!db.verifyToken(name, bearerToken(request))) {
      return reply.code(401).send({ error: "invalid or missing owner token" });
    }
    return { peers: db.mutualPeersFor(name) };
  });

  app.delete<{ Params: { name: string } }>("/peers/:name", async (request, reply) => {
    const { name } = request.params;
    if (!db.exists(name)) return reply.code(404).send({ error: `no peer named "${name}"` });
    if (!db.verifyToken(name, bearerToken(request))) {
      return reply.code(401).send({ error: "invalid or missing owner token" });
    }
    db.remove(name);
    return reply.code(204).send();
  });
}
