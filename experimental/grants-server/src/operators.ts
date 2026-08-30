import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An operator registry maps a bearer token to a *name*, so an approval can be
 * attributed to whoever presented the credential rather than to whatever
 * string they typed into the request body.
 *
 * REMEDIATION.md 5.1: `decided_by` was free text. `berth grants approve --by`
 * defaulted to the local OS username and the server wrote it down verbatim,
 * which means the audit trail recorded a preference, not a fact — anyone
 * holding the one shared token could approve anything and sign it with any
 * name, including someone else's.
 *
 * Tokens are stored as sha256 hashes. The server never needs the plaintext
 * again after minting: it hashes what the caller presents and looks that up.
 * A stolen `operators.json` therefore does not let the thief approve
 * anything, which was not true of the plaintext `operator.token` it replaces.
 *
 * This is not identity in the 5.2 sense — there is still no user directory,
 * no revocation beyond editing the file, and possession of a token is all it
 * proves. It is the difference between "someone holding alice's token did
 * this" and "someone typed alice".
 */
export interface OperatorEntry {
  name: string;
  tokenHash: string;
  createdAt: string;
}

export interface OperatorRegistry {
  /** The operator name for a presented token, or undefined if no entry matches. */
  resolve(token: string | undefined): string | undefined;
  /** Names known to this registry, for diagnostics. Never returns hashes. */
  names(): string[];
}

const OPERATORS_FILE = "operators.json";
const LEGACY_TOKEN_FILE = "operator.token";
/** The name a token minted before named operators existed is attributed to. */
export const LEGACY_OPERATOR_NAME = "operator";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function operatorsPath(dataDir: string): string {
  return join(dataDir, OPERATORS_FILE);
}

function readEntries(dataDir: string): OperatorEntry[] {
  const path = operatorsPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as OperatorEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Refuse rather than silently fall back to an empty registry: an
    // unreadable operators file must not turn into "no operator can approve",
    // which reads identically to a wrong token and would send someone
    // hunting the wrong bug.
    throw new Error(`could not parse ${path} (${err}) — fix or remove it; approve/deny cannot authenticate without it`);
  }
}

function writeEntries(dataDir: string, entries: OperatorEntry[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(operatorsPath(dataDir), `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
}

function makeRegistry(entries: OperatorEntry[]): OperatorRegistry {
  return {
    resolve(token) {
      if (!token) return undefined;
      // Hashing first gives every comparison the same fixed length, so the
      // timing-safe compare below is actually usable — timingSafeEqual throws
      // on a length mismatch, which would otherwise leak token length.
      const presented = Buffer.from(hashToken(token), "hex");
      let match: string | undefined;
      for (const entry of entries) {
        const candidate = Buffer.from(entry.tokenHash, "hex");
        // No early return: comparing against every entry keeps the work done
        // independent of which operator matched, and of whether any did.
        if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) {
          match = entry.name;
        }
      }
      return match;
    },
    names() {
      return entries.map((e) => e.name);
    },
  };
}

/**
 * Mints a token for a named operator and appends it to the registry. Returns
 * the plaintext — the only time it exists, since only the hash is stored.
 */
export function addOperator(dataDir: string, name: string): string {
  if (!name.trim()) throw new Error("an operator name is required");
  const entries = readEntries(dataDir);
  if (entries.some((e) => e.name === name)) {
    throw new Error(`an operator named "${name}" already exists — remove it from ${operatorsPath(dataDir)} first`);
  }
  const token = randomBytes(32).toString("hex");
  entries.push({ name, tokenHash: hashToken(token), createdAt: new Date().toISOString() });
  writeEntries(dataDir, entries);
  return token;
}

export interface LoadedRegistry {
  registry: OperatorRegistry;
  /**
   * Set only when this call minted a first token, so the server can print it
   * once. Never populated for an existing registry — the plaintext is gone.
   */
  mintedToken?: string;
}

/**
 * Loads the registry, creating a single `operator` entry on first use so a
 * fresh install still has a working approve/deny path.
 *
 * A pre-existing plaintext `operator.token` is adopted rather than
 * invalidated: an operator who already has that token keeps using it, and
 * their decisions are attributed to "operator" — accurate, since a shared
 * token genuinely cannot say more than that. The legacy file is left where it
 * is; deleting a credential out from under a running deployment is not this
 * function's call to make.
 */
export function loadOperatorRegistry(dataDir: string): LoadedRegistry {
  mkdirSync(dataDir, { recursive: true });
  const existing = readEntries(dataDir);
  if (existing.length > 0) return { registry: makeRegistry(existing) };

  const legacyPath = join(dataDir, LEGACY_TOKEN_FILE);
  if (existsSync(legacyPath)) {
    const legacyToken = readFileSync(legacyPath, "utf-8").trim();
    const entries: OperatorEntry[] = [
      { name: LEGACY_OPERATOR_NAME, tokenHash: hashToken(legacyToken), createdAt: new Date().toISOString() },
    ];
    writeEntries(dataDir, entries);
    return { registry: makeRegistry(entries) };
  }

  const token = randomBytes(32).toString("hex");
  const entries: OperatorEntry[] = [
    { name: LEGACY_OPERATOR_NAME, tokenHash: hashToken(token), createdAt: new Date().toISOString() },
  ];
  writeEntries(dataDir, entries);
  // Still written for the server's "here's your token" first-run message and
  // for anything already reading this path.
  writeFileSync(legacyPath, token, { mode: 0o600 });
  return { registry: makeRegistry(entries), mintedToken: token };
}

/**
 * A registry holding one unnamed token, for a caller that supplies its own
 * secret (`BERTH_GRANTS_OPERATOR_TOKEN`, tests) instead of using the file.
 */
export function singleTokenRegistry(token: string, name = LEGACY_OPERATOR_NAME): OperatorRegistry {
  return makeRegistry([{ name, tokenHash: hashToken(token), createdAt: new Date().toISOString() }]);
}
