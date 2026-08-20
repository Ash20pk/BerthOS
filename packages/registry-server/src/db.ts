import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface AppRecord {
  name: string;
  version: string;
  description: string;
  author: string;
  capabilities: string[];
  exports: string[];
  manifest: Record<string, unknown>;
  bundlePath: string;
  bundleSize: number;
  publishedAt: string;
}

interface AppRow {
  name: string;
  version: string;
  description: string;
  author: string;
  capabilities: string;
  exports: string;
  manifest: string;
  bundle_path: string;
  bundle_size: number;
  published_at: string;
}

function rowToRecord(row: AppRow): AppRecord {
  return {
    name: row.name,
    version: row.version,
    description: row.description,
    author: row.author,
    capabilities: JSON.parse(row.capabilities),
    exports: JSON.parse(row.exports),
    manifest: JSON.parse(row.manifest),
    bundlePath: row.bundle_path,
    bundleSize: row.bundle_size,
    publishedAt: row.published_at,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("hex");
}

/** Compares two validated "x.y.z" semver strings; positive if `a` is newer. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export class RegistryDb {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    // WAL keeps a reader (CLI status queries) from blocking the server's
    // writes, and busy_timeout makes a second opener wait 5s instead of
    // throwing SQLITE_BUSY the moment two processes touch the same file.
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        capabilities TEXT NOT NULL DEFAULT '[]',
        exports TEXT NOT NULL DEFAULT '[]',
        manifest TEXT NOT NULL,
        bundle_path TEXT NOT NULL,
        bundle_size INTEGER NOT NULL,
        published_at TEXT NOT NULL,
        PRIMARY KEY (name, version)
      );
      -- Namespace ownership, npm/PyPI-style: whoever publishes the FIRST
      -- version of a name controls every later version of it. Separate from
      -- the apps table (one row per name, not per name+version) so a name's
      -- owner token survives that name's versions being published/
      -- downloaded, and so this table's shape doesn't need to change if the
      -- apps table's ever does.
      CREATE TABLE IF NOT EXISTS app_owners (
        name TEXT PRIMARY KEY,
        owner_token_hash TEXT NOT NULL,
        registered_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  ownerExists(name: string): boolean {
    return this.#db.prepare(`SELECT 1 FROM app_owners WHERE name = ?`).get(name) !== undefined;
  }

  /** Unknown name or missing token both fail closed. */
  verifyOwnerToken(name: string, token: string | undefined): boolean {
    if (!token) return false;
    const row = this.#db.prepare(`SELECT owner_token_hash FROM app_owners WHERE name = ?`).get(name) as
      | { owner_token_hash: string }
      | undefined;
    if (!row) return false;
    return hashesMatch(hashToken(token), row.owner_token_hash);
  }

  /**
   * Claims a brand-new name for the first time, minting and returning its
   * owner token (once — never stored in plaintext, never returned again).
   * Caller (routes.ts) must already have checked `!ownerExists(name)`; this
   * throws instead of silently overwriting if that check was skipped and the
   * name was claimed since, e.g. by a concurrent request.
   */
  registerOwner(name: string, now: string): string {
    const token = generateOwnerToken();
    try {
      this.#db
        .prepare(`INSERT INTO app_owners (name, owner_token_hash, registered_at) VALUES (?, ?, ?)`)
        .run(name, hashToken(token), now);
    } catch (err) {
      throw new Error(`"${name}" was just claimed by another publish — try again: ${err instanceof Error ? err.message : String(err)}`);
    }
    return token;
  }

  /** Throws if this exact name+version was already published — versions are immutable, same as npm. */
  insert(record: AppRecord): void {
    const existing = this.#db
      .prepare(`SELECT 1 FROM apps WHERE name = ? AND version = ?`)
      .get(record.name, record.version);
    if (existing) {
      throw new Error(`${record.name}@${record.version} is already published — versions are immutable`);
    }
    this.#db
      .prepare(
        `INSERT INTO apps (name, version, description, author, capabilities, exports, manifest, bundle_path, bundle_size, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.name,
        record.version,
        record.description,
        record.author,
        JSON.stringify(record.capabilities),
        JSON.stringify(record.exports),
        JSON.stringify(record.manifest),
        record.bundlePath,
        record.bundleSize,
        record.publishedAt,
      );
  }

  listVersions(name: string): AppRecord[] {
    const rows = this.#db.prepare(`SELECT * FROM apps WHERE name = ?`).all(name) as unknown as AppRow[];
    return rows.map(rowToRecord).sort((a, b) => compareSemver(b.version, a.version));
  }

  get(name: string, version: string): AppRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM apps WHERE name = ? AND version = ?`).get(name, version) as
      | AppRow
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getLatest(name: string): AppRecord | undefined {
    const versions = this.listVersions(name);
    return versions[0];
  }

  /** One row per app name, its highest published version — the listing surface for `berth init`/discovery. */
  listLatestPerApp(query?: string): AppRecord[] {
    const rows = this.#db.prepare(`SELECT * FROM apps`).all() as unknown as AppRow[];
    const byName = new Map<string, AppRecord>();
    for (const row of rows.map(rowToRecord)) {
      const current = byName.get(row.name);
      if (!current || compareSemver(row.version, current.version) > 0) {
        byName.set(row.name, row);
      }
    }
    let results = [...byName.values()];
    if (query) {
      const q = query.toLowerCase();
      results = results.filter(
        (r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
      );
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }
}
