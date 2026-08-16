import { Command, Flags } from "@oclif/core";
import { homedir } from "node:os";
import { defaultAuditPath, readAuditFile, type AuditRecord } from "@berth/audit";

export default class AuditList extends Command {
  static override description =
    "Show audit records — governance verdicts, grant decisions, and agent steps, oldest first";
  static override examples = [
    "<%= config.bin %> audit list",
    "<%= config.bin %> audit list --decision denied",
    "<%= config.bin %> audit list --actor alice --limit 50",
    "<%= config.bin %> audit list --json",
  ];
  static override flags = {
    file: Flags.string({ description: "audit file to read (defaults to ~/.berth/audit/audit.jsonl)" }),
    decision: Flags.string({ description: "only records with this decision", options: ["allowed", "denied", "unavailable"] }),
    actor: Flags.string({ description: "only records attributed to this actor id" }),
    action: Flags.string({ description: "only records whose action starts with this, e.g. `grant` or `agent.tool-call`" }),
    limit: Flags.integer({ description: "show at most this many, taking the most recent" }),
    json: Flags.boolean({ description: "emit the raw records, one JSON object per line" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuditList);
    const path = flags.file ?? defaultAuditPath(homedir());

    let records = readAuditFile(path);
    if (records.length === 0) {
      this.log(`No audit records in ${path}.`);
      return;
    }

    if (flags.decision) records = records.filter((r) => r.decision === flags.decision);
    if (flags.actor) records = records.filter((r) => r.actor.id === flags.actor);
    if (flags.action) records = records.filter((r) => r.action.startsWith(flags.action!));
    // From the end: the recent records are the ones someone is looking for.
    if (flags.limit) records = records.slice(-flags.limit);

    if (records.length === 0) {
      this.log("No records matched those filters.");
      return;
    }

    if (flags.json) {
      for (const record of records) this.log(JSON.stringify(record));
      return;
    }

    for (const record of records) this.log(formatRecord(record));
  }
}

function formatRecord(record: AuditRecord): string {
  // The actor's verification is shown inline and never omitted: "alice" and
  // "alice, unverified" are different facts, and a reader skimming for who
  // approved something must not have to go and check which one this is.
  const actor = `${record.actor.id} (${record.actor.kind}, ${record.actor.verifiedBy})`;
  const parts = [record.ts, record.decision.toUpperCase().padEnd(11), actor, record.action];
  if (record.target) parts.push(record.target);
  if (record.reason) parts.push(`— ${record.reason}`);
  return parts.join("  ");
}
