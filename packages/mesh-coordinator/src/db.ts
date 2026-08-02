import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { matchesAny } from "./glob.js";

export interface PeerRecord {
  name: string;
  publicKey: string;
  meshIp: string;
  endpointHost: string;
  endpointPort: number;
  meshPeerPatterns: string[];
  registeredAt: string;
  lastSeen: string;
}

/** What one peer is allowed to learn about another — never the owner token. */
export interface PeerView {
  name: string;
  meshIp: string;
  publicKey: string;
  endpointHost: string;
  endpointPort: number;
}

interface PeerRow {
  name: string;
  public_key: string;
  mesh_ip: string;
  endpoint_host: string;
  endpoint_port: number;
  mesh_peer_patterns: string;
  owner_token_hash: string;
  registered_at: string;
  last_seen: string;
}

function rowToRecord(row: PeerRow): PeerRecord {
  return {
    name: row.name,
    publicKey: row.public_key,
    meshIp: row.mesh_ip,
    endpointHost: row.endpoint_host,
    endpointPort: row.endpoint_port,
    meshPeerPatterns: JSON.parse(row.mesh_peer_patterns),
    registeredAt: row.registered_at,
    lastSeen: row.last_seen,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time-ish comparison of two hex digests of equal, fixed length. */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("hex");
}

// 100.64.0.0/10, Tailscale/CGNAT-style — guaranteed non-overlapping with both
// RFC1918 ranges (what Docker bridges/most VPCs already use) and public
// internet space, so a mesh IP is unambiguous no matter what network the
// underlying container happens to be on. .1 is reserved (never allocated)
// for a possible future coordinator-side relay presence — see
// docs/mesh-reference.md's deferred section.
const MESH_BASE_OCTETS: [number, number] = [100, 64];

function ipFromSequence(seq: number): string {
  // seq=0 -> 100.64.0.2 (., 1 reserved); wraps into the third/fourth octets
  // as it grows — plenty of room (100.64.0.0/10 is ~4M addresses) for any
  // realistic single coordinator instance.
  const value = seq + 2;
  const d = value % 256;
  const c = Math.floor(value / 256) % 256;
  const b = Math.floor(value / 65536);
  return `${MESH_BASE_OCTETS[0]}.${MESH_BASE_OCTETS[1] + b}.${c}.${d}`;
}

export class MeshCoordinatorDb {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        name TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        mesh_ip TEXT NOT NULL UNIQUE,
        endpoint_host TEXT NOT NULL,
        endpoint_port INTEGER NOT NULL,
        mesh_peer_patterns TEXT NOT NULL DEFAULT '[]',
        owner_token_hash TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  #get(name: string): PeerRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM peers WHERE name = ?`).get(name) as PeerRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Raw hash lookup — only used internally by verifyToken, never exposed. */
  #tokenHash(name: string): string | undefined {
    const row = this.#db.prepare(`SELECT owner_token_hash FROM peers WHERE name = ?`).get(name) as
      | { owner_token_hash: string }
      | undefined;
    return row?.owner_token_hash;
  }

  /** True if `token` is the owner token for `name`. Unknown name always fails closed. */
  verifyToken(name: string, token: string | undefined): boolean {
    const stored = this.#tokenHash(name);
    if (!stored || !token) return false;
    return hashesMatch(hashToken(token), stored);
  }

  exists(name: string): boolean {
    return this.#get(name) !== undefined;
  }

  #nextMeshIp(): string {
    const row = this.#db.prepare(`SELECT COUNT(*) as n FROM peers`).get() as { n: number };
    return ipFromSequence(row.n);
  }

  /**
   * Upsert-by-name. First registration of a name needs no token and mints a
   * new one (returned once, never again — the caller must persist it).
   * Re-registration of an existing name MUST present that same token (via
   * verifyToken, checked by the caller before calling this) — enforced by
   * the caller, not here, so this method assumes the auth decision is
   * already made and just does the write.
   */
  upsert(input: {
    name: string;
    publicKey: string;
    endpointHost: string;
    endpointPort: number;
    meshPeerPatterns: string[];
    now: string;
  }): { record: PeerRecord; ownerToken?: string } {
    const existing = this.#get(input.name);
    if (existing) {
      this.#db
        .prepare(
          `UPDATE peers SET public_key = ?, endpoint_host = ?, endpoint_port = ?, mesh_peer_patterns = ?, last_seen = ? WHERE name = ?`,
        )
        .run(
          input.publicKey,
          input.endpointHost,
          input.endpointPort,
          JSON.stringify(input.meshPeerPatterns),
          input.now,
          input.name,
        );
      return { record: this.#get(input.name)! };
    }

    const ownerToken = generateOwnerToken();
    const meshIp = this.#nextMeshIp();
    this.#db
      .prepare(
        `INSERT INTO peers (name, public_key, mesh_ip, endpoint_host, endpoint_port, mesh_peer_patterns, owner_token_hash, registered_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.publicKey,
        meshIp,
        input.endpointHost,
        input.endpointPort,
        JSON.stringify(input.meshPeerPatterns),
        hashToken(ownerToken),
        input.now,
        input.now,
      );
    return { record: this.#get(input.name)!, ownerToken };
  }

  remove(name: string): void {
    this.#db.prepare(`DELETE FROM peers WHERE name = ?`).run(name);
  }

  /**
   * The real authorization step: `name` only learns about another peer if
   * BOTH declared a network:peer:<pattern> matching the other's name (or
   * "*"). Decided here, at the trust anchor for key exchange, since Landlock
   * has no UDP access right to restrict wg0 traffic with directly — see
   * docs/mesh-reference.md.
   */
  mutualPeersFor(name: string): PeerView[] {
    const self = this.#get(name);
    if (!self) return [];
    const rows = this.#db.prepare(`SELECT * FROM peers WHERE name != ?`).all(name) as unknown as PeerRow[];
    return rows
      .map(rowToRecord)
      .filter((other) => matchesAny(self.meshPeerPatterns, other.name) && matchesAny(other.meshPeerPatterns, name))
      .map((p) => ({
        name: p.name,
        meshIp: p.meshIp,
        publicKey: p.publicKey,
        endpointHost: p.endpointHost,
        endpointPort: p.endpointPort,
      }));
  }
}
