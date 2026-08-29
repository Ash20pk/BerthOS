#!/usr/bin/env node
// Conformance adapter for the reference implementation, @berth/manifest-schema.
//
// It is a thin translation layer and nothing else: every decision below is
// delegated to the shipped package (validateManifest, matchesCapability,
// ALLOWED_FILESYSTEM_SCOPE_PREFIXES, CURRENT_SCHEMA_VERSION). If this file ever
// starts *deciding* something — re-checking a path, normalizing a scope — the
// suite stops testing Berth and starts testing the adapter.
//
// Run from the repo root after `pnpm --filter @berth/manifest-schema build`:
//   node spec/capability-manifest/conformance/run.mjs \
//     --adapter "node spec/capability-manifest/conformance/adapters/berth.mjs"

import { createInterface } from "node:readline";
import {
  validateManifest,
  matchesCapability,
  ManifestValidationError,
  ALLOWED_FILESYSTEM_SCOPE_PREFIXES,
  CURRENT_SCHEMA_VERSION,
} from "@berth/manifest-schema";

/**
 * Berth's tier table (SPEC 5.1-5.2), as measured by this repo's milestone
 * tests rather than as hoped. Every row here has to be defensible against
 * docs/internal/claims.md, which names the denial test behind each claim; a row
 * claiming more than that file proves is the exact dishonesty SPEC 5 exists to
 * make visible.
 */
const TIERS = [
  // Landlock write/read domains applied by agent-init before the app execs.
  // claims.md K1-K4, K10.
  { namespace: "filesystem", action: "write", tier: "kernel" },
  { namespace: "filesystem", action: "read", tier: "kernel" },
  // Landlock AccessNet, deny-by-default, plus seccomp for UDP/raw. claims.md K5-K6.
  { namespace: "network", action: "connect", tier: "kernel" },
  { namespace: "network", action: "bind", tier: "kernel" },
  // Mutual-consent mesh membership, decided by mesh-coordinator. The peer set
  // is a broker decision; the WireGuard interface itself is not a kernel refusal
  // of an undeclared peer.
  { namespace: "network", action: "peer", tier: "broker" },
  // Per-caller socket paths with DAC modes: an undeclared caller gets EACCES
  // from connect(2). claims.md K11-K12.
  { namespace: "app", action: "invoke", tier: "kernel" },
  // A TLS-terminating broker on the API path. claims.md B6-B8.
  { namespace: "github", action: "read", tier: "broker" },
  { namespace: "github", action: "write", tier: "broker" },
  // The egress broker refuses out-of-scope hosts; Chromium is routed through
  // it. claims.md B1-B5. Host authorization is broker tier, never kernel: the
  // kernel sees ports, not hostnames.
  { namespace: "browser", action: "navigate", tier: "broker" },
  // Nothing denies a screenshot. claims.md R6 says so; so does this row.
  { namespace: "browser", action: "screenshot", tier: "recorded" },
  // The pty write paths are Landlock-gated, but no milestone yet asserts pty
  // allocation is *refused* without the grant (claims.md K20, "weak"), so this
  // reports the weaker of the two readings.
  { namespace: "terminal", action: "attach", tier: "broker" },
];

const DESCRIBE = {
  implementation: "@berth/manifest-schema (Berth reference implementation)",
  specVersion: "1.0.0",
  filesystemAllowlist: ALLOWED_FILESYSTEM_SCOPE_PREFIXES,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  tiers: TIERS,
};

/**
 * schema_version resolution failures come out of validate.ts as plain Errors
 * with no path (they happen before Zod runs at all), so they are mapped onto
 * the field they are about — the spec requires an error to carry a path, and
 * "somewhere in the document" is not one.
 */
function errorsFrom(err) {
  if (err instanceof ManifestValidationError) {
    return err.issues.map((issue) => ({ path: issue.path, message: issue.message }));
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/schema_version/.test(message)) return [{ path: ["schema_version"], message }];
  return [{ path: [], message }];
}

function handle(request) {
  switch (request.op) {
    case "describe":
      return DESCRIBE;

    case "match":
      try {
        return { matches: matchesCapability(request.granted, request.requested) };
      } catch {
        // An unparseable capability on either side is not a match (SPEC 3.2 step 1).
        return { matches: false };
      }

    case "validate":
      try {
        return { valid: true, normalized: validateManifest(request.manifest) };
      } catch (err) {
        return { valid: false, errors: errorsFrom(err) };
      }

    case "tier": {
      const row = TIERS.find((t) => t.namespace === request.namespace && t.action === request.action);
      return { tier: row ? row.tier : "unsupported" };
    }

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
    response = { error: err instanceof Error ? err.message : String(err) };
  }
  process.stdout.write(JSON.stringify({ id: request.id, ...response }) + "\n");
});
