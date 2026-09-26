import { Command, Flags } from "@oclif/core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { defaultAuditPath, readAuditFile, verifyAuditSegments } from "@berthos/audit";

/**
 * Rotated segments oldest-first, so the chain can be walked in the order it
 * was written: `<path>.N` … `<path>.1`, then `<path>` itself.
 */
function segmentsFor(path: string, maxFiles = 50): string[] {
  const rotated: string[] = [];
  for (let i = maxFiles; i >= 1; i--) {
    const candidate = `${path}.${i}`;
    if (existsSync(candidate)) rotated.push(candidate);
  }
  return [...rotated, path];
}

export default class AuditVerify extends Command {
  static override description =
    "Check the audit trail's hash chain for tampering, across rotated segments";
  static override examples = ["<%= config.bin %> audit verify", "<%= config.bin %> audit verify --file ./audit.jsonl"];
  static override flags = {
    file: Flags.string({ description: "audit file to verify (defaults to ~/.berth/audit/audit.jsonl)" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuditVerify);
    const path = flags.file ?? defaultAuditPath(homedir());

    if (!existsSync(path)) this.error(`no audit file at ${path}`);

    const result = verifyAuditSegments(
      segmentsFor(path).map((segment) => ({ segment, records: readAuditFile(segment) })),
    );

    for (const { segment, records } of result.perSegment) {
      if (result.failure?.segment === segment) {
        this.log(`${segment}: BROKEN at record ${result.failure.brokenAt} — ${result.failure.reason}`);
        break;
      }
      this.log(`${segment}: ${records} records OK`);
    }

    if (!result.failure && result.truncatedStart) {
      // Reported, never swallowed: retention pruning and someone deleting the
      // early segments to hide something look identical from the files alone.
      this.log(
        `Note: the oldest segment held does not start at genesis — its first record names predecessor ${result.startedFrom.slice(0, 16)}…, which is not on disk. Expected once rotation has pruned earlier segments; also what deleting them would look like. Everything from that record forward is verified.`,
      );
    }

    if (result.failure) {
      // Named plainly, because the chain is tamper-evident and not
      // tamper-proof: anyone able to write the file could have rewritten
      // every hash after the line they changed, and a clean result past
      // this point would mean nothing.
      this.error(
        `audit chain verification failed — records at and after ${result.failure.segment}:${result.failure.brokenAt} cannot be trusted`,
      );
    }

    this.log(
      `Chain intact across ${result.totalRecords} records${result.truncatedStart ? " held" : ""}. Head: ${result.head.slice(0, 16)}…`,
    );
    this.log("Note: this proves no partial edit, not that nothing was rewritten wholesale by someone who could write the file.");
  }
}
