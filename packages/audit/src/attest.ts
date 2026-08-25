import { createHash } from "node:crypto";
import { canonicalize } from "./sink.js";

/**
 * BUILD_PLAN M2.1 — the attestation record. A per-run statement binding
 * together facts that are otherwise scattered across the audit trail, the
 * container's stderr, the policy file, and the doctor cache:
 *
 * - the audit chain's segment head at the moment of attestation, plus which
 *   slice of that chain belongs to the run being attested
 * - enforcement status *as measured* for the boot the run happened in —
 *   agent-init's own ruleset report (kernel said FullyEnforced or it didn't)
 *   and the doctor behavioural probe result for that host/runtime
 * - the sha256 of the capability policy file agent-init actually enforced from
 * - the boot ID and the image digest, so the record names one boot of one
 *   image, not "some container"
 *
 * The record is self-hashed (`recordSha256` over the canonical JSON of every
 * other field) so an accidental or casual edit is detectable, and its derived
 * `enforcement.status` is recomputable from the embedded measurements so an
 * edit that upgrades the verdict without forging the measurements is
 * detectable even by a verifier that never saw the host. What it is NOT is
 * stated in `trustModel`, inside the record itself.
 */

export const ATTESTATION_SCHEMA_VERSION = 1;
export const ATTESTATION_KIND = "berth.attestation";

/**
 * The honesty constraint from BUILD_PLAN 2.1, carried in-band: every record
 * says what trusting it requires, so a reader who only ever sees the JSON
 * still sees the limits.
 */
export const ATTESTATION_TRUST_MODEL =
  "tamper-evident, not tamper-proof: this record and the audit chain it cites are hashed, " +
  "but both were produced by software running on the attested host. Anyone who controls that " +
  "host could have rewritten the chain wholesale and re-emitted this record before its head " +
  "left their reach. The record proves internal consistency and detects after-the-fact edits; " +
  "it does not prove the host told the truth at emission time.";

export type EnforcementStatus = "ACTIVE" | "NOT_ENFORCED" | "UNDETERMINED";

/** One `capability_policy_applied` event as agent-init printed it (see agent-init/src/main.rs). */
export interface RulesetReport {
  app: string;
  /** Landlock RulesetStatus debug string: "FullyEnforced" | "PartiallyEnforced" | "NotEnforced". */
  ruleset: string;
  bootId: string;
  timestamp?: number;
}

/** The doctor behavioural probe result for the attested boot's host/runtime (docker-orchestrator's enforcementStatusForBoot). */
export interface DoctorProbeResult {
  status: "enforcing" | "present_not_enforcing" | "unsupported" | "unknown";
  reason?: string;
}

export interface PolicyDigest {
  app: string;
  /** Container-side path of the enforced file. */
  path: string;
  sha256: string;
}

export interface AttestationRecord {
  schemaVersion: number;
  kind: string;
  trustModel: string;
  generatedAt: string;
  runId: string;
  /** The attested run's slice of the audit chain — record count and seq/ts bounds of records whose meta.runId matched. */
  run: {
    records: number;
    firstSeq?: number;
    lastSeq?: number;
    firstTs?: string;
    lastTs?: string;
  };
  auditChain: {
    /** Host path of the base audit file. */
    path: string;
    segments: number;
    totalRecords: number;
    /** verifyAuditChain's endHash across all segments — the chain head at attestation time. */
    head: string;
  };
  boot: {
    bootId: string;
    containerName: string;
    imageTag: string;
    /** Docker image content identity (Image ID / RepoDigest); "unknown" when the daemon couldn't say. */
    imageDigest: string;
    /** HostConfig.Runtime when set (M1.4 hardened runtime); absent means the daemon default. */
    runtime?: string;
  };
  enforcement: {
    status: EnforcementStatus;
    reasons: string[];
    rulesetReports: RulesetReport[];
    doctorProbe: DoctorProbeResult;
  };
  policies: PolicyDigest[];
  /** sha256 of the canonical JSON of every other field. Stamped by finalizeAttestation. */
  recordSha256: string;
}

/**
 * The one derivation rule, shared verbatim by the emitter and the verifier:
 * ACTIVE only when both independent measurements agree — the kernel probe
 * says the host enforces Landlock AND every app's agent-init reported
 * FullyEnforced for this boot. Any measured non-enforcement is NOT_ENFORCED
 * (a boot that didn't enforce is not enforced, whatever the kernel could
 * have done). Missing measurements are UNDETERMINED, never quietly ACTIVE.
 */
