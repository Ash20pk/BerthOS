import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { redact, type RedactOptions } from "./redact.js";
import type { AuditEvent, AuditRecord, AuditSink } from "./types.js";

/** The prevHash of the very first record ever written to a chain. */
export const CHAIN_GENESIS = "0".repeat(64);

/**
 * Stable-key JSON. The hash has to be reproducible by a reader who parsed the
 * record back out of the file, and `JSON.stringify` preserves insertion order
 * — which round-trips through parse in practice for these shapes, but only by
 * accident. Sorting makes it a property of the data instead.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

function hashRecord(prevHash: string, event: AuditEvent): string {
  return createHash("sha256").update(prevHash).update(canonicalize(event)).digest("hex");
}

export interface FileAuditSinkOptions {
  /** Path to the JSONL file. Parent directories are created. */
  path: string;
  /**
   * Record `input`/`output` on events that carry them. Off by default: the
   * file is plaintext on disk (REMEDIATION.md 5.4 is still open), so tool
   * arguments and outputs are not written unless someone asks for them. When
   * on, both go through redact() first.
   */
  capturePayloads?: boolean;
  redact?: RedactOptions;
  /** Rotate once the file exceeds this. Default 16MB. */
  maxBytes?: number;
  /** How many rotated files to keep (`<path>.1` … `<path>.<n>`). Default 5. Older ones are deleted. */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

/** Reads the last record's hash out of an existing file so a restart continues the chain instead of starting a new one. */
function resumeChain(path: string): { hash: string; seq: number } {
  if (!existsSync(path)) return { hash: CHAIN_GENESIS, seq: 0 };
  try {
    const contents = readFileSync(path, "utf-8");
    // A process killed mid-write leaves a line with no terminating newline.
    // Appending straight onto it would splice our first record into the tail
    // of the torn one and lose *both*, so close the line first: the torn
    // fragment stays on disk (it is evidence), and the next record starts
    // clean.
    if (contents.length > 0 && !contents.endsWith("\n")) {
      appendFileSync(path, "\n");
    }
    const lines = contents.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as AuditRecord;
        if (typeof parsed.hash === "string") return { hash: parsed.hash, seq: (parsed.seq ?? 0) + 1 };
      } catch {
        // A torn final line (killed mid-write) — keep walking backwards.
      }
    }
  } catch (err) {
    console.error(`[berth-audit] WARNING: could not read ${path} to resume the hash chain (${err}) — starting a new chain`);
  }
  return { hash: CHAIN_GENESIS, seq: 0 };
}

/**
 * Appends hash-chained JSONL to a 0600 file.
 *
 * Writes are synchronous. That is a deliberate cost: an audit record that is
 * still buffered when the process dies is an audit record that does not
 * exist, and the events routed here (governance denials, grant decisions) are
 * exactly the ones a crash would otherwise erase. The volume is low — a
 * denial per blocked tool call, not a line per request.
 *
 * The chain does not make the file tamper-*proof*; anyone who can write the
 * file can recompute every hash after the line they edited. It makes it
 * tamper-*evident* against anything less than a full rewrite, and it survives
 * rotation because the first record of a new file carries the last hash of
 * the old one. Use verifyAuditChain() to check one.
 */
