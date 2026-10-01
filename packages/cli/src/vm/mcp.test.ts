import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveEnforcementStatus } from "@berthos/audit";
import { VmSandbox } from "./sandbox.js";
import { enforcementOf, vmEvidence, vmSandboxSteps } from "./mcp.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fake-berth-vmm.test-fixture.js");
process.env.BERTH_HOME = mkdtempSync("/tmp/bvm-");
const spawn = ((_c: string, args: readonly string[], o: SpawnOptions) => nodeSpawn(process.execPath, [fixture, ...args], { ...o, env: { ...o.env, FAKE_VMM: "ok" } })) as unknown as typeof nodeSpawn;
const started: VmSandbox[] = [];
after(async () => {
  for (const s of started) if (s.isRunning()) await s.stop({ timeoutMs: 500 });
});

test("an MCP session attaches to a running VM sandbox: enforcement from agent-init's report, RPC to the named app, evidence for attest", async () => {
  const { sandbox } = await VmSandbox.start({ name: "berth-dev-app0", vmm: "/x/berth-vmm", apps: [{ name: "app0", share: "/s/app0" }], spawn });
  started.push(sandbox);
  for (let i = 0; i < 100 && enforcementOf(sandbox, "app0") === "unknown"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(enforcementOf(sandbox, "app0"), "enforced");
  assert.equal(enforcementOf(sandbox, "someone-else"), "unknown");

  const logs: string[] = [];
  const steps = vmSandboxSteps({ name: "berth-dev-app0", appName: "app0", appDir: "/unused", manifest: { name: "app0" } as never, readyTimeoutMs: 5_000, attachRpc: true, log: (m) => logs.push(m) });
  const found = await steps.find();
  assert.ok(found);
  assert.match(logs.join("\n"), /attached to the running microVM sandbox "berth-dev-app0"/);
  const connected = await steps.connect(found, false);
  assert.equal(connected.enforcement, "enforced");
  assert.deepEqual((await connected.rpc!.call({ id: "1", export: "echo", input: 7 })).result, { app: 0, echo: 7 });

  const evidence = await connected.evidence();
  assert.equal(evidence.bootId, sandbox.bootId);
  assert.equal(evidence.containerName, "berth-dev-app0");
  assert.equal(evidence.isolation?.kind, "microvm");
  assert.equal(evidence.isolation?.tsi, false);
  assert.equal(evidence.isolation?.nics, 0);
  assert.equal(deriveEnforcementStatus(evidence.rulesetReports, evidence.doctorProbe).status, "ACTIVE");
  assert.deepEqual(vmEvidence(found).rulesetReports, evidence.rulesetReports);

  await steps.stopByName();
  await sandbox.whenExited();
  assert.equal(await steps.find(), undefined);
});