export function deriveEnforcementStatus(
  rulesetReports: RulesetReport[],
  probe: DoctorProbeResult,
): { status: EnforcementStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (probe.status === "unsupported" || probe.status === "present_not_enforcing") {
    reasons.push(`doctor probe: ${probe.status}${probe.reason ? ` (${probe.reason})` : ""}`);
  }
  const notEnforced = rulesetReports.filter((r) => r.ruleset !== "FullyEnforced");
  for (const r of notEnforced) {
    reasons.push(`agent-init reported ${r.ruleset} for app "${r.app}"`);
  }
  if (reasons.length > 0) return { status: "NOT_ENFORCED", reasons };

  if (probe.status === "unknown") {
    return { status: "UNDETERMINED", reasons: ["doctor probe result unavailable for this boot"] };
  }
  if (rulesetReports.length === 0) {
    return { status: "UNDETERMINED", reasons: ["no capability_policy_applied report found for this boot"] };
  }
  return { status: "ACTIVE", reasons: [] };
}

/** Everything an AttestationRecord holds except the derived and stamped fields. */
export type AttestationInput = Omit<AttestationRecord, "schemaVersion" | "kind" | "trustModel" | "generatedAt" | "enforcement" | "recordSha256"> & {
  generatedAt?: string;
  enforcement: {
    rulesetReports: RulesetReport[];
    doctorProbe: DoctorProbeResult;
  };
};

/** sha256 over the canonical JSON of the record with recordSha256 removed. */
export function attestationDigest(record: Omit<AttestationRecord, "recordSha256"> & { recordSha256?: string }): string {
  const { recordSha256: _drop, ...rest } = record;
  return createHash("sha256").update(canonicalize(rest)).digest("hex");
}

/** Derives the enforcement verdict from the measurements and stamps kind, trust model, and self-hash. */
export function finalizeAttestation(input: AttestationInput): AttestationRecord {
  const { status, reasons } = deriveEnforcementStatus(input.enforcement.rulesetReports, input.enforcement.doctorProbe);
  const body: Omit<AttestationRecord, "recordSha256"> = {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    kind: ATTESTATION_KIND,
    trustModel: ATTESTATION_TRUST_MODEL,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    runId: input.runId,
    run: input.run,
    auditChain: input.auditChain,
    boot: input.boot,
    enforcement: { status, reasons, rulesetReports: input.enforcement.rulesetReports, doctorProbe: input.enforcement.doctorProbe },
    policies: input.policies,
  };
  return { ...body, recordSha256: attestationDigest(body) };
}

/**
 * A verification failure, carrying a stable machine-readable `code` from the
 * Attestation Record Specification's error contract (spec/attestation-record,
 * SPEC.md §7) alongside the human sentence. The code is the part a conformance
 * suite, a CI job, or another language's verifier can act on; the message is
 * the part a person reads.
 */
export interface AttestationProblem {
  code: AttestationProblemCode;
  message: string;
}

export type AttestationProblemCode =
  | "schema-version-unsupported"
  | "kind-invalid"
  | "run-id-missing"
  | "trust-model-missing"
  | "generated-at-invalid"
  | "audit-chain-head-invalid"
  | "boot-id-missing"
  | "image-digest-missing"
  | "policy-digest-invalid"
  | "run-records-invalid"
  | "digest-mismatch"
  | "enforcement-missing"
  | "enforcement-status-invalid"
  | "ruleset-report-invalid"
  | "doctor-probe-invalid"
  | "boot-id-inconsistent"
  | "enforcement-status-underived";

