import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCAFFOLD_BUILD_APPROVALS } from "./build-approvals.js";

// The same lookup berth init uses: the SDK's exports map doesn't expose its
// package.json, so go up from its entry point (dist/index.js).
const sdkPkgPath = join(dirname(dirname(fileURLToPath(import.meta.resolve("@berthos/sdk")))), "package.json");

test("every decision is a boolean — pnpm 11 rejects its own 'set this to true or false' placeholder", () => {
  for (const [name, allowed] of Object.entries(SCAFFOLD_BUILD_APPROVALS)) {
    assert.equal(typeof allowed, "boolean", name);
  }
});

test("the SDK's own install script has a decision", () => {
  // The regression: pnpm 11 failed `berth init`'s install with
  // ERR_PNPM_IGNORED_BUILDS for @berthos/sdk@0.2.3 and sharp@0.32.6.
  const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  assert.ok(sdkPkg.scripts?.postinstall, "if the SDK drops its postinstall, drop it from the list too");
  assert.equal(SCAFFOLD_BUILD_APPROVALS["@berthos/sdk"], true);
});

test("sharp, which the SDK pulls in but never uses, is declined", () => {
  assert.equal(SCAFFOLD_BUILD_APPROVALS.sharp, false);
  assert.equal(SCAFFOLD_BUILD_APPROVALS.protobufjs, true);
});
