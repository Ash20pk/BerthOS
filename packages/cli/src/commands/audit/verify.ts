import { Command, Flags } from "@oclif/core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { CHAIN_GENESIS, defaultAuditPath, readAuditFile, verifyAuditChain } from "@berth/audit";

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

    let expected = CHAIN_GENESIS;
    let total = 0;

    for (const segment of segmentsFor(path)) {
      const records = readAuditFile(segment);
      total += records.length;
      const result = verifyAuditChain(records, expected);
      if (!result.valid) {
        this.log(`${segment}: BROKEN at record ${result.brokenAt} — ${result.reason}`);
        // Named plainly, because the chain is tamper-evident and not
        // tamper-proof: anyone able to write the file could have rewritten
        // every hash after the line they changed, and a clean result past
        // this point would mean nothing.
        this.error(`audit chain verification failed — records at and after ${segment}:${result.brokenAt} cannot be trusted`);
      }
      expected = result.endHash;
      this.log(`${segment}: ${records.length} records OK`);
    }

    this.log(`Chain intact across ${total} records. Head: ${expected.slice(0, 16)}…`);
    this.log("Note: this proves no partial edit, not that nothing was rewritten wholesale by someone who could write the file.");
  }
}