export interface AttestationVerification {
  valid: boolean;
  /** Every check that failed — empty when valid. Order is not significant. */
  problems: AttestationProblem[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** RFC 3339 date-time. `generatedAt` is when the measurements were read, and a record that can't say when is not evidence of anything. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ENFORCEMENT_STATUSES = new Set(["ACTIVE", "NOT_ENFORCED", "UNDETERMINED"]);
const PROBE_STATUSES = new Set(["enforcing", "present_not_enforcing", "unsupported", "unknown"]);

/**
 * The same checks scripts/verify-attestation.mjs performs, as a library:
 * shape, self-hash, and that the stated verdict actually follows from the
 * embedded measurements. Deliberately no I/O — the standalone script owns
 * "no Berth dependency", this owns "the emitter and its tests agree".
 *
 * Both are reference implementations of spec/attestation-record/SPEC.md §6
 * (the verifier algorithm); the two are kept in sync by the conformance suite,
 * which runs the same corpus through each.
 */
export function verifyAttestation(record: AttestationRecord): AttestationVerification {
  const problems: AttestationProblem[] = [];
  const fail = (code: AttestationProblemCode, message: string) => problems.push({ code, message });

  if (record?.schemaVersion !== ATTESTATION_SCHEMA_VERSION) fail("schema-version-unsupported", `unknown schemaVersion ${record?.schemaVersion}`);
  if (record?.kind !== ATTESTATION_KIND) fail("kind-invalid", `kind is ${JSON.stringify(record?.kind)}, expected ${JSON.stringify(ATTESTATION_KIND)}`);
  if (typeof record?.runId !== "string" || record.runId.length === 0) fail("run-id-missing", "runId missing");
  if (typeof record?.trustModel !== "string" || record.trustModel.length === 0) {
    fail("trust-model-missing", "trustModel missing — the honesty constraint is part of the schema");
  }
  if (typeof record?.generatedAt !== "string" || !RFC3339.test(record.generatedAt)) {
    fail("generated-at-invalid", `generatedAt is ${JSON.stringify(record?.generatedAt)}, expected an RFC 3339 timestamp`);
  }
  if (!SHA256_HEX.test(record?.auditChain?.head ?? "")) fail("audit-chain-head-invalid", "auditChain.head is not a sha256 hex digest");
  if (typeof record?.boot?.bootId !== "string" || record.boot.bootId.length === 0) fail("boot-id-missing", "boot.bootId missing");
  if (typeof record?.boot?.imageDigest !== "string" || record.boot.imageDigest.length === 0) {
    fail("image-digest-missing", 'boot.imageDigest missing — a record names one boot of one image, and "unknown" must be said out loud');
  }
  if (!Array.isArray(record?.policies)) fail("policy-digest-invalid", "policies is not a list");
  else {
    for (const p of record.policies) {
      if (!SHA256_HEX.test(p?.sha256 ?? "")) fail("policy-digest-invalid", `policy digest for app ${JSON.stringify(p?.app)} is not a sha256 hex digest`);
    }
  }
  if (!(record?.run?.records > 0)) fail("run-records-invalid", "run.records is not a positive count — an attestation must cite audit evidence of the run");

  // Totality (SPEC §2.3): a record that is not a mapping at all still has to
  // produce problems rather than an exception, so the digest is only computed
  // where computing it means something.
  const isMapping = typeof record === "object" && record !== null && !Array.isArray(record);
  if (!isMapping || typeof record.recordSha256 !== "string" || attestationDigest(record) !== record.recordSha256) {
    fail("digest-mismatch", "recordSha256 does not match the record's contents — the record was edited after emission");
  }

  if (!record?.enforcement || typeof record.enforcement !== "object") {
    fail("enforcement-missing", "enforcement section missing");
  } else {
    const { status, rulesetReports, doctorProbe } = record.enforcement;
    if (!ENFORCEMENT_STATUSES.has(status)) {
      fail("enforcement-status-invalid", `enforcement.status is ${JSON.stringify(status)}, expected ACTIVE | NOT_ENFORCED | UNDETERMINED`);
    }
    if (!Array.isArray(rulesetReports)) fail("ruleset-report-invalid", "enforcement.rulesetReports is not a list");
    else {
      for (const r of rulesetReports) {
        if (typeof r?.app !== "string" || typeof r?.ruleset !== "string" || typeof r?.bootId !== "string") {
          fail("ruleset-report-invalid", `ruleset report ${JSON.stringify(r)} is missing app, ruleset, or bootId`);
        } else if (r.bootId !== record.boot?.bootId) {
          // Reports are filtered by boot ID precisely so a record cannot borrow
          // an enforcing boot's evidence for a different, non-enforcing one.
          fail("boot-id-inconsistent", `ruleset report for app "${r.app}" cites boot ${r.bootId}, but the record attests boot ${record.boot?.bootId}`);
        }
      }
    }
    if (!PROBE_STATUSES.has(doctorProbe?.status as string)) {
      fail("doctor-probe-invalid", `enforcement.doctorProbe.status is ${JSON.stringify(doctorProbe?.status)}, not one of the four probe results`);
    }

    const derived = deriveEnforcementStatus(
      Array.isArray(rulesetReports) ? rulesetReports : [],
      PROBE_STATUSES.has(doctorProbe?.status as string) ? doctorProbe : { status: "unknown" },
    );
    if (derived.status !== status) {
      fail(
        "enforcement-status-underived",
        `enforcement.status says ${status} but the embedded measurements derive ${derived.status} — the verdict was edited independently of its evidence`,
      );
    }
  }

  return { valid: problems.length === 0, problems };
}
