import { test } from "node:test";
import assert from "node:assert/strict";
import type { BerthManifest } from "@berth/manifest-schema";
import type { ComputerAppSpec } from "./resolve-apps.js";
import type { Tool } from "./types.js";
import { applyGovernanceGate, GovernanceDeniedError, GovernanceUnavailableError } from "./governance.js";

function appSpec(name: string, opts: { governs?: boolean; exempt?: boolean; exports?: string[] } = {}): ComputerAppSpec {
  const exportNames = opts.exports ?? [`${name}_export`];
  return {
    name,
    appDir: `/fake/${name}`,
    manifest: {
      name,
      exports: exportNames.map((n) => ({ name: n })),
      governs: opts.governs ?? false,
      governance: { exempt: opts.exempt ?? false },
    } as unknown as BerthManifest,
  };
}

function toolFor(name: string, invoke: Tool["invoke"] = async () => "raw-result"): Tool {
  return { name, description: "", inputSchema: {}, invoke };
}

test("applyGovernanceGate is a no-op when no app declares governs: true", () => {
  const apps = [appSpec("filesystem", { exports: ["read_file"] })];
  const tools = [toolFor("read_file")];
  const result = applyGovernanceGate(apps, apps, tools, async () => {
    throw new Error("should not be called");
  });
  assert.equal(result, tools);
});

/**
 * Regression test for the bug: Computer.connect({apps}) used to detect
 * governs:true from the *scoped* app list only, so a caller who didn't name
 * the governance app in `apps` got completely ungated tool calls — even
 * though every call still dispatches into the same shared container the
 * governor is actually running in. `allApps` (the full OS-loaded set) is
 * what governor-detection must use; `scopedApps`/`tools` is just what's
 * exposed to this particular caller.
 */
test("gates a scoped connect()'s tool calls even when the governor itself is excluded from that scope", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const allApps = [governor, filesystem];
  const scopedApps = [filesystem]; // e.g. Computer.connect({ apps: ["filesystem"] })

  const calls: Array<{ appName: string; exportName: string }> = [];
  const call = async (appName: string, exportName: string, _input: unknown) => {
    calls.push({ appName, exportName });
    if (appName === "gatekeeper" && exportName === "evaluate_action") {
      return { allowed: false, reason: "no writes allowed" };
    }
    return "raw-result";
  };

  const tools = [toolFor("write_file", (input) => call("filesystem", "write_file", input))];
  const gated = applyGovernanceGate(allApps, scopedApps, tools, call);

  await assert.rejects(() => gated[0]!.invoke({ path: "/etc/passwd" }), GovernanceDeniedError);
  assert.deepEqual(calls[0], { appName: "gatekeeper", exportName: "evaluate_action" });
});

test("lets the call through once the out-of-scope governor approves it", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const allApps = [governor, filesystem];
  const scopedApps = [filesystem];

  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") return { allowed: true };
    return "raw-result";
  };

  const tools = [toolFor("write_file", (input) => call("filesystem", "write_file", input))];
  const gated = applyGovernanceGate(allApps, scopedApps, tools, call);

  assert.equal(await gated[0]!.invoke({}), "raw-result");
});

test("fails open (lets the call through) if the out-of-scope governor call errors", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const allApps = [governor, filesystem];
  const scopedApps = [filesystem];

  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") throw new Error("governor unreachable");
    return "raw-result";
  };

  const tools = [toolFor("write_file", (input) => call("filesystem", "write_file", input))];
  const gated = applyGovernanceGate(allApps, scopedApps, tools, call);

  assert.equal(await gated[0]!.invoke({}), "raw-result");
});

test("never gates the governor's own tools, in or out of scope", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const allApps = [governor];
  let evaluateCalls = 0;
  const call = async (_appName: string, exportName: string, _input: unknown) => {
    if (exportName === "evaluate_action") evaluateCalls++;
    return "raw-result";
  };
  const tools = [toolFor("evaluate_action", (input) => call("gatekeeper", "evaluate_action", input))];

  const gated = applyGovernanceGate(allApps, allApps, tools, call);
  await gated[0]!.invoke({});

  assert.equal(evaluateCalls, 1, "the direct invocation itself should run, but never be re-gated through itself");
});

test("fail-closed mode throws GovernanceUnavailableError instead of letting the call through on an unreachable governor", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const allApps = [governor, filesystem];
  const scopedApps = [filesystem];

  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") throw new Error("governor unreachable");
    return "raw-result";
  };

  const tools = [toolFor("write_file", (input) => call("filesystem", "write_file", input))];
  const gated = applyGovernanceGate(allApps, scopedApps, tools, call, { mode: "fail-closed" });

  await assert.rejects(() => gated[0]!.invoke({}), GovernanceUnavailableError);
});

test("fail-closed mode still lets an approved call through — it only changes the unreachable-governor case", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const allApps = [governor, filesystem];
  const scopedApps = [filesystem];

  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") return { allowed: true };
    return "raw-result";
  };

  const tools = [toolFor("write_file", (input) => call("filesystem", "write_file", input))];
  const gated = applyGovernanceGate(allApps, scopedApps, tools, call, { mode: "fail-closed" });

  assert.equal(await gated[0]!.invoke({}), "raw-result");
});

test("fail-closed mode still denies an explicitly-denied call the normal way, not as GovernanceUnavailableError", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const allApps = [governor, filesystem];
  const scopedApps = [filesystem];

  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") return { allowed: false, reason: "no" };
    return "raw-result";
  };

  const tools = [toolFor("write_file", (input) => call("filesystem", "write_file", input))];
  const gated = applyGovernanceGate(allApps, scopedApps, tools, call, { mode: "fail-closed" });

  await assert.rejects(() => gated[0]!.invoke({}), GovernanceDeniedError);
});

test("mode defaults to fail-open when omitted, unchanged from before this option existed", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const allApps = [governor, filesystem];
  const scopedApps = [filesystem];

  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") throw new Error("governor unreachable");
    return "raw-result";
  };

  const tools = [toolFor("write_file", (input) => call("filesystem", "write_file", input))];
  const gated = applyGovernanceGate(allApps, scopedApps, tools, call);

  assert.equal(await gated[0]!.invoke({}), "raw-result");
});

test("an app can opt out via governance.exempt even when in scope", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const trusted = appSpec("trusted-app", { exempt: true, exports: ["do_thing"] });
  const allApps = [governor, trusted];

  let evaluateCalls = 0;
  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") evaluateCalls++;
    return "raw-result";
  };
  const tools = [toolFor("do_thing", (input) => call("trusted-app", "do_thing", input))];

  const gated = applyGovernanceGate(allApps, [trusted], tools, call);
  assert.equal(await gated[0]!.invoke({}), "raw-result");
  assert.equal(evaluateCalls, 0, "exempt app's calls must never be routed through evaluate_action");
});
