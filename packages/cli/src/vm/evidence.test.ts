import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEnforcementStatus } from "@berthos/audit";
import { consoleLines, vmBootEvidence, vmDoctorProbe, vmIsolation, vmRulesetReports } from "./evidence.js";
import { KERNEL_SHA256, ROOTFS_SHA256 } from "./pins.js";
import type { VmRecord } from "./sandbox.js";
import type { ControlEvent } from "./guest-lines.js";

const boot = "b-1";
const report = (app: string, ruleset: string, bootId = boot) => JSON.stringify({ source: "agent-init", event: "capability_policy_applied", bootId, app, ruleset, timestamp: 1 });
const record = (over: Partial<VmRecord> = {}): VmRecord => ({
  schema: 1,
  name: "berth-dev-notes",
  pid: 1,
  owner: 1,
  vmm: "/x/berth-vmm",
  runDir: "/r",
  startedAt: "t",
  apps: [{ index: 0, name: "notes", share: "/s/notes" }],
  vmConfig: { source: "berth-vmm", event: "vm_config", tsi: false, nics: 0, cpus: 2, memMiB: 512 },
  measurements: {
    source: "berth-vmm",
    event: "measurements",
    kernel: { sha256: KERNEL_SHA256, pinned: true, linux: "6.12.109", configSha256: "c".repeat(64), cmdline: "init=/sbin/berth-init" },
    rootfs: { sha256: ROOTFS_SHA256, pinned: true, fstype: "erofs", readOnly: true },
    state: { chunkedSha256: "d".repeat(64), sizeBytes: 1 << 30, created: false },
  },
  ...over,
});
const events: ControlEvent[] = [
  { source: "berth-init", event: "boot_start", bootId: boot, lsm: "capability,landlock,yama" },
  { source: "berth-init", event: "cgroup_delegation", bootId: boot, status: "active", controllers: "cpu memory pids" },
  { source: "berth-init", event: "cgroup_limits_applied", bootId: boot, app: "notes", cgroup: "/berth/apps/notes", limits: { "memory.max": "167772160" } },
];

test("ruleset reports: this boot only, first per app, and only from the app's own stream", () => {
  const lines = [
    { src: "notes", line: report("notes", "FullyEnforced", "old-boot") },
    { src: "notes", line: report("notes", "FullyEnforced") },
    { src: "notes", line: report("notes", "NotEnforced") }, // the app printing after agent-init exec'd it
    { src: "other", line: report("notes", "NotEnforced") }, // another app's stream claiming to be notes'
    { src: "berth-init", line: "not json" },
  ];
  assert.deepEqual(vmRulesetReports(lines, boot), [{ app: "notes", ruleset: "FullyEnforced", bootId: boot, timestamp: 1 }]);
});

test("console fallback reads berth-init's [src] mirror", () => {
  const text = `[    0.1] kernel line\n[notes] ${report("notes", "FullyEnforced")}\r\n[notes] [berth:runtime] ready\n`;
  assert.equal(vmRulesetReports(consoleLines(text), boot).length, 1);
});

test("isolation comes from berth-vmm's lines; a missing field is never read as off", () => {
  const iso = vmIsolation(record(), "darwin")!;
  assert.equal(iso.kind, "microvm");
  assert.equal(iso.hypervisor, "hvf");
  assert.equal(iso.kernel.sha256, KERNEL_SHA256);
  assert.equal(iso.rootfs.pinned, true);
  assert.equal(iso.tsi, false);
  assert.equal(iso.nics, 0);
  assert.equal(iso.state?.chunkedSha256, "d".repeat(64));
  const unknown = vmIsolation(record({ vmConfig: {} }), "linux")!;
  assert.equal(unknown.tsi, true);
  assert.equal(unknown.nics, -1);
  assert.equal(unknown.hypervisor, "kvm");
  assert.equal(vmIsolation(record({ measurements: {} })), undefined);
});

test("isolation says whether berth-vmm confined itself, and claims nothing when it didn't say", () => {
  assert.equal(vmIsolation(record())!.hostSandbox, undefined);
  const on = vmIsolation(record({ hostSandbox: { source: "berth-vmm", event: "host_sandbox", kind: "seatbelt", applied: true } }))!;
  assert.deepEqual(on.hostSandbox, { kind: "seatbelt", applied: true });
  const off = vmIsolation(record({ hostSandbox: { kind: null, applied: false, reason: "--no-host-sandbox" } }))!;
  assert.deepEqual(off.hostSandbox, { kind: null, applied: false, reason: "--no-host-sandbox" });
});

test("the probe: enforcing only for the pinned kernel running with landlock", () => {
  const iso = vmIsolation(record())!;
  assert.equal(vmDoctorProbe(iso, events).status, "enforcing");
  assert.match(vmDoctorProbe(iso, events).reason!, /not a behavioural probe/);
  assert.equal(vmDoctorProbe(iso, [{ source: "berth-init", event: "boot_start", lsm: "capability,yama" }]).status, "unsupported");
  assert.equal(vmDoctorProbe(iso, []).status, "unknown");
  assert.equal(vmDoctorProbe({ ...iso, kernel: { ...iso.kernel, sha256: "e".repeat(64), pinned: false } }, events).status, "unknown");
  assert.equal(vmDoctorProbe(undefined, events).status, "unknown");
});

test("a VM boot's evidence attests ACTIVE only with agent-init's report, and names the rootfs as the image", () => {
  const ev = vmBootEvidence({ record: record(), bootId: boot, controlEvents: events, logLines: [{ t: 1, src: "notes", stream: "stderr", line: report("notes", "FullyEnforced") }] });
  assert.equal(ev.imageDigest, `sha256:${ROOTFS_SHA256}`);
  assert.equal(ev.containerName, "berth-dev-notes");
  assert.equal(ev.runtime, "berth-vmm");
  assert.deepEqual(ev.policies, []);
  assert.equal(ev.resourceLimits?.status, "active");
  assert.equal(ev.resourceLimits?.apps[0]?.limits["memory.max"], "167772160");
  assert.equal(deriveEnforcementStatus(ev.rulesetReports, ev.doctorProbe).status, "ACTIVE");
  const none = vmBootEvidence({ record: record(), bootId: boot, controlEvents: events, logLines: [] });
  assert.equal(deriveEnforcementStatus(none.rulesetReports, none.doctorProbe).status, "UNDETERMINED");
});
