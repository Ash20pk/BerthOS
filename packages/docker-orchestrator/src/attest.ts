import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { DoctorProbeResult, PolicyDigest, RulesetReport } from "@berthos/audit";
import { enforcementStatusForBoot } from "./doctor.js";

/**
 * The host-side evidence gathering behind `berth attest`.
 *
 * Everything an attestation binds about a *boot* lives in places only the
 * Docker API can reach from the host: the boot ID and agent-init's ruleset
 * reports exist only on the container's stderr, the enforced capability
 * policy exists only as a file inside the container, and the image digest
 * only in the daemon's records. This module reads them all as they are —
 * no field here is computed from what the manifest *says*, only from what
 * the boot *did*.
 */

export interface BootEvidence {
  bootId: string;
  containerName: string;
  imageTag: string;
  imageDigest: string;
  runtime?: string;
  rulesetReports: RulesetReport[];
  policies: PolicyDigest[];
  doctorProbe: DoctorProbeResult;
  /** What entrypoint.sh reported applying to each app's cgroup at this boot. Absent from evidence recorded before it existed. */
  resourceLimits?: ResourceLimitsEvidence;
}

/**
 * The per-app cgroup limits a boot applied, from entrypoint.sh's
 * `cgroup_delegation` and `cgroup_limits_applied` events. The limits are read
 * back from the kernel after they were written, so they say what the cgroup
 * holds, not what the manifest asked for — that is already bound by the
 * policy digest, since each app's `cgroupLimits` is in the policy file.
 */
export interface ResourceLimitsEvidence {
  /** `active`: every app below has a cgroup of its own. `inactive`: none does, see `reason`. `unknown`: the boot logged neither. */
  status: "active" | "inactive" | "unknown";
  reason?: string;
  /** The controllers enabled for the apps, space-separated as the kernel lists them. */
  controllers?: string;
  apps: { app: string; cgroup: string; limits: Record<string, string> }[];
}

/**
 * Docker multiplexes stdout/stderr into 8-byte-headered frames when the
 * container has no TTY. The log lines we want (entrypoint boot id, agent-init
 * JSON events) are on stderr, but nothing here cares which stream a line came
 * from — so concatenate every frame's payload and let the line parsers sort
 * the text out.
 */
export function demuxLogBuffer(buffer: Buffer): string {
  // A TTY container's logs have no framing. Frame headers start with the
  // stream byte (0|1|2) followed by three zero bytes — absent that signature,
  // treat the whole buffer as plain text.
  if (buffer.length < 8 || buffer[0]! > 2 || buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) {
    return buffer.toString("utf-8");
  }
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    parts.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString("utf-8");
}

/** The newest `[berth:entrypoint] boot id: <uuid>` line wins — a restarted container logs one per boot. */
export function parseBootId(logs: string): string | undefined {
  let found: string | undefined;
  for (const line of logs.split("\n")) {
    const match = line.match(/\[berth:entrypoint\] boot id: (\S+)/);
    if (match) found = match[1];
  }
  return found;
}

/**
 * agent-init's `capability_policy_applied` events for one boot, as printed
 * (agent-init/src/main.rs emits them un-prefixed so they parse as JSON).
 * Filtering by bootId is what keeps a restarted container's stale reports
 * from attesting the current boot.
 */
export function parseRulesetReports(logs: string, bootId: string): RulesetReport[] {
  const reports: RulesetReport[] = [];
  for (const line of logs.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.source !== "agent-init" || event.event !== "capability_policy_applied") continue;
      if (event.bootId !== bootId) continue;
      if (typeof event.app !== "string" || typeof event.ruleset !== "string") continue;
      reports.push({
        app: event.app,
        ruleset: event.ruleset,
        bootId,
        ...(typeof event.timestamp === "number" ? { timestamp: event.timestamp } : {}),
      });
    } catch {
      // Not JSON — an ordinary log line.
    }
  }
  return reports;
}

/**
 * entrypoint.sh's cgroup events for one boot. The first event of each kind
 * (per app, for the limits) wins: entrypoint.sh prints its own before the app
 * it describes has been exec'd, and an app's stderr shares this log, so a
 * later line claiming otherwise is the one that cannot be the entrypoint's.
 */
export function parseResourceLimits(logs: string, bootId: string): ResourceLimitsEvidence {
  const evidence: ResourceLimitsEvidence = { status: "unknown", apps: [] };
  let delegationSeen = false;
  const seenApps = new Set<string>();
  for (const line of logs.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.source !== "berth-entrypoint" || event.bootId !== bootId) continue;
    if (event.event === "cgroup_delegation" && !delegationSeen) {
      delegationSeen = true;
      if (event.status === "active" || event.status === "inactive") evidence.status = event.status;
      if (typeof event.reason === "string") evidence.reason = event.reason;
      if (typeof event.controllers === "string") evidence.controllers = event.controllers;
    } else if (event.event === "cgroup_limits_applied" && typeof event.app === "string" && !seenApps.has(event.app)) {
      seenApps.add(event.app);
      const limits: Record<string, string> = {};
      if (event.limits && typeof event.limits === "object") {
        for (const [file, value] of Object.entries(event.limits as Record<string, unknown>)) {
          if (typeof value === "string") limits[file] = value;
        }
      }
      evidence.apps.push({ app: event.app, cgroup: typeof event.cgroup === "string" ? event.cgroup : "", limits });
    }
  }
  return evidence;
}