export function createFileAuditSink(options: FileAuditSinkOptions): AuditSink {
  const { path, capturePayloads = false, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES } = options;
  mkdirSync(dirname(path), { recursive: true });

  const resumed = resumeChain(path);
  let prevHash = resumed.hash;
  let seq = resumed.seq;

  function rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return; // doesn't exist yet
    }
    if (size < maxBytes) return;

    // Oldest first, so nothing overwrites a file still being shifted.
    const oldest = `${path}.${maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
    }
    renameSync(path, `${path}.1`);
  }

  return {
    async record(event) {
      try {
        const payload: AuditEvent = { ...event, seq: seq++ };
        if (capturePayloads) {
          if (payload.input !== undefined) payload.input = redact(payload.input, options.redact);
          if (payload.output !== undefined) payload.output = redact(payload.output, options.redact);
        } else {
          delete payload.input;
          delete payload.output;
        }
        if (payload.meta !== undefined) payload.meta = redact(payload.meta, options.redact) as Record<string, unknown>;

        const hash = hashRecord(prevHash, payload);
        const record: AuditRecord = { ...payload, prevHash, hash };
        rotateIfNeeded();
        appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        // appendFileSync's `mode` only applies when it creates the file, and
        // an operator who pre-created the path (or an older build that wrote
        // it at the umask default) would otherwise keep the looser mode
        // forever.
        try {
          if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
        } catch {
          // Best effort — a mode we couldn't tighten is not worth losing the record over.
        }
        prevHash = hash;
      } catch (err) {
        // Never let auditing fail the thing being audited.
        console.error(`[berth-audit] WARNING: could not write audit record (${err})`);
      }
    },
  };
}

/** Collects records in memory. For tests, and for a caller assembling its own transport. */
export function createMemoryAuditSink(): AuditSink & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  let prevHash = CHAIN_GENESIS;
  let seq = 0;
  return {
    records,
    async record(event) {
      const payload: AuditEvent = { ...event, seq: seq++ };
      const hash = hashRecord(prevHash, payload);
      records.push({ ...payload, prevHash, hash });
      prevHash = hash;
    },
  };
}

/** Writes one JSON object per line to stderr. The fallback when no file sink is configured but denials still shouldn't vanish. */
export function createConsoleAuditSink(): AuditSink {
  let seq = 0;
  return {
    async record(event) {
      // No `[berth-audit]` prefix, deliberately: REMEDIATION.md 5.1 names the
      // `[agent-init] {...}` prefix as the reason those lines aren't
      // parseable JSON. A log collector should be able to read this stream
      // with JSON.parse and nothing else.
      console.error(JSON.stringify({ ...event, seq: seq++ }));
    },
  };
}

/** Fans one event out to several sinks. A failing sink never stops the others. */
export function combineAuditSinks(...sinks: AuditSink[]): AuditSink {
  return {
    async record(event) {
      await Promise.all(
        sinks.map((sink) =>
          sink.record(event).catch((err) => {
            console.error(`[berth-audit] WARNING: an audit sink failed (${err})`);
          }),
        ),
      );
    },
  };
}

export interface ChainVerification {
  valid: boolean;
  /** Index of the first record whose hash doesn't follow from its predecessor, or -1. */
  brokenAt: number;
  reason?: string;
  /** The last record's hash, for continuing verification into the next file after a rotation. */
  endHash: string;
}

/**
 * Recomputes the chain over records read back from a file. Pass the previous
 * file's `endHash` as `startHash` when verifying across a rotation; omit it
 * for a chain that began at genesis.
 */
export function verifyAuditChain(records: AuditRecord[], startHash: string = CHAIN_GENESIS): ChainVerification {
  let expectedPrev = startHash;
  for (let i = 0; i < records.length; i++) {
    const { prevHash, hash, ...event } = records[i]!;
    if (prevHash !== expectedPrev) {
      return { valid: false, brokenAt: i, reason: `prevHash ${prevHash} does not match the previous record's hash ${expectedPrev}`, endHash: expectedPrev };
    }
    const recomputed = hashRecord(prevHash, event as AuditEvent);
    if (recomputed !== hash) {
      return { valid: false, brokenAt: i, reason: `record contents do not match its hash (recomputed ${recomputed}, stored ${hash})`, endHash: expectedPrev };
    }
    expectedPrev = hash;
  }
  return { valid: true, brokenAt: -1, endHash: expectedPrev };
}

/** Reads a JSONL audit file back into records. Skips a torn final line rather than throwing. */
export function readAuditFile(path: string): AuditRecord[] {
  if (!existsSync(path)) return [];
  const out: AuditRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AuditRecord);
    } catch {
      // Torn write at the tail — everything before it is still verifiable.
    }
  }
  return out;
}

/** The default location for a local audit trail, alongside the rest of `~/.berth`. */
export function defaultAuditPath(home: string): string {
  return join(home, ".berth", "audit", "audit.jsonl");
}
