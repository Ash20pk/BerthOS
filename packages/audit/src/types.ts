/**
 * How an actor's identity was established. This is the field that makes the
 * rest of the record worth anything: REMEDIATION.md 5.1's complaint about
 * `decided_by` was not that the name was missing, it was that a name the
 * caller typed into a request body was being recorded as if it were a fact.
 *
 * - "peer-socket" — the kernel said so. SO_PEERCRED on the two daemons'
 *   control sockets, or the per-caller peers directory the SDK's RPC server
 *   uses where Node can't reach SO_PEERCRED (`sdk/src/rpc.ts`). Unforgeable
 *   by the caller.
 * - "token" — a bearer credential the actor holds and the requester never
 *   sees. Proves possession of a secret bound to that name, nothing more.
 * - "self-asserted" — the actor named itself and nothing checked. Recorded
 *   rather than rejected, because "we don't know who this was" is itself an
 *   audit finding, but never write one of these and call it an actor.
 */
export type ActorVerification = "peer-socket" | "token" | "self-asserted";

export interface Actor {
  /** "operator" (a human running the CLI), "app" (a resident app), "agent" (an Agent run), "anonymous" (unauthenticated). */
  kind: "operator" | "app" | "agent" | "anonymous";
  /** Operator name, app name, or agent name. "unknown" for anonymous. */
  id: string;
  verifiedBy: ActorVerification;
}

/** The decision an audit record is about. "unavailable" is distinct from "denied" on purpose — see GovernanceUnavailableError. */
export type AuditDecision = "allowed" | "denied" | "unavailable";

export interface AuditEvent {
  /** ISO-8601. */
  ts: string;
  /** Monotonic within one sink instance, so records that share a timestamp still order. */
  seq: number;
  actor: Actor;
  /** Dotted verb: "governance.evaluate", "grant.approve", "agent.tool-call", "http.request". */
  action: string;
  /** What the action was performed on — an app/export pair, a grant id, a route. */
  target?: string;
  decision: AuditDecision;
  /** Why, when there is a why. Always set for "denied" and "unavailable". */
  reason?: string;
  /** Present only when the sink was built with capturePayloads — always redacted first. */
  input?: unknown;
  /** Present only when the sink was built with capturePayloads — always redacted first. */
  output?: unknown;
  durationMs?: number;
  /** Free-form extras a caller wants on the record; redacted alongside input/output. */
  meta?: Record<string, unknown>;
}

/**
 * A written record: the event plus the chain fields the sink adds. Callers
 * build AuditEvents; only the sink produces these.
 */
export interface AuditRecord extends AuditEvent {
  /** sha256 of the previous record's `hash`, or 64 zeros for the first record in a file. */
  prevHash: string;
  /** sha256 over prevHash + the canonical JSON of this record's event fields. */
  hash: string;
}

/**
 * Where audit records go. Deliberately one method: a sink that is hard to
 * implement is a sink nobody routes their denials through, and an unrouted
 * denial is exactly the finding 5.1 opens with.
 *
 * Implementations must not throw — an audit backend having a bad day must
 * never turn into a failed tool call or a 500. Report the problem on stderr
 * and drop the record; `createFileAuditSink` does this.
 */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}
