import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCheckCommand, pythonAppTestCommand } from "./test-commands.js";

test("a Node app's exports are checked by the TypeScript SDK's checker", () => {
  assert.deepEqual(exportCheckCommand("node"), ["node", "node_modules/@berthos/sdk/dist/check-exports.js"]);
});

test("a Python app's exports are checked by berth_sdk's, from the image's own SDK copy", () => {
  assert.deepEqual(exportCheckCommand("python"), ["env", "PYTHONPATH=/opt/berth/sdk-python", "python3", "-m", "berth_sdk.check_exports"]);
});

test("a Python app's tests run with pytest only when it has a tests/ directory", async () => {
  const appDir = mkdtempSync(join(tmpdir(), "berth-py-test-"));
  assert.equal(await pythonAppTestCommand(appDir), null);
  mkdirSync(join(appDir, "tests"));
  assert.deepEqual(await pythonAppTestCommand(appDir), ["env", "PYTHONPATH=/opt/berth/sdk-python", "python3", "-m", "pytest", "-q", "tests"]);
});
