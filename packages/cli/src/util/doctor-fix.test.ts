import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { planMacEnforcementFix, type MacFixFacts } from "./doctor-fix.js";

const base: MacFixFacts = {
  platform: "darwin",
  colimaInstalled: true,
  brewInstalled: true,
  vmRunning: false,
};

test("refuses to fix a non-mac host", () => {
  assert.throws(() => planMacEnforcementFix({ ...base, platform: "linux" }), /only knows how to fix macOS/);
});

test("refuses when neither colima nor brew exists, and says what to do", () => {
  assert.throws(
    () => planMacEnforcementFix({ ...base, colimaInstalled: false, brewInstalled: false }),
    /Install Colima manually/,
  );
});

test("installs colima via brew only when missing", () => {
  const withColima = planMacEnforcementFix(base);
  assert.ok(!withColima.steps.some((s) => s.argv[0] === "brew"));

  const withoutColima = planMacEnforcementFix({ ...base, colimaInstalled: false });
  assert.deepEqual(withoutColima.steps[0]?.argv, ["brew", "install", "colima", "docker"]);
});

test("starts the VM with the enforcement-relevant flags: vz, virtiofs, writable $HOME", () => {
  const plan = planMacEnforcementFix(base);
  const start = plan.steps.find((s) => s.argv[1] === "start");
  assert.ok(start, "expected a colima start step");
  const argv = start.argv.join(" ");
  assert.match(argv, /--vm-type vz/);
  assert.match(argv, /--mount-type virtiofs/);
  assert.ok(start.argv.includes(`${homedir()}:w`), "$HOME must be mounted writable");
});

test("a running VM produces no steps, only the socket to re-check against", () => {
  const plan = planMacEnforcementFix({ ...base, vmRunning: true });
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.dockerHost, `unix://${homedir()}/.colima/default/docker.sock`);
  assert.match(plan.exportLine, /^export DOCKER_HOST=/);
});

test("profile and sizing knobs flow through", () => {
  const plan = planMacEnforcementFix({ ...base, profile: "berth", cpu: "8", memory: "16", disk: "100" });
  const start = plan.steps.find((s) => s.argv[1] === "start");
  assert.ok(start);
  const argv = start.argv.join(" ");
  assert.match(argv, /--profile berth/);
  assert.match(argv, /--cpu 8/);
  assert.match(argv, /--memory 16/);
  assert.match(argv, /--disk 100/);
  assert.equal(plan.dockerHost, `unix://${homedir()}/.colima/berth/docker.sock`);
});