/** Parses the `<sha256> <appName> <path>` lines POLICY_DIGEST_SCRIPT prints. */
export function parsePolicyLines(output: string): PolicyDigest[] {
  const policies: PolicyDigest[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^([0-9a-f]{64}) (\S+) (\S+)$/);
    if (match) policies.push({ sha256: match[1]!, app: match[2]!, path: match[3]! });
  }
  return policies;
}

/**
 * Hashes every enforced policy file where it lies. The digest is computed
 * inside the container (sha256sum over the exact bytes agent-init read) so
 * no transport re-encoding can touch it. Apps live under /app in prod
 * images and under the /workspace bind in dev boots — entrypoint.sh sets
 * BERTH_CAPABILITY_POLICY to <app_dir>/.berth/capability-policy.json in
 * every layout, so both roots are searched and the results filtered to the
 * apps agent-init actually reported for this boot (a dev /workspace bind of
 * a whole repo can hold stale sibling policies).
 */
const POLICY_DIGEST_SCRIPT = `find /app /workspace -maxdepth 7 -path '*/.berth/capability-policy.json' -not -path '*/node_modules/*' 2>/dev/null | while read -r f; do
  h=$(sha256sum "$f" | cut -d' ' -f1)
  a=$(sed -n 's/^ *"appName": *"\\(.*\\)",\\{0,1\\}$/\\1/p' "$f" | head -1)
  printf '%s %s %s\\n' "$h" "\${a:-unknown}" "$f"
done`;

async function execCapture(docker: Docker, container: Docker.Container, cmd: string[]): Promise<string> {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  const chunks: Buffer[] = [];
  stdout.on("data", (c: Buffer) => chunks.push(c));
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Reads one running container's boot facts. Throws when the container is not
 * running or never logged a boot id — an attestation over a boot we cannot
 * identify would be a record about nothing.
 */
export async function gatherBootEvidence(docker: Docker, containerName: string, imageTag: string): Promise<BootEvidence> {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  if (!info.State?.Running) {
    throw new Error(`container "${containerName}" is not running — attest reads live boot evidence, not history`);
  }
  const runtime = info.HostConfig?.Runtime && info.HostConfig.Runtime !== "" ? info.HostConfig.Runtime : undefined;

  // Prefer the registry digest when the daemon knows one; the image config
  // ID (Image) is still a content identity for locally built images.
  let imageDigest = info.Image ?? "unknown";
  try {
    const image = (await docker.getImage(info.Image).inspect()) as { RepoDigests?: string[]; Id?: string };
    if (image.RepoDigests && image.RepoDigests.length > 0) imageDigest = image.RepoDigests[0]!;
    else if (image.Id) imageDigest = image.Id;
  } catch {
    // The container's image config ID is enough.
  }

  const logBuffer = (await container.logs({ stdout: true, stderr: true, follow: false, tail: 10000 })) as unknown as Buffer;
  const logs = demuxLogBuffer(Buffer.from(logBuffer));
  const bootId = parseBootId(logs);
  if (!bootId) {
    throw new Error(`container "${containerName}" never logged a boot id — is this a Berth sandbox?`);
  }

  const rulesetReports = parseRulesetReports(logs, bootId);
  const resourceLimits = parseResourceLimits(logs, bootId);
  const reportedApps = new Set(rulesetReports.map((r) => r.app));
  const seen = new Set<string>();
  const policies = parsePolicyLines(await execCapture(docker, container, ["sh", "-c", POLICY_DIGEST_SCRIPT])).filter((p) => {
    if (reportedApps.size > 0 && !reportedApps.has(p.app)) return false;
    if (seen.has(p.app)) return false;
    seen.add(p.app);
    return true;
  });

  // The same measurement `berth dev`'s banner is driven by, for the same
  // runtime this boot actually used (M1.4: under gVisor the kernel being
  // probed is the sentry).
  // fresh: true — never read the on-disk enforcement cache here. That file is
  // operator-writable, and doctorProbe is one of the two measurements
  // deriveEnforcementStatus() needs to return ACTIVE, so a cached read would
  // make one edit to one JSON file enough to forge half an ACTIVE verdict with
  // no kernel probed. See enforcementStatusForBoot()'s note.
  const doctorProbe: DoctorProbeResult = await enforcementStatusForBoot(docker, imageTag, runtime, { fresh: true });

  return {
    bootId,
    containerName,
    imageTag,
    imageDigest,
    ...(runtime ? { runtime } : {}),
    rulesetReports,
    policies,
    doctorProbe,
    resourceLimits,
  };
}
