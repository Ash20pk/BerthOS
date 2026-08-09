#!/usr/bin/env node
// Real, running verification of the governance gate (docs/governance-reference.md):
// when a Computer loads an app declaring `governs: true`, every other app's
// tool calls get routed through that app's evaluate_action export first.
// This fixture denies write_file and allows everything else.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Docker from "dockerode";
import { Computer, GovernanceDeniedError } from "../dist/index.js";
import { invokeAppExport } from "@berth/docker-orchestrator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const GOVERNANCE_APP_DIR = join(__dirname, "fixtures", "governance-gate-tester");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("Booting a Computer with apps/filesystem + the governance-gate-tester fixture...");
  // httpRpc so the bridge — one of the transports REMEDIATION.md 1.13 lists
  // as ungated — actually exists in this container to be tested.
  const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR, GOVERNANCE_APP_DIR], httpRpc: true });

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

    await assertTransportsAreGated(computer);
  } finally {
    await computer.stop();
  }
}

/**
 * REMEDIATION.md 1.13's second half: the same denial, through the transports
 * that never touch a Computer. Before the SDK-dispatch gate, each of these
 * reached the app's export with no governor anywhere on the path — so an
 * agent denied `write_file` above could simply ask again over one of these
 * and be obeyed.
 *
 * One row per transport, each with its own allowed-call control, because a
 * transport that had simply stopped working would "pass" every denial
 * assertion here.
 */
async function assertTransportsAreGated(computer) {
  const container = new Docker().getContainer(computer.containerName);
  const denied = /governance denied write_file/;

  console.log("\n--- Transport: the relay (what `berth rpc` and `berth mcp` use) ---");
  const relayDenied = await invokeAppExport(container, "filesystem", {
    id: "gate-relay-1",
    export: "write_file",
    input: { path: "via-relay.txt", content: "should never land" },
  });
  console.log("relay response:", relayDenied);
  assert(
    denied.test(relayDenied.error ?? ""),
    `expected the relay call to be denied by governance, got: ${JSON.stringify(relayDenied)} — a response with no error means the write ran, ` +
      "i.e. the same action the Computer just denied succeeded over `berth rpc`",
  );

  const relayAllowed = await invokeAppExport(container, "filesystem", { id: "gate-relay-2", export: "list_files", input: {} });
  assert(!relayAllowed.error, `expected an allowed export to still work over the relay, got: ${JSON.stringify(relayAllowed)}`);
  console.log("PASS — `berth rpc`'s own transport is gated, and an allowed export still runs on it.");

  console.log("\n--- Transport: the HTTP RPC bridge ---");
  assert(computer.httpRpc, "expected httpRpc: true to expose a bridge on the handle");
  const httpDenied = await bridgeCall(computer.httpRpc, {
    id: "gate-http-1",
    export: "write_file",
    input: { path: "via-http.txt", content: "should never land" },
  });
  console.log("bridge response:", httpDenied);
  assert(
    denied.test(httpDenied.error ?? ""),
    `expected the HTTP bridge call to be denied by governance, got: ${JSON.stringify(httpDenied)} — a response with no error means the write ran`,
  );

  const httpAllowed = await bridgeCall(computer.httpRpc, { id: "gate-http-2", export: "list_files", input: {} });
  assert(!httpAllowed.error, `expected an allowed export to still work over the bridge, got: ${JSON.stringify(httpAllowed)}`);
  console.log("PASS — the HTTP RPC bridge is gated, and an allowed export still runs on it.");

  // The file is the last word on it: a denial that still wrote would be a
  // denial in the logs only.
  const listed = await invokeAppExport(container, "filesystem", { id: "gate-relay-3", export: "list_files", input: {} });
  const names = JSON.stringify(listed.result ?? {});
  assert(!names.includes("via-relay.txt") && !names.includes("via-http.txt"), `a denied write still reached the filesystem: ${names}`);
  console.log("PASS — neither denied write exists on disk.");
}

async function bridgeCall(httpRpc, request) {
  // The handle carries the bridge's origin; the bridge itself serves POST
  // /rpc (http-rpc.ts:30) and 404s anything else.
  const res = await fetch(`${httpRpc.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${httpRpc.authToken}` },
    body: JSON.stringify(request),
  });
  return res.json();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nGOVERNANCE GATE MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
