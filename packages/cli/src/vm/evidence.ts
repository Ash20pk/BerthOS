import type { BootIsolation, DoctorProbeResult, RulesetReport } from "@berthos/audit";
import type { BootEvidence, ResourceLimitsEvidence } from "@berthos/docker-orchestrator";
import { parseObject, type ControlEvent, type GuestLogLine } from "./guest-lines.js";
import { KERNEL_SHA256 } from "./pins.js";
import type { VmRecord } from "./sandbox.js";

/**
 * The boot evidence `berth attest` binds, for a sandbox in the local microVM.
 * Same shape as a container's (docker-orchestrator's gatherBootEvidence),
 * from the VM's own sources:
 *
 *  - bootId: berth-init's, from the control port's greeting.
 *  - rulesetReports: agent-init's capability_policy_applied lines on the log
 *    port, for this boot. Only the first per app, and only from that app's
 *    own stream: agent-init prints before it execs the app, so a later line
 *    claiming otherwise, or a line on another app's stream, is not agent-init's.
 *  - resourceLimits: berth-init's cgroup_delegation / cgroup_limits_applied events.
 *  - isolation: berth-vmm's measurement line (kernel and rootfs by sha256,
 *    whether they were the pinned ones, the state disk's digest) and its
 *    vm_config line (TSI, NIC count, vCPUs, memory).
 *  - doctorProbe: the Docker path probes the host's kernel, because that
 *    kernel varies. Here the kernel is fixed by hash, and berth-init reports
 *    the LSMs the running kernel actually has (/sys/kernel/security/lsm). So
 *    the probe is "enforcing" when the measured kernel is the pinned one and
 *    the running kernel lists landlock, "unsupported" when it doesn't, and
 *    "unknown" for an unpinned kernel. It says so in its reason; it is not a
 *    behavioural probe run at this boot (the vmm e2e's enforce suite is, for
 *    this kernel).
 *  - policies: empty. The policy file is compiled inside the guest, at
 *    /run/berth/policy, and berth-init does not report its sha256 yet; the
 *    record says so through an empty list rather than a host-side recompile.
 *  - imageDigest: the rootfs's sha256, the VM's equivalent of an image.
 */

