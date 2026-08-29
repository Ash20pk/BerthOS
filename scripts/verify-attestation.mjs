#!/usr/bin/env node
// BUILD_PLAN M2.1 — the standalone attestation verifier.
//
// Deliberately depends on nothing but node:crypto and the schema described in
// docs/attestation-reference.md, so a stranger can check a Berth attestation
// record without installing Berth: `node verify-attestation.mjs <record.json>`.
//
// What it checks:
//   1. shape — required fields, sha256 formats, a positive run-record count
//   2. integrity — recordSha256 matches the canonical JSON of the record
//   3. consistency — the stated enforcement.status actually follows from the
//      embedded measurements, so editing the verdict without forging the
//      measurements is caught even by a verifier that never saw the host
//
// What it cannot check (the record's own trustModel field says the same):
// that the host told the truth at emission time. The chain and the record are
// tamper-*evident*, not tamper-proof, until the chain head leaves the
// writer's reach.
//
// Problems carry a machine-readable `code` from the error contract of
// spec/attestation-record/SPEC.md section 7, so a caller in any language can
// act on the reason rather than grepping prose.
//
// The logic mirrors packages/audit/src/attest.ts (verifyAttestation); keep
// the two in sync — attestation-milestone.mjs runs both against the same
// records, and the conformance suite in spec/attestation-record runs the same
// corpus through each (--impl standalone | library).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SCHEMA_VERSION = 1;
const KIND = "berth.attestation";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ENFORCEMENT_STATUSES = new Set(["ACTIVE", "NOT_ENFORCED", "UNDETERMINED"]);
const PROBE_STATUSES = new Set(["enforcing", "present_not_enforcing", "unsupported", "unknown"]);

/** Stable-key JSON — must byte-match @berth/audit's canonicalize(). */
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function digestOf(record) {
  const { recordSha256, ...rest } = record;
  return createHash("sha256").update(canonicalize(rest)).digest("hex");
}

/** The one derivation rule, restated: ACTIVE only when both measurements agree. */
export function deriveStatus(rulesetReports, probe) {
  const reasons = [];
  if (probe.status === "unsupported" || probe.status === "present_not_enforcing") reasons.push(`doctor probe: ${probe.status}`);
  for (const r of rulesetReports) {
    if (r.ruleset !== "FullyEnforced") reasons.push(`agent-init reported ${r.ruleset} for app "${r.app}"`);
  }
  if (reasons.length > 0) return "NOT_ENFORCED";
  if (probe.status === "unknown" || rulesetReports.length === 0) return "UNDETERMINED";
  return "ACTIVE";
}

export function verify(record) {
  const problems = [];
  const fail = (code, message) => problems.push({ code, message });

  if (record?.schemaVersion !== SCHEMA_VERSION) fail("schema-version-unsupported", `unknown schemaVersion ${record?.schemaVersion}`);
  if (record?.kind !== KIND) fail("kind-invalid", `kind is ${JSON.stringify(record?.kind)}, expected "${KIND}"`);
  if (typeof record?.runId !== "string" || record.runId.length === 0) fail("run-id-missing", "runId missing");
  if (typeof record?.trustModel !== "string" || record.trustModel.length === 0) fail("trust-model-missing", "trustModel missing");
  if (typeof record?.generatedAt !== "string" || !RFC3339.test(record.generatedAt)) {
    fail("generated-at-invalid", `generatedAt is ${JSON.stringify(record?.generatedAt)}, expected an RFC 3339 timestamp`);
  }
  if (!SHA256_HEX.test(record?.auditChain?.head ?? "")) fail("audit-chain-head-invalid", "auditChain.head is not a sha256 hex digest");
  if (typeof record?.boot?.bootId !== "string" || record.boot.bootId.length === 0) fail("boot-id-missing", "boot.bootId missing");
  if (typeof record?.boot?.imageDigest !== "string" || record.boot.imageDigest.length === 0) {
    fail("image-digest-missing", 'boot.imageDigest missing — "unknown" must be said out loud');
  }
  if (!Array.isArray(record?.policies)) fail("policy-digest-invalid", "policies is not a list");
  else {
    for (const p of record.policies) {
      if (!SHA256_HEX.test(p?.sha256 ?? "")) fail("policy-digest-invalid", `policy digest for app ${JSON.stringify(p?.app)} is not a sha256 hex digest`);
    }
  }
  if (!(record?.run?.records > 0)) fail("run-records-invalid", "run.records is not a positive count");

  // Totality (SPEC section 2.3): a non-mapping input must produce problems, not an exception.
  const isMapping = typeof record === "object" && record !== null && !Array.isArray(record);
  if (!isMapping || typeof record.recordSha256 !== "string" || digestOf(record) !== record.recordSha256) {
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
          fail("boot-id-inconsistent", `ruleset report for app "${r.app}" cites boot ${r.bootId}, but the record attests boot ${record.boot?.bootId}`);
        }
      }
    }
    if (!PROBE_STATUSES.has(doctorProbe?.status)) {
      fail("doctor-probe-invalid", `enforcement.doctorProbe.status is ${JSON.stringify(doctorProbe?.status)}, not one of the four probe results`);
    }

    const derived = deriveStatus(
      Array.isArray(rulesetReports) ? rulesetReports : [],
      PROBE_STATUSES.has(doctorProbe?.status) ? doctorProbe : { status: "unknown" },
    );
    if (derived !== status) {
      fail("enforcement-status-underived", `enforcement.status says ${status} but the embedded measurements derive ${derived}`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node verify-attestation.mjs <attestation-record.json>");
    process.exit(2);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`FAIL: could not read ${path} as JSON (${err.message})`);
    process.exit(1);
  }
  const problems = verify(record);
  if (problems.length > 0) {
    console.error(`FAIL: ${path} is not a valid attestation record:`);
    for (const p of problems) console.error(`  - [${p.code}] ${p.message}`);
    process.exit(1);
  }
  console.log(`OK: record for run "${record.runId}" is internally consistent and unedited since emission.`);
  console.log(`    enforcement: ${record.enforcement.status}   boot: ${record.boot.bootId}   image: ${record.boot.imageDigest}`);
  console.log(`    audit chain head: ${record.auditChain.head.slice(0, 16)}… over ${record.auditChain.totalRecords} records (${record.run.records} from this run)`);
  console.log(`    trust model: ${record.trustModel}`);
}
