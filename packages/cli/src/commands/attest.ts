import { Args, Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  CHAIN_GENESIS,
  defaultAuditPath,
  finalizeAttestation,
  readAuditFile,
  verifyAttestation,
  verifyAuditChain,
  type AuditRecord,
} from "@berth/audit";
import { gatherBootEvidence, listOsNames, readOsState } from "@berth/docker-orchestrator";

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
  ];

  static override args = {
    runId: Args.string({ required: true, description: "the agent run to attest (must appear as meta.runId in the audit trail)" }),
  };

  static override flags = {
    os: Flags.string({ description: "which `berth os up` instance the run happened in (defaults to the only recorded one)" }),
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

    const segments = segmentsFor(auditPath);
    let head = CHAIN_GENESIS;
    let totalRecords = 0;
    const runRecords: AuditRecord[] = [];
    for (const segment of segments) {
      const records = readAuditFile(segment);
      const result = verifyAuditChain(records, head);
      if (!result.valid) {
        this.error(
          `audit chain broken at ${segment}:${result.brokenAt} (${result.reason}) — refusing to attest against a chain that fails its own verification`,
        );
      }
      head = result.endHash;
      totalRecords += records.length;
      for (const record of records) {
        if ((record.meta as { runId?: unknown } | undefined)?.runId === args.runId) runRecords.push(record);
      }
    }
    if (runRecords.length === 0) {
      this.error(`no audit records with meta.runId === "${args.runId}" in ${auditPath} — nothing to attest`);
    }

    // --- the boot the run happened in ---------------------------------------
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

    const docker = new Docker();
    const evidence = await gatherBootEvidence(docker, containerName, imageTag).catch((err: Error) => this.error(err.message));

    // --- bind and stamp ------------------------------------------------------
    const first = runRecords[0]!;
    const last = runRecords[runRecords.length - 1]!;
    const record = finalizeAttestation({
      runId: args.runId,
      run: { records: runRecords.length, firstSeq: first.seq, lastSeq: last.seq, firstTs: first.ts, lastTs: last.ts },
      auditChain: { path: auditPath, segments: segments.filter((s) => existsSync(s)).length, totalRecords, head },
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
    if (!check.valid) this.error(`emitted record fails self-verification: ${check.problems.join("; ")}`);

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

  private async onlyOsName(): Promise<string> {
    const names = await listOsNames();
    if (names.length === 1) return names[0]!;
    if (names.length === 0) this.error("no `berth os` instances recorded — pass --container to name the sandbox directly");
    this.error(`multiple \`berth os\` instances recorded (${names.join(", ")}) — pass --os to pick one`);
  }
}
