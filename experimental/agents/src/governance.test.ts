import { test } from "node:test";
import assert from "node:assert/strict";
import type { BerthManifest } from "@berth/manifest-schema";
import type { ComputerAppSpec } from "./resolve-apps.js";
import type { Tool } from "./types.js";
import { applyGovernanceGate, resolveGovernanceGate, GovernanceDeniedError, GovernanceUnavailableError } from "./governance.js";
import { agentActor, createMemoryAuditSink } from "@berth/audit";

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

test("an out-of-scope governor is still consulted — an unreachable one now refuses the call (fail-closed default)", async () => {
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

  // The rejection is itself the proof the governor was consulted: an ungated
  // tool would simply have returned "raw-result".
  await assert.rejects(() => gated[0]!.invoke({}), GovernanceUnavailableError);
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

test("mode defaults to fail-closed when omitted (REMEDIATION.md 1.11 inverted this)", async () => {
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

  await assert.rejects(() => gated[0]!.invoke({}), GovernanceUnavailableError);
});

test("fail-open is still available for callers who ask for it by name", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const allApps = [governor, filesystem];
  const scopedApps = [filesystem];

  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") throw new Error("governor unreachable");
    return "raw-result";
  };

  const tools = [toolFor("write_file", (input) => call("filesystem", "write_file", input))];
  const gated = applyGovernanceGate(allApps, scopedApps, tools, call, { mode: "fail-open" });

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

// --- REMEDIATION.md 1.13 -----------------------------------------------------
// The gate used to be applied by mapping over one Tool[], so it protected
// exactly what was in that array and nothing else. These cover the two shapes
// that replaced it.

test("gateDispatch gates a call made through the dispatch itself, not just one made through a tool", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });

  const call = async (appName: string, exportName: string, _input: unknown) => {
    if (appName === "gatekeeper" && exportName === "evaluate_action") return { allowed: false, reason: "no writes" };
    return "raw-result";
  };
  const gate = resolveGovernanceGate([governor, filesystem], call)!;
  const dispatch = gate.gateDispatch(async () => "raw-result");

  await assert.rejects(() => dispatch("filesystem", "write_file", {}), GovernanceDeniedError);
});

test("gateDispatch never gates the governor's own exports — evaluate_action would otherwise recurse forever", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  let evaluateCalls = 0;
  const call = async (_appName: string, exportName: string, _input: unknown) => {
    if (exportName === "evaluate_action") evaluateCalls++;
    return { allowed: true };
  };
  const gate = resolveGovernanceGate([governor], call)!;
  const dispatch = gate.gateDispatch(async () => "raw-result");

  assert.equal(await dispatch("gatekeeper", "evaluate_action", {}), "raw-result");
  assert.equal(evaluateCalls, 0, "the governor's own export must not be routed back through the gate");
});

test("gateDispatch respects governance.exempt", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const trusted = appSpec("trusted-app", { exempt: true, exports: ["do_thing"] });
  let evaluateCalls = 0;
  const call = async (_appName: string, exportName: string, _input: unknown) => {
    if (exportName === "evaluate_action") evaluateCalls++;
    return { allowed: false, reason: "would deny if asked" };
  };
  const gate = resolveGovernanceGate([governor, trusted], call)!;
  const dispatch = gate.gateDispatch(async () => "raw-result");

  assert.equal(await dispatch("trusted-app", "do_thing", {}), "raw-result");
  assert.equal(evaluateCalls, 0);
});

test("gateExternalTool gates an MCP tool under mcp:<server>, which used to bypass the gate entirely", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const seen: unknown[] = [];
  const call = async (_appName: string, exportName: string, input: unknown) => {
    if (exportName === "evaluate_action") {
      seen.push(input);
      return { allowed: false, reason: "not that one" };
    }
    return "raw-result";
  };
  const gate = resolveGovernanceGate([governor], call)!;
  const gated = gate.gateExternalTool(toolFor("create_issue"), { app: "mcp:github", export: "create_issue" });

  await assert.rejects(() => gated.invoke({ title: "x" }), GovernanceDeniedError);
  assert.deepEqual(seen[0], { app: "mcp:github", export: "create_issue", input: { title: "x" } });
});

test("gateExternalTool gates agent-as-tool delegation under agent:<name>", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const seen: unknown[] = [];
  const call = async (_appName: string, exportName: string, input: unknown) => {
    if (exportName === "evaluate_action") {
      seen.push(input);
      return { allowed: true };
    }
    return "raw-result";
  };
  const gate = resolveGovernanceGate([governor], call)!;
  const gated = gate.gateExternalTool(toolFor("researcher"), { app: "agent:researcher", export: "invoke" });

  assert.equal(await gated.invoke({ task: "find things" }), "raw-result");
  assert.deepEqual(seen[0], { app: "agent:researcher", export: "invoke", input: { task: "find things" } });
});

test("an unreachable governor blocks an MCP tool too, not only resident-app calls (fail-closed default)", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const call = async (_appName: string, exportName: string, _input: unknown) => {
    if (exportName === "evaluate_action") throw new Error("governor unreachable");
    return "raw-result";
  };
  const gate = resolveGovernanceGate([governor], call)!;
  const gated = gate.gateExternalTool(toolFor("create_issue"), { app: "mcp:github", export: "create_issue" });

  await assert.rejects(() => gated.invoke({}), GovernanceUnavailableError);
});

test("resolveGovernanceGate is undefined when no app governs — callers then pay nothing", () => {
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  assert.equal(
    resolveGovernanceGate([filesystem], async () => {
      throw new Error("should not be called");
    }),
    undefined,
  );
});

