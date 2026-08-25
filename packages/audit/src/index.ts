export type { Actor, ActorVerification, AuditDecision, AuditEvent, AuditRecord, AuditSink } from "./types.js";
export { redact, REDACTED, type RedactOptions } from "./redact.js";
export {
  CHAIN_GENESIS,
  combineAuditSinks,
  createConsoleAuditSink,
  createFileAuditSink,
  createMemoryAuditSink,
  defaultAuditPath,
  readAuditFile,
  verifyAuditChain,
  type ChainVerification,
  type FileAuditSinkOptions,
} from "./sink.js";

import type { Actor } from "./types.js";

/** A human who presented a named operator token. */
export function operatorActor(id: string): Actor {
  return { kind: "operator", id, verifiedBy: "token" };
}

/**
 * A resident app. `verifiedBy` is the caller's honest answer about how it
 * learned the name — "peer-socket" when the kernel established it (a peers/
 * directory socket, SO_PEERCRED), "self-asserted" when the app simply said so.
 */
export function appActor(id: string, verifiedBy: Actor["verifiedBy"]): Actor {
  return { kind: "app", id, verifiedBy };
}

/** An Agent run. Always self-asserted: the agent names itself in its own process. */
export function agentActor(id: string): Actor {
  return { kind: "agent", id, verifiedBy: "self-asserted" };
}

/** Nothing authenticated this caller. */
export function anonymousActor(): Actor {
  return { kind: "anonymous", id: "unknown", verifiedBy: "self-asserted" };
}
