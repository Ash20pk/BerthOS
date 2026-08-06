import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { GrantsDb, GrantStatus } from "./db.js";

export interface GrantsRouteOptions {
  db: GrantsDb;
  /** Injected so tests can pin a deterministic value instead of asserting against wall-clock time. */
  now?: () => string;
  /**
   * Best-effort push notification on every new pending grant — e.g. a Slack
   * incoming-webhook URL. Failures are logged, never fail the request: this
   * is the "push" half of the async approval flow, not a required dependency.
   */
  webhookUrl?: string;
  /**
   * Required bearer token for POST /grants/:id/approve|deny. `POST /grants`
   * (a sandboxed app requesting a capability) and `GET /grants` (listing)
   * deliberately stay open — the vulnerability this closes is a requester
   * deciding its *own* pending request, not a requester seeing the queue.
   */
  operatorToken: string;
}

function isGrantStatus(value: unknown): value is GrantStatus {
  return value === "pending" || value === "approved" || value === "denied";
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/** Constant-time-ish comparison — this token gates a capability escalation decision, worth not leaking via timing. */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

async function notifyWebhook(webhookUrl: string, payload: unknown): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`[berth-grants] WARNING: webhook notification to ${webhookUrl} failed: ${err}`);
  }
}

export async function registerGrantsRoutes(app: FastifyInstance, opts: GrantsRouteOptions): Promise<void> {
  const { db, webhookUrl, operatorToken } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  app.post<{ Body: { appName?: string; capability?: string; reason?: string } }>("/grants", async (request, reply) => {
    const { appName, capability, reason } = request.body ?? {};
    if (!appName || !capability) {
      return reply.code(400).send({ error: "appName and capability are required" });
    }

    const grant = db.create(appName, capability, reason, now);
    if (webhookUrl) {
      void notifyWebhook(webhookUrl, { event: "grant.requested", grant });
    }
    return reply.code(201).send(grant);
  });

  app.get<{ Querystring: { status?: string; app?: string } }>("/grants", async (request, reply) => {
    const { status, app: appName } = request.query;
    if (status !== undefined && !isGrantStatus(status)) {
      return reply.code(400).send({ error: `invalid status "${status}" — expected pending, approved, or denied` });
    }
    return reply.send(db.list({ status, appName }));
  });

  app.get<{ Params: { id: string } }>("/grants/:id", async (request, reply) => {
    const grant = db.get(request.params.id);
    if (!grant) return reply.code(404).send({ error: `no grant with id "${request.params.id}"` });
    return reply.send(grant);
  });

  app.post<{ Params: { id: string }; Body: { decidedBy?: string } }>("/grants/:id/approve", async (request, reply) => {
    if (!tokenMatches(bearerToken(request), operatorToken)) {
      return reply.code(401).send({ error: "missing or invalid operator token" });
    }
    const { decidedBy } = request.body ?? {};
    if (!decidedBy) return reply.code(400).send({ error: "decidedBy is required" });

    try {
      const grant = db.decide(request.params.id, "approved", decidedBy, now);
      if (!grant) return reply.code(404).send({ error: `no grant with id "${request.params.id}"` });
      return reply.send(grant);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { decidedBy?: string; reason?: string } }>(
    "/grants/:id/deny",
    async (request, reply) => {
      if (!tokenMatches(bearerToken(request), operatorToken)) {
        return reply.code(401).send({ error: "missing or invalid operator token" });
      }
      const { decidedBy, reason } = request.body ?? {};
      if (!decidedBy) return reply.code(400).send({ error: "decidedBy is required" });

      try {
        const grant = db.decide(request.params.id, "denied", decidedBy, now, reason);
        if (!grant) return reply.code(404).send({ error: `no grant with id "${request.params.id}"` });
        return reply.send(grant);
      } catch (err) {
        return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
