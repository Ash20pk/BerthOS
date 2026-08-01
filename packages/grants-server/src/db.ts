import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type GrantStatus = "pending" | "approved" | "denied";

export interface GrantRecord {
  id: string;
  appName: string;
  capability: string;
  status: GrantStatus;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

interface GrantRow {
  id: string;
  app_name: string;
  capability: string;
  status: string;
  reason: string | null;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function rowToRecord(row: GrantRow): GrantRecord {
  return {
    id: row.id,
    appName: row.app_name,
    capability: row.capability,
    status: row.status as GrantStatus,
    reason: row.reason,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export class GrantsDb {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS grants (
        id           TEXT PRIMARY KEY,
        app_name     TEXT NOT NULL,
        capability   TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        reason       TEXT,
        requested_at TEXT NOT NULL,
        decided_at   TEXT,
        decided_by   TEXT
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  create(appName: string, capability: string, reason: string | undefined, now: () => string): GrantRecord {
    const record: GrantRecord = {
      id: randomUUID(),
      appName,
      capability,
      status: "pending",
      reason: reason ?? null,
      requestedAt: now(),
      decidedAt: null,
      decidedBy: null,
    };
    this.#db
      .prepare(
        `INSERT INTO grants (id, app_name, capability, status, reason, requested_at, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.appName, record.capability, record.status, record.reason, record.requestedAt, null, null);
    return record;
  }

  get(id: string): GrantRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM grants WHERE id = ?`).get(id) as GrantRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Lists grants, most recently requested first, optionally filtered by status and/or app. */
  list(filter: { status?: GrantStatus; appName?: string } = {}): GrantRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.appName) {
      clauses.push("app_name = ?");
      params.push(filter.appName);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM grants ${where} ORDER BY requested_at DESC`)
      .all(...params) as unknown as GrantRow[];
    return rows.map(rowToRecord);
  }

  /** Approved capability strings for one app — what generate-capability-policy.ts merges in on the app's next boot. */
  getApprovedCapabilities(appName: string): string[] {
    return this.list({ status: "approved", appName }).map((g) => g.capability);
  }

  /**
   * Returns undefined if the id doesn't exist; throws if it exists but isn't
   * still pending. `reason` (e.g. a denial explanation) overwrites the
   * request's original reason, if given.
   */
  decide(
    id: string,
    status: "approved" | "denied",
    decidedBy: string,
    now: () => string,
    reason?: string,
  ): GrantRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.status !== "pending") {
      throw new Error(`grant ${id} was already ${existing.status} (by ${existing.decidedBy ?? "unknown"})`);
    }
    const decidedAt = now();
    const finalReason = reason ?? existing.reason;
    this.#db
      .prepare(`UPDATE grants SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ?`)
      .run(status, decidedAt, decidedBy, finalReason, id);
    return { ...existing, status, decidedAt, decidedBy, reason: finalReason };
  }
}
