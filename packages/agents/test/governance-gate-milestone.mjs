#!/usr/bin/env node
// Real, running verification of the governance gate (docs/governance-reference.md):
// when a Computer loads an app declaring `governs: true`, every other app's
// tool calls get routed through that app's evaluate_action export first.
// This fixture denies write_file and allows everything else.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer, GovernanceDeniedError } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const GOVERNANCE_APP_DIR = join(__dirname, "fixtures", "governance-gate-tester");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("Booting a Computer with apps/filesystem + the governance-gate-tester fixture...");
  const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR, GOVERNANCE_APP_DIR] });

  try {
    const toolNames = computer.tools.map((t) => t.name).sort();
    console.log("tools:", toolNames);
    assert(toolNames.includes("filesystem__write_file"), `expected "filesystem__write_file", got: ${JSON.stringify(toolNames)}`);
    assert(
      toolNames.includes("governance-gate-tester__evaluate_action"),
      `expected "governance-gate-tester__evaluate_action", got: ${JSON.stringify(toolNames)}`,
    );

    console.log("Calling filesystem__write_file, which the fixture's policy denies...");
    let deniedErr;
    try {
      await computer.call("filesystem__write_file", { path: "governance-gate-test.txt", content: "should never land" });
    } catch (err) {
      deniedErr = err;
    }
    assert(deniedErr instanceof GovernanceDeniedError, `expected a GovernanceDeniedError, got: ${deniedErr}`);
    assert(
      deniedErr.reason === "writes are blocked by this test fixture's policy",
      `expected the fixture's denial reason, got: ${deniedErr.reason}`,
    );
    console.log("Denied as expected:", deniedErr.message);

    console.log("Calling filesystem__list_files, which the fixture's policy allows...");
    const result = await computer.call("filesystem__list_files", {});
    console.log("list_files result:", result);
    assert(Array.isArray(result.files), `expected an allowed call to succeed normally, got: ${JSON.stringify(result)}`);

    console.log("\nPASS — the governance gate denies write_file and allows everything else, exactly per the fixture's policy.");
  } finally {
    await computer.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nGOVERNANCE GATE MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