// --- Audit trail (REMEDIATION.md 5.1) ------------------------------------
//
// The finding these cover is not "denials behave wrong" — they always threw
// correctly. It is that they left no record, so an operator asking "was this
// gate ever consulted, and what did it refuse" had nothing to read.

test("records a denial with its reason and the gated target", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const call = async (appName: string, exportName: string) =>
    appName === "gatekeeper" && exportName === "evaluate_action"
      ? { allowed: false, reason: "no writes allowed" }
      : "raw-result";

  const audit = createMemoryAuditSink();
  const tools = [toolFor("write_file")];
  const gated = applyGovernanceGate([governor, filesystem], [filesystem], tools, call, { audit });

  await assert.rejects(() => gated[0]!.invoke({ path: "/etc/passwd" }, {} as never), GovernanceDeniedError);

  assert.equal(audit.records.length, 1);
  const record = audit.records[0]!;
  assert.equal(record.action, "governance.evaluate");
  assert.equal(record.target, "filesystem.write_file");
  assert.equal(record.decision, "denied");
  assert.equal(record.reason, "no writes allowed");
});

test("records allowed calls too, so the trail can answer what an agent did", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const call = async (appName: string) => (appName === "gatekeeper" ? { allowed: true } : "raw-result");

  const audit = createMemoryAuditSink();
  const gated = applyGovernanceGate([governor, filesystem], [filesystem], [toolFor("write_file")], call, { audit });
  await gated[0]!.invoke({ path: "/workspace/a.txt" }, {} as never);

  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]!.decision, "allowed");
});

test("records an unreachable governor as unavailable, not as a denial", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const call = async (appName: string) => {
    if (appName === "gatekeeper") throw new Error("governor crashed");
    return "raw-result";
  };

  const audit = createMemoryAuditSink();
  const gated = applyGovernanceGate([governor, filesystem], [filesystem], [toolFor("write_file")], call, {
    mode: "fail-closed",
    audit,
  });
  await assert.rejects(() => gated[0]!.invoke({}, {} as never), GovernanceUnavailableError);

  assert.equal(audit.records[0]!.decision, "unavailable");
  assert.match(audit.records[0]!.reason!, /governor crashed/);
});

test("records the fail-open case, where the call ran without a verdict", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const call = async (appName: string) => {
    if (appName === "gatekeeper") throw new Error("governor crashed");
    return "raw-result";
  };

  const audit = createMemoryAuditSink();
  const gated = applyGovernanceGate([governor, filesystem], [filesystem], [toolFor("write_file")], call, {
    mode: "fail-open",
    audit,
  });
  // The call succeeds — which is exactly why the record has to exist.
  assert.equal(await gated[0]!.invoke({}, {} as never), "raw-result");
  assert.equal(audit.records[0]!.decision, "unavailable");
  assert.equal(audit.records[0]!.meta?.mode, "fail-open");
});

test("attributes records to the configured actor", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const call = async (appName: string) => (appName === "gatekeeper" ? { allowed: true } : "raw-result");

  const audit = createMemoryAuditSink();
  const gated = applyGovernanceGate([governor, filesystem], [filesystem], [toolFor("write_file")], call, {
    audit,
    actor: agentActor("research-agent"),
  });
  await gated[0]!.invoke({}, {} as never);

  assert.deepEqual(audit.records[0]!.actor, { kind: "agent", id: "research-agent", verifiedBy: "self-asserted" });
});

test("defaults to an anonymous actor rather than inventing a name", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const call = async (appName: string) => (appName === "gatekeeper" ? { allowed: true } : "raw-result");

  const audit = createMemoryAuditSink();
  const gated = applyGovernanceGate([governor, filesystem], [filesystem], [toolFor("write_file")], call, { audit });
  await gated[0]!.invoke({}, {} as never);

  assert.equal(audit.records[0]!.actor.kind, "anonymous");
  assert.equal(audit.records[0]!.actor.verifiedBy, "self-asserted");
});

test("resolveGovernanceGate's dispatch path audits identically to the tool path", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const call = async (appName: string) =>
    appName === "gatekeeper" ? { allowed: false, reason: "nope" } : "raw-result";

  const audit = createMemoryAuditSink();
  const gate = resolveGovernanceGate([governor, filesystem], call, { audit })!;
  const dispatch = gate.gateDispatch(async () => "raw-result");

  await assert.rejects(() => dispatch("filesystem", "write_file", {}), GovernanceDeniedError);
  assert.equal(audit.records[0]!.target, "filesystem.write_file");
  assert.equal(audit.records[0]!.decision, "denied");
});

test("an audit sink that throws never fails the gated call", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const filesystem = appSpec("filesystem", { exports: ["write_file"] });
  const call = async (appName: string) => (appName === "gatekeeper" ? { allowed: true } : "raw-result");

  const audit = { record: async () => { throw new Error("audit backend down"); } };
  const gated = applyGovernanceGate([governor, filesystem], [filesystem], [toolFor("write_file")], call, { audit });
  assert.equal(await gated[0]!.invoke({}, {} as never), "raw-result");
});

test("exempt and governor apps are not audited — they were never gated", async () => {
  const governor = appSpec("gatekeeper", { governs: true, exports: ["evaluate_action"] });
  const trusted = appSpec("trusted", { exempt: true, exports: ["do_thing"] });
  const call = async () => "raw-result";

  const audit = createMemoryAuditSink();
  const gated = applyGovernanceGate([governor, trusted], [trusted], [toolFor("do_thing")], call, { audit });
  await gated[0]!.invoke({}, {} as never);
  assert.equal(audit.records.length, 0);
});
