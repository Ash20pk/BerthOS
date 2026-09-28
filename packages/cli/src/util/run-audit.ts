import { randomBytes } from "node:crypto";
import type { Actor, AuditRecord, AuditSink } from "@berthos/audit";
import type { BootEvidence } from "@berthos/docker-orchestrator";

/**
 * The audit trail for a run that goes through the CLI rather than through
 * @berthos/agents: `berth mcp` today. Two kinds of record, both tagged
 * `meta.runId` so `berth attest <runId>` can find them:
 *
 *  - `tool.call`, one per tool call the MCP client makes.
 *  - `sandbox.boot`, once per session: the boot evidence (boot id, the
 *    kernel's ruleset reports, policy digests, image digest, a fresh doctor
 *    probe), read while the sandbox is running.
 *
 * The second exists because `berth mcp` stops a sandbox it booted when the
 * client disconnects, and attest otherwise reads its evidence from a live
 * container. Recording it into the hash chain at the time of the run also
 * ties the evidence to the boot the run actually happened in, where a later
 * live read could be of a different boot of the same container.
 *
 * Every record also carries `meta.bridge`, an id for the bridge process that
 * wrote it: one per session. (Not `meta.session`: the sink redacts any meta
 * key containing "session" as a likely secret.) A run id
 * can be reused (--run-id) across sessions, and each session may be a
 * different boot; the session is what ties a call to the boot it ran in
 * (see recordedBootEvidence).
 */

export const TOOL_CALL_ACTION = "tool.call";
export const SANDBOX_BOOT_ACTION = "sandbox.boot";

/** A run id nobody had to pick: which app, when, and enough randomness not to collide. */
export function newRunId(app: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `mcp-${app}-${stamp}-${randomBytes(3).toString("hex")}`;
}

export interface RunAuditOptions {
  sink: AuditSink;
  runId: string;
  /** This bridge process's id. Defaults to a fresh random one. */
  sessionId?: string;
  app: string;
  containerName: string;
  /** Who made a tool call. Resolved per call: the MCP client only names itself after `initialize`. */
  actor: () => Actor;
  /** Who read the boot evidence: the person running the CLI, not the client. */
  operator: Actor;
  via: string;
}

export interface ToolCallOutcome {
  export: string;
  input: unknown;
  durationMs: number;
  /** The app's result, when the call succeeded. */
  result?: unknown;
  /** The app's raw error, when it failed. */
  error?: string;
  /** True when the error is a sandbox refusal (see capability-errors.ts), not an app bug. */
  denied?: boolean;
  /**
   * Paths the app reported as possibly refused inside a call that otherwise
   * succeeded (code-interpreter's `denials`: code that caught a Permission
   * denied). The call ran, so it stays "allowed". Only the count and the
   * paths are recorded: the output lines they came from are the call's
   * output, which is written only with payload capture on.
   */
  reportedDeniedPaths?: string[];
  /**
   * The app never answered: the RPC timed out, the write to the sandbox
   * failed, the caller gave up, or the session ended first. The request may
   * already have reached the app, so the call may have run.
   */
  unanswered?: { reason: string; interrupted?: boolean };
}

/** Longest reason written to a record. The app's raw error can echo its input or file contents. */
export const MAX_REASON_CHARS = 300;

/**
 * An app's error as it goes into `reason`: its first line only, control
 * characters removed, capped at MAX_REASON_CHARS. The rest of an error is
 * usually a stack or the payload it choked on, and `reason` is written even
 * when inputs and outputs are not (capturePayloads is off by default).
 */
export function auditReason(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const clean = firstLine.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (clean.length <= MAX_REASON_CHARS) return clean;
  return `${clean.slice(0, MAX_REASON_CHARS)}… (${clean.length - MAX_REASON_CHARS} more chars not recorded)`;
}

export interface RunAudit {
  runId: string;
  sessionId: string;
  toolCall(outcome: ToolCallOutcome): Promise<void>;
  sandboxBoot(evidence: BootEvidence): Promise<void>;
}

