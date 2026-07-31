import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
    `);
  }

  close(): void {
    this.#db.close();
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
