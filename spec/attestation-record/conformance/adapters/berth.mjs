#!/usr/bin/env node
// Conformance adapter for the reference implementations of the Attestation
// Record Specification. There are two of them, and this adapter can drive
// either:
//
//   --impl standalone  scripts/verify-attestation.mjs — no dependency beyond
//                      node:crypto, which is the one a stranger runs
//   --impl library     verifyAttestation / deriveEnforcementStatus /
//                      attestationDigest from @berthos/audit, which is the one
//                      `berth attest` runs against its own output
//
// Running the same corpus through both is how the two are kept from drifting
// apart while each stays internally consistent — the exact failure mode a
// second implementation of the same algorithm invites.
//
// It is a thin translation layer and nothing else: every decision is delegated
// to the implementation under test. If this file ever starts *deciding*
// something — re-checking a field, normalizing a record — the suite stops
// testing Berth and starts testing the adapter.
//
// Run from the repo root (after `pnpm --filter @berthos/audit build` for the
// library variant):
//   node spec/attestation-record/conformance/run.mjs \
//     --adapter "node spec/attestation-record/conformance/adapters/berth.mjs --impl standalone"

import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

const which = (() => {
  const i = process.argv.indexOf("--impl");
  const value = i === -1 ? "standalone" : process.argv[i + 1];
  if (value !== "standalone" && value !== "library") throw new Error(`--impl must be "standalone" or "library", got ${JSON.stringify(value)}`);
  return value;
})();

let impl;
if (which === "standalone") {
  const mod = await import(pathToFileURL(resolve(REPO_ROOT, "scripts", "verify-attestation.mjs")).href);
  impl = {
    name: "scripts/verify-attestation.mjs (standalone, node:crypto only)",
    verify: (record) => mod.verify(record),
    derive: (reports, probe) => mod.deriveStatus(reports, probe),
    digest: (record) => mod.digestOf(record),
  };
} else {
  const mod = await import("@berthos/audit");
  impl = {
    name: "@berthos/audit verifyAttestation (library)",
    verify: (record) => mod.verifyAttestation(record).problems,
    derive: (reports, probe) => mod.deriveEnforcementStatus(reports, probe).status,
    digest: (record) => mod.attestationDigest(record),
  };
}

/**
 * The subset of SPEC section 7 these implementations report. Both implement all
 * seventeen; listing them is what lets the runner say "this verifier does not
 * implement the code your case expects" instead of failing opaquely.
 */
const CODES = [
  "schema-version-unsupported",
  "kind-invalid",
  "trust-model-missing",
  "generated-at-invalid",
  "run-id-missing",
  "run-records-invalid",
  "audit-chain-head-invalid",
  "boot-id-missing",
  "image-digest-missing",
  "policy-digest-invalid",
  "digest-mismatch",
  "enforcement-missing",
  "enforcement-status-invalid",
  "ruleset-report-invalid",
  "doctor-probe-invalid",
  "boot-id-inconsistent",
  "enforcement-status-underived",
];

const DESCRIBE = {
  implementation: `Berth reference implementation — ${impl.name}`,
  specVersion: "1.0.0",
  kind: "berth.attestation",
  recordSchemaVersion: 1,
  codes: CODES,
};

function handle(request) {
  switch (request.op) {
    case "describe":
      return DESCRIBE;

    case "verify": {
      const problems = impl.verify(request.record);
      return problems.length === 0 ? { valid: true } : { valid: false, problems };
    }

    case "derive":
      return { status: impl.derive(request.rulesetReports, request.doctorProbe) };

    case "digest":
      return { sha256: impl.digest(request.record) };

    default:
      return { error: `unknown op ${JSON.stringify(request.op)}` };
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim() === "") return;
  const request = JSON.parse(line);
  let response;
  try {
    response = handle(request);
  } catch (err) {
    // A throw here is itself a conformance failure (SPEC 2.3 requires
    // verification to be total), so it is reported rather than swallowed.
    response = { error: err instanceof Error ? err.stack : String(err) };
  }
  process.stdout.write(JSON.stringify({ id: request.id, ...response }) + "\n");
});