export interface VmEvidenceInput {
  record: VmRecord;
  bootId: string;
  controlEvents: ControlEvent[];
  /** Log-port lines (guest.log, or the owner's live pump). */
  logLines: GuestLogLine[];
  /** The guest console (console.log), used when there are no log-port lines. */
  consoleText?: string;
  platform?: NodeJS.Platform;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** agent-init's report lines for one boot, first per app, only from the app's own stream. */
export function vmRulesetReports(lines: { src: string; line: string }[], bootId: string): RulesetReport[] {
  const seen = new Set<string>();
  const out: RulesetReport[] = [];
  for (const { src, line } of lines) {
    if (!line.startsWith("{")) continue;
    const e = parseObject(line);
    if (!e || e.source !== "agent-init" || e.event !== "capability_policy_applied" || e.bootId !== bootId) continue;
    const app = str(e.app);
    const ruleset = str(e.ruleset);
    if (!app || !ruleset || app !== src || seen.has(app)) continue;
    seen.add(app);
    out.push({ app, ruleset, bootId, ...(typeof e.timestamp === "number" ? { timestamp: e.timestamp } : {}) });
  }
  return out;
}

/** console.log lines as berth-init mirrors them: `[<src>] <line>`. */
export function consoleLines(text: string): { src: string; line: string }[] {
  const out: { src: string; line: string }[] = [];
  for (const raw of text.split("\n")) {
    const m = /^\[([a-z0-9-]{1,64})\] (.*)$/.exec(raw.replace(/\r$/, ""));
    if (m) out.push({ src: m[1]!, line: m[2]! });
  }
  return out;
}

export function vmResourceLimits(events: ControlEvent[]): ResourceLimitsEvidence {
  const evidence: ResourceLimitsEvidence = { status: "unknown", apps: [] };
  let delegation = false;
  const seen = new Set<string>();
  for (const e of events) {
    if (e.event === "cgroup_delegation" && !delegation) {
      delegation = true;
      if (e.status === "active" || e.status === "inactive") evidence.status = e.status;
      if (typeof e.reason === "string") evidence.reason = e.reason;
      if (typeof e.controllers === "string") evidence.controllers = e.controllers;
    } else if (e.event === "cgroup_limits_applied" && typeof e.app === "string" && !seen.has(e.app)) {
      seen.add(e.app);
      const limits: Record<string, string> = {};
      if (e.limits && typeof e.limits === "object") {
        for (const [k, v] of Object.entries(e.limits as Record<string, unknown>)) if (typeof v === "string") limits[k] = v;
      }
      evidence.apps.push({ app: e.app, cgroup: str(e.cgroup) ?? "", limits });
    }
  }
  return evidence;
}

export function vmIsolation(record: VmRecord, platform: NodeJS.Platform = process.platform): BootIsolation | undefined {
  const m = record.measurements as
    | { kernel?: Record<string, unknown> | null; rootfs?: Record<string, unknown> | null; state?: Record<string, unknown> | null }
    | undefined;
  const k = m?.kernel;
  const r = m?.rootfs;
  if (!k || !r || typeof k.sha256 !== "string" || typeof r.sha256 !== "string") return undefined;
  const c = (record.vmConfig ?? {}) as Record<string, unknown>;
  const s = m?.state;
  return {
    kind: "microvm",
    engine: "libkrun",
    hypervisor: platform === "darwin" ? "hvf" : "kvm",
    kernel: {
      sha256: k.sha256,
      pinned: k.pinned === true,
      ...(str(k.linux) ? { linux: str(k.linux) } : {}),
      ...(str(k.configSha256) ? { configSha256: str(k.configSha256) } : {}),
      ...(str(k.cmdline) ? { cmdline: str(k.cmdline) } : {}),
    },
    rootfs: { sha256: r.sha256, pinned: r.pinned === true, ...(str(r.fstype) ? { fstype: str(r.fstype) } : {}), readOnly: r.readOnly === true },
    ...(s && typeof s.chunkedSha256 === "string"
      ? { state: { chunkedSha256: s.chunkedSha256, sizeBytes: typeof s.sizeBytes === "number" ? s.sizeBytes : 0, created: s.created === true } }
      : {}),
    // Read from what berth-vmm says it configured; a missing field is not "off".
    tsi: c.tsi !== false,
    nics: typeof c.nics === "number" ? c.nics : -1,
    ...(typeof c.cpus === "number" ? { vcpus: c.cpus } : {}),
    ...(typeof c.memMiB === "number" ? { memMiB: c.memMiB } : {}),
  };
}

export function vmDoctorProbe(isolation: BootIsolation | undefined, events: ControlEvent[]): DoctorProbeResult {
  const start = events.find((e) => e.event === "boot_start");
  const lsm = str(start?.lsm);
  if (!isolation) return { status: "unknown", reason: "berth-vmm's measurement line was not recorded for this boot" };
  if (!isolation.kernel.pinned || isolation.kernel.sha256 !== KERNEL_SHA256) {
    return { status: "unknown", reason: `the guest kernel ${isolation.kernel.sha256.slice(0, 12)}… is not the pinned one; nothing is known about its Landlock support` };
  }
  if (!lsm) return { status: "unknown", reason: "berth-init did not report the guest kernel's LSMs at this boot" };
  if (!lsm.split(",").includes("landlock")) return { status: "unsupported", reason: `the guest kernel's LSMs are ${lsm}, without landlock` };
  return {
    status: "enforcing",
    reason: `pinned guest kernel ${isolation.kernel.sha256.slice(0, 12)}… (measured by berth-vmm at boot), running with LSMs ${lsm} (berth-init's boot_start); derived from the kernel's identity, not a behavioural probe at this boot`,
  };
}

export function vmBootEvidence(input: VmEvidenceInput): BootEvidence {
  const { record, bootId } = input;
  const lines = input.logLines.length > 0 ? input.logLines : consoleLines(input.consoleText ?? "");
  const isolation = vmIsolation(record, input.platform);
  const rootfs = isolation?.rootfs.sha256;
  return {
    bootId,
    containerName: record.name,
    imageTag: rootfs ? `rootfs-${rootfs.slice(0, 12)}.erofs` : "unknown",
    imageDigest: rootfs ? `sha256:${rootfs}` : "unknown",
    runtime: "berth-vmm",
    rulesetReports: vmRulesetReports(lines, bootId),
    policies: [],
    doctorProbe: vmDoctorProbe(isolation, input.controlEvents),
    resourceLimits: vmResourceLimits(input.controlEvents),
    ...(isolation ? { isolation } : {}),
  };
}