export function createRunAudit(options: RunAuditOptions): RunAudit {
  const { sink, runId, app, containerName, via } = options;
  const sessionId = options.sessionId ?? randomBytes(8).toString("hex");
  const meta = (extra: Record<string, unknown> = {}) => ({ runId, bridge: sessionId, via, container: containerName, ...extra });
  return {
    runId,
    sessionId,
    async toolCall(outcome) {
      // Same convention as @berthos/agents' tracer: "denied" is only for the
      // sandbox refusing something. A call that ran and failed is an allowed
      // attempt with a reason, and so is one that got no answer: it was let
      // through, and whether it ran is unknown (meta.outcome says so).
      const unanswered = outcome.unanswered;
      const reason = unanswered
        ? `${unanswered.interrupted ? "the session ended before the app answered" : `no answer from the app: ${auditReason(unanswered.reason)}`} — the call may have run`
        : outcome.error !== undefined
          ? auditReason(outcome.error)
          : outcome.reportedDeniedPaths?.length
            ? `the app reported ${outcome.reportedDeniedPaths.length} possible sandbox refusal(s) inside the call`
            : undefined;
      const failed = unanswered !== undefined || (outcome.error !== undefined && !outcome.denied);
      await sink
        .record({
          ts: new Date().toISOString(),
          seq: 0,
          actor: options.actor(),
          action: TOOL_CALL_ACTION,
          target: `${app}.${outcome.export}`,
          decision: outcome.denied ? "denied" : "allowed",
          ...(reason !== undefined ? { reason } : {}),
          input: outcome.input,
          ...(outcome.error === undefined && !unanswered ? { output: outcome.result } : {}),
          durationMs: outcome.durationMs,
          meta: meta({
            ...(failed ? { failed: true } : {}),
            ...(unanswered ? { outcome: "unknown", ...(unanswered.interrupted ? { interrupted: true } : {}) } : {}),
            ...(outcome.reportedDeniedPaths?.length ? { reportedDenials: outcome.reportedDeniedPaths.length, reportedDeniedPaths: outcome.reportedDeniedPaths } : {}),
          }),
        })
        .catch(() => {});
    },
    async sandboxBoot(evidence) {
      await sink
        .record({
          ts: new Date().toISOString(),
          seq: 0,
          actor: options.operator,
          action: SANDBOX_BOOT_ACTION,
          target: `container:${evidence.containerName}`,
          decision: "allowed",
          meta: meta({ evidence }),
        })
        .catch(() => {});
    },
  };
}

export type RecordedBoot = { evidence: BootEvidence } | { problem: string };

/**
 * The boot evidence a run recorded for itself, bound to the calls it covers.
 * Undefined when the run recorded none (attest then reads a live sandbox).
 *
 * A run id can be reused across `berth mcp` sessions, and each session may
 * be a different boot of the sandbox. An attestation names one boot, so:
 *
 *  - each session's calls are covered only by a boot recorded in that same
 *    session (records from before sessions were recorded count as one);
 *  - a session with calls but no recorded boot, while others have one, is a
 *    problem rather than something to paper over with another session's boot;
 *  - so is a run whose sessions ran in different boots, or a boot record
 *    whose evidence names a different container than the session it's in.
 *
 * Within a session the last well-formed boot record wins. A record without
 * the shape attest needs is ignored rather than guessed at.
 */
export function recordedBootEvidence(runRecords: AuditRecord[]): RecordedBoot | undefined {
  const bootBySession = new Map<string, BootEvidence>();
  const sessionsWithCalls = new Set<string>();
  for (const record of runRecords) {
    const meta = (record.meta ?? {}) as { bridge?: unknown; container?: unknown; evidence?: unknown };
    const session = typeof meta.bridge === "string" ? meta.bridge : LEGACY_SESSION;
    if (record.action === TOOL_CALL_ACTION) sessionsWithCalls.add(session);
    if (record.action !== SANDBOX_BOOT_ACTION || !isBootEvidence(meta.evidence)) continue;
    if (typeof meta.container === "string" && meta.container !== meta.evidence.containerName) {
      return { problem: `session ${session} recorded boot evidence for container "${meta.evidence.containerName}" but its calls went to "${meta.container}"` };
    }
    bootBySession.set(session, meta.evidence);
  }
  if (bootBySession.size === 0) return undefined;

  const uncovered = [...sessionsWithCalls].filter((session) => !bootBySession.has(session));
  if (uncovered.length > 0) {
    return {
      problem: `this run's calls from session(s) ${uncovered.join(", ")} have no recorded boot evidence, so the boot they ran in is unknown — pass --container to attest against a running sandbox, or give each session its own run id`,
    };
  }
  const boots = new Map<string, BootEvidence>();
  for (const evidence of bootBySession.values()) boots.set(evidence.bootId, evidence);
  if (boots.size > 1) {
    return {
      problem: `this run spans ${boots.size} boots (${[...boots.keys()].join(", ")}) and an attestation names one — its run id was reused across sessions; give each session its own run id`,
    };
  }
  const [evidence] = [...bootBySession.values()].slice(-1);
  const differs = [...bootBySession.values()].find((other) => bootIdentity(other) !== bootIdentity(evidence!));
  if (differs) {
    return { problem: `this run's sessions recorded boot ${evidence!.bootId} with different image or policy evidence — refusing to pick one` };
  }
  return { evidence: evidence! };
}

const LEGACY_SESSION = "(unrecorded)";

/** What must match for two records to describe the same boot. The doctor probe is re-run per session and may differ. */
function bootIdentity(evidence: BootEvidence): string {
  return JSON.stringify([evidence.bootId, evidence.containerName, evidence.imageTag, evidence.imageDigest, evidence.policies, evidence.rulesetReports]);
}

function isBootEvidence(value: unknown): value is BootEvidence {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.bootId === "string" &&
    typeof v.containerName === "string" &&
    typeof v.imageTag === "string" &&
    typeof v.imageDigest === "string" &&
    Array.isArray(v.rulesetReports) &&
    Array.isArray(v.policies) &&
    typeof v.doctorProbe === "object" &&
    v.doctorProbe !== null &&
    typeof (v.doctorProbe as { status?: unknown }).status === "string"
  );
}
