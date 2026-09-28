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
   * Refusals inside a call that otherwise succeeded, as the app reported them
   * (code-interpreter's `denials`: code that caught a Permission denied).
   * The call ran, so it stays "allowed"; the refusals go in reason and meta.
   */
  innerDenials?: string[];
}

export interface RunAudit {
  runId: string;
  toolCall(outcome: ToolCallOutcome): Promise<void>;
  sandboxBoot(evidence: BootEvidence): Promise<void>;
}

export function createRunAudit(options: RunAuditOptions): RunAudit {
  const { sink, runId, app, containerName, via } = options;
  const meta = (extra: Record<string, unknown> = {}) => ({ runId, via, container: containerName, ...extra });
  return {
    runId,
    async toolCall(outcome) {
      // Same convention as @berthos/agents' tracer: "denied" is only for the
      // sandbox refusing something. A call that ran and failed is an allowed
      // attempt with a reason.
      await sink
        .record({
          ts: new Date().toISOString(),
          seq: 0,
          actor: options.actor(),
          action: TOOL_CALL_ACTION,
          target: `${app}.${outcome.export}`,
          decision: outcome.denied ? "denied" : "allowed",
          ...(outcome.error !== undefined
            ? { reason: outcome.error }
            : outcome.innerDenials?.length
              ? { reason: `the sandbox refused ${outcome.innerDenials.length} operation(s) inside the call: ${outcome.innerDenials[0]}` }
              : {}),
          input: outcome.input,
          ...(outcome.error === undefined ? { output: outcome.result } : {}),
          durationMs: outcome.durationMs,
          meta: meta({
            ...(outcome.error !== undefined && !outcome.denied ? { failed: true } : {}),
            ...(outcome.innerDenials?.length ? { denials: outcome.innerDenials } : {}),
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

/**
 * The boot evidence a run recorded for itself, if it did. The last one wins:
 * one session records one boot, and if a run id was reused across sessions,
 * the latest boot is the one its latest calls ran in. Returns undefined for
 * a record that doesn't have the shape attest needs, rather than guessing.
 */
export function recordedBootEvidence(runRecords: AuditRecord[]): BootEvidence | undefined {
  for (let i = runRecords.length - 1; i >= 0; i--) {
    const record = runRecords[i]!;
    if (record.action !== SANDBOX_BOOT_ACTION) continue;
    const evidence = (record.meta as { evidence?: unknown } | undefined)?.evidence;
    if (isBootEvidence(evidence)) return evidence;
  }
  return undefined;
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
