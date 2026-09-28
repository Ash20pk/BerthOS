import { Args, Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  defaultAuditPath,
  finalizeAttestation,
  readAuditFile,
  verifyAttestation,
  verifyAuditSegments,
  type AuditRecord,
} from "@berthos/audit";
import { gatherBootEvidence, listOsNames, readOsState, type BootEvidence } from "@berthos/docker-orchestrator";
import { recordedBootEvidence } from "../util/run-audit.js";

/** Rotated segments oldest-first — same walk as `berth audit verify`. */
function segmentsFor(path: string, maxFiles = 50): string[] {
  const rotated: string[] = [];
  for (let i = maxFiles; i >= 1; i--) {
    const candidate = `${path}.${i}`;
    if (existsSync(candidate)) rotated.push(candidate);
  }
  return [...rotated, path];
}

export default class Attest extends Command {
  static override description =
    "Emit a per-run attestation record: the run's audit-chain evidence, enforcement status as measured for its boot, the enforced capability-policy hashes, boot id, and image digest. " +
    "Tamper-evident, not tamper-proof — the record says so itself. Verify with scripts/verify-attestation.mjs (no Berth install needed).";

  static override examples = [
    "<%= config.bin %> attest run-2026-08-23-001",
    "<%= config.bin %> attest run-1 --os demo --out run-1.attestation.json",
    "<%= config.bin %> attest mcp-filesystem-20260928T101500Z-3fa2c1 --out session.attestation.json",
  ];

  static override args = {
    runId: Args.string({
      required: true,
      description: "the run to attest: a `berth mcp` session's run id (printed when it starts), or an agent run's id. Must appear as meta.runId in the audit trail.",
    }),
  };

  static override flags = {
    os: Flags.string({
      description:
        "which `berth os up` instance the run happened in, read live. Not needed for a run that recorded its own boot evidence (`berth mcp` does); defaults to the only recorded instance otherwise.",
    }),
    container: Flags.string({ description: "container name to read boot evidence from (overrides --os lookup)" }),
    image: Flags.string({ description: "image tag for the enforcement probe (defaults to the instance's recorded image)" }),
    file: Flags.string({ description: "audit file to cite (defaults to ~/.berth/audit/audit.jsonl)" }),
    out: Flags.string({ description: "write the record to this path instead of stdout" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Attest);

    // --- the run's slice of the audit chain --------------------------------
    const auditPath = flags.file ?? defaultAuditPath(homedir());
    if (!existsSync(auditPath)) this.error(`no audit file at ${auditPath} — a run that left no audit trail cannot be attested`);

    const chain = verifyAuditSegments(
      segmentsFor(auditPath).map((segment) => ({ segment, records: readAuditFile(segment) })),
    );
    if (!chain.valid && chain.failure) {
      this.error(
        `audit chain broken at ${chain.failure.segment}:${chain.failure.brokenAt} (${chain.failure.reason}) — refusing to attest against a chain that fails its own verification`,
      );
    }
    if (chain.truncatedStart) {
      // Not a refusal: on any install that has rotated past its retention
      // window this is the normal state, and refusing here is what made
      // `berth attest` unusable on a long-lived install. But it is also
      // indistinguishable from someone deleting the early segments, so it is
      // said out loud on stderr rather than passed over. The record itself
      // cannot yet carry this — see docs/audit-reference.md (rotation) and
      // docs/attestation-reference.md.
      this.warn(
        `the audit chain's oldest held record names predecessor ${chain.startedFrom.slice(0, 16)}…, which is not on disk — earlier segments were pruned by rotation (or removed). The ${chain.totalRecords} records held verify cleanly from that point; the attestation covers only those.`,
      );
    }
    const head = chain.head;
    const totalRecords = chain.totalRecords;
    const runRecords: AuditRecord[] = [];
    for (const { segment } of chain.perSegment) {
      for (const record of readAuditFile(segment)) {
        if ((record.meta as { runId?: unknown } | undefined)?.runId === args.runId) runRecords.push(record);
      }
    }
    if (runRecords.length === 0) {
      this.error(
        `no audit records with meta.runId === "${args.runId}" in ${auditPath} — nothing to attest. \`berth mcp\` prints its session's run id on stderr when it starts; pass --file if it wrote somewhere else.`,
      );
    }

    // --- the boot the run happened in ---------------------------------------
    const evidence = await this.bootEvidence(runRecords, flags);

    // --- bind and stamp ------------------------------------------------------
    const first = runRecords[0]!;
    const last = runRecords[runRecords.length - 1]!;
    const record = finalizeAttestation({
      runId: args.runId,
      run: { records: runRecords.length, firstSeq: first.seq, lastSeq: last.seq, firstTs: first.ts, lastTs: last.ts },
      auditChain: { path: auditPath, segments: chain.perSegment.length, totalRecords, head },
      boot: {
        bootId: evidence.bootId,
        containerName: evidence.containerName,
        imageTag: evidence.imageTag,
        imageDigest: evidence.imageDigest,
        ...(evidence.runtime ? { runtime: evidence.runtime } : {}),
      },
      enforcement: { rulesetReports: evidence.rulesetReports, doctorProbe: evidence.doctorProbe },
      policies: evidence.policies,
    });

    // Refuse to emit a record the shipped verifier would reject — a broken
    // emitter should fail here, not in a stranger's terminal.
    const check = verifyAttestation(record);
    if (!check.valid) this.error(`emitted record fails self-verification: ${check.problems.map((p) => `${p.code}: ${p.message}`).join("; ")}`);

    const json = `${JSON.stringify(record, null, 2)}\n`;
    if (flags.out) {
      writeFileSync(flags.out, json, { mode: 0o600 });
      this.log(`wrote ${flags.out} (enforcement: ${record.enforcement.status})`);
    } else {
      this.log(json);
    }
    if (record.enforcement.status !== "ACTIVE") {
      this.warn(`this run's boot attests ${record.enforcement.status}: ${record.enforcement.reasons.join("; ")}`);
    }
  }

  /**
   * A container named on the command line is read live. Otherwise a run that
   * recorded its own boot evidence (`berth mcp` writes a sandbox.boot record
   * while the sandbox is up, since it stops the sandbox when the session
   * ends) is attested against that, and anything else against the one
   * `berth os up` instance, live.
   */
  private async bootEvidence(runRecords: AuditRecord[], flags: { os?: string; container?: string; image?: string }): Promise<BootEvidence> {
    if (!flags.os && !flags.container) {
      const recorded = recordedBootEvidence(runRecords);
      if (recorded) {
        this.logToStderr(`using the boot evidence recorded with this run (boot ${recorded.bootId}, container ${recorded.containerName}); pass --os or --container to read a running sandbox instead`);
        return recorded;
      }
    }

    let containerName = flags.container;
    let imageTag = flags.image;
    if (!containerName) {
      const osName = flags.os ?? (await this.onlyOsName());
      const state = await readOsState(osName);
      if (!state) this.error(`no \`berth os\` record named "${osName}" — pass --container to name the sandbox directly`);
      containerName = state.containerName;
      imageTag ??= state.image;
    }
    if (!imageTag) this.error("no image tag known for the enforcement probe — pass --image alongside --container");

    return gatherBootEvidence(new Docker(), containerName, imageTag).catch((err: Error) => this.error(err.message));
  }

  private async onlyOsName(): Promise<string> {
    const names = await listOsNames();
    if (names.length === 1) return names[0]!;
    if (names.length === 0) this.error("no `berth os` instances recorded — pass --container to name the sandbox directly");
    this.error(`multiple \`berth os\` instances recorded (${names.join(", ")}) — pass --os to pick one`);
  }
}
