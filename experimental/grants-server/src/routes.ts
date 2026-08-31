import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { anonymousActor, operatorActor, type AuditSink } from "@berth/audit";
import type { GrantsDb, GrantStatus } from "./db.js";
import type { OperatorRegistry } from "./operators.js";

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
   * Authenticates POST /grants/:id/approve|deny and names the operator behind
   * the token. `POST /grants` (a sandboxed app requesting a capability) and
   * `GET /grants` (listing) deliberately stay open — the vulnerability this
   * closes is a requester deciding its *own* pending request, not a requester
   * seeing the queue.
   */
  operators: OperatorRegistry;
  /** Every decision, and every rejected attempt at one, is recorded here when set. */
  audit?: AuditSink;
}

function isGrantStatus(value: unknown): value is GrantStatus {
  return value === "pending" || value === "approved" || value === "denied";
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
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
  const { db, webhookUrl, operators, audit } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  const record = (event: {
    action: string;
    target?: string;
    decision: "allowed" | "denied";
    actorName?: string;
    reason?: string;
    meta?: Record<string, unknown>;
  }) =>
    audit
      ?.record({
        ts: now(),
        seq: 0,
        actor: event.actorName ? operatorActor(event.actorName) : anonymousActor(),
        action: event.action,
        target: event.target,
        decision: event.decision,
        reason: event.reason,
        meta: event.meta,
      })
      .catch(() => {});

  /**
   * Resolves the caller to a named operator, or replies 401. The name comes
   * from the registry entry the presented token belongs to and never from the
   * request — that substitution is the whole point of REMEDIATION.md 5.1's
   * `decided_by` finding.
   */
  async function requireOperator(request: FastifyRequest, reply: FastifyReply, target: string): Promise<string | undefined> {
    const name = operators.resolve(bearerToken(request));
    if (!name) {
      // A failed approval attempt is a security event in its own right, and
      // is exactly what a reviewer scanning for credential probing needs.
      await record({ action: "grant.authenticate", target, decision: "denied", reason: "missing or invalid operator token" });
      void reply.code(401).send({ error: "missing or invalid operator token" });
      return undefined;
    }
    return name;
  }

  app.post<{ Body: { appName?: string; capability?: string; reason?: string } }>("/grants", async (request, reply) => {
    const { appName, capability, reason } = request.body ?? {};
    if (!appName || !capability) {
      return reply.code(400).send({ error: "appName and capability are required" });
    }

    const grant = db.create(appName, capability, reason, now);
    // The requester names itself and nothing checks it — an app asking for a
    // capability reaches this over plain HTTP with no credential. Recorded as
    // a self-asserted app actor rather than dressed up as an operator.
    await audit
      ?.record({
        ts: now(),
        seq: 0,
        actor: { kind: "app", id: appName, verifiedBy: "self-asserted" },
        action: "grant.request",
        target: `grant:${grant.id}`,
        decision: "allowed",
        reason,
        meta: { capability },
      })
      .catch(() => {});
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

  app.post<{ Params: { id: string } }>("/grants/:id/approve", async (request, reply) => {
    const target = `grant:${request.params.id}`;
    const decidedBy = await requireOperator(request, reply, target);
    if (!decidedBy) return reply;

    try {
      const grant = db.decide(request.params.id, "approved", decidedBy, now);
      if (!grant) return reply.code(404).send({ error: `no grant with id "${request.params.id}"` });
      await record({
        action: "grant.approve",
        target,
        decision: "allowed",
        actorName: decidedBy,
        meta: { appName: grant.appName, capability: grant.capability },
      });
      return reply.send(grant);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/grants/:id/deny", async (request, reply) => {
    const target = `grant:${request.params.id}`;
    const decidedBy = await requireOperator(request, reply, target);
    if (!decidedBy) return reply;
    const { reason } = request.body ?? {};

    try {
      const grant = db.decide(request.params.id, "denied", decidedBy, now, reason);
      if (!grant) return reply.code(404).send({ error: `no grant with id "${request.params.id}"` });
      await record({
        action: "grant.deny",
        target,
        decision: "denied",
        actorName: decidedBy,
        reason,
        meta: { appName: grant.appName, capability: grant.capability },
      });
      return reply.send(grant);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
