#!/usr/bin/env node
// A DELIBERATELY NON-CONFORMING adapter. It exists so the conformance suite can
// be shown to be falsifiable (SPEC 8.5): a suite no implementation can fail
// proves nothing about the ones that pass it.
//
// It is a plausible-looking verifier written from a skim of the spec, carrying
// seven defects that are exactly the ones a real implementation makes:
//
//   1. THE BIG ONE — it trusts `enforcement.status` as written instead of
//      re-deriving it from the measurements (SPEC 5.3). Every tamper case where
//      someone edits the verdict and re-seals the record sails straight through.
//      This is the defect the whole format exists to prevent, and it is the one
//      an implementer is most likely to ship, because a record that carries a
//      verdict *looks* like a record you can read the verdict from.
//   2. an empty measurement set derives ACTIVE rather than UNDETERMINED —
//      "nothing reported a problem" read as "nothing was wrong". Absence of
//      evidence spelled optimistically is how a sandbox with the enforcement
//      silently disabled reports a clean bill of health.
//   3. `rulesetReports[].bootId` is never compared against `boot.bootId`, so a
//      record can attest one boot while carrying another boot's measurements.
//   4. the digest is `JSON.stringify` in insertion order — no key sorting, no
//      defined number or escape handling. It round-trips against itself
//      perfectly and agrees with nobody.
//   5. `trustModel` is treated as optional decoration (SPEC 4.3 says a record
//      without it does not conform).
//   6. problems are reported as bare strings with no machine-readable code,
//      so a caller can only grep prose.
//   7. verification is not total (SPEC 2.3): a `policies` that is a mapping
//      rather than a sequence throws out of the `for...of`. The wrapper below
//      catches it so the process survives to be judged on the rest of the
//      corpus, and answers with an error instead of a verdict — which is
//      itself the failure the case records.
//
// If a change to cases.json makes this adapter pass, the case is not testing
// what it claims to test. Extend the defects rather than weakening the case.

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const SHA256_HEX = /^[0-9a-f]{64}$/;

const DESCRIBE = {
  implementation: "broken-by-design (negative control, not an implementation)",
  specVersion: "1.0.0",
  kind: "berth.attestation",
  recordSchemaVersion: 1,
  codes: ["digest-mismatch", "run-id-missing"],
};

// defect 4: insertion order, whatever JSON.stringify feels like doing
function digest(record) {
  const { recordSha256, ...rest } = record ?? {};
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

// defect 2: no reports is treated as nothing-went-wrong
function derive(rulesetReports, doctorProbe) {
  if (doctorProbe?.status === "unsupported" || doctorProbe?.status === "present_not_enforcing") return "NOT_ENFORCED";
  for (const r of rulesetReports ?? []) {
    if (r.ruleset !== "FullyEnforced") return "NOT_ENFORCED";
  }
  return "ACTIVE";
}

function verify(record) {
  const problems = []; // defect 6: strings, not {code, message}
  if (typeof record !== "object" || record === null) return { valid: false, problems: ["not a mapping"] };

  if (record.schemaVersion !== 1) problems.push("bad schemaVersion");
  if (record.kind !== "berth.attestation") problems.push("bad kind");
  if (typeof record.runId !== "string" || record.runId.length === 0) problems.push("runId missing");
  // defect 5: trustModel is nice to have
  if (typeof record.generatedAt !== "string") problems.push("generatedAt missing");
  if (!SHA256_HEX.test(record.auditChain?.head ?? "")) problems.push("bad chain head");
  if (typeof record.boot?.bootId !== "string" || record.boot.bootId.length === 0) problems.push("bootId missing");
  if (typeof record.boot?.imageDigest !== "string" || record.boot.imageDigest.length === 0) problems.push("imageDigest missing");
  for (const p of record.policies ?? []) {
    if (!SHA256_HEX.test(p?.sha256 ?? "")) problems.push("bad policy digest");
  }
  if (!(record.run?.records > 0)) problems.push("run.records missing");
  if (digest(record) !== record.recordSha256) problems.push("recordSha256 mismatch");
  if (!record.enforcement) problems.push("enforcement missing");
  // defect 1: the verdict is read, not derived. defect 3: bootId never checked.

  return problems.length === 0 ? { valid: true } : { valid: false, problems };
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim() === "") return;
  const request = JSON.parse(line);
  let response;
  try {
    if (request.op === "describe") response = DESCRIBE;
    else if (request.op === "verify") response = verify(request.record);
    else if (request.op === "derive") response = { status: derive(request.rulesetReports, request.doctorProbe) };
    else if (request.op === "digest") response = { sha256: digest(request.record) };
    else response = { error: "unknown op" };
  } catch (err) {
    response = { error: err instanceof Error ? err.message : String(err) }; // defect 7
  }
  process.stdout.write(JSON.stringify({ id: request.id, ...response }) + "\n");
});
