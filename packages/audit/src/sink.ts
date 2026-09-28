import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireFileLock, type FileLockOptions, type HeldLock } from "./file-lock.js";
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
export function canonicalize(value: unknown): string {
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
   * file is plaintext on disk (nothing is encrypted at rest yet), so tool
   * arguments and outputs are not written unless someone asks for them. When
   * on, both go through redact() first.
   */
  capturePayloads?: boolean;
  redact?: RedactOptions;
  /** Rotate once the file exceeds this. Default 16MB. */
  maxBytes?: number;
  /** How many rotated files to keep (`<path>.1` … `<path>.<n>`). Default 5. Older ones are deleted. */
  maxFiles?: number;
  /** How long a write waits for, and when it breaks, another writer's lock on `<path>.lock`. */
  lock?: FileLockOptions;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

interface ChainHead {
  hash: string;
  seq: number;
}

/**
 * The newest record's hash and next seq in one file, or undefined when it
 * holds no record. Reads backwards from the end in growing windows rather
 * than the whole file: this runs before every write, against a file allowed
 * to reach 16MB.
 *
 * A process killed mid-write leaves a line with no terminating newline.
 * Appending straight onto it would splice the next record into the tail of
 * the torn one and lose *both*, so the line is closed first: the torn
 * fragment stays on disk (it is evidence), and the next record starts clean.
 */
function readHead(path: string): ChainHead | undefined {
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  let size: number;
  let tail = "";
  try {
    size = fstatSync(fd).size;
    if (size === 0) return undefined;
    let window = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      tail = buffer.toString("utf-8");
      const lines = tail.split("\n");
      // The first line of a window that doesn't start at 0 may be cut.
      const complete = start === 0 ? lines : lines.slice(1);
      for (let i = complete.length - 1; i >= 0; i--) {
        if (!complete[i]) continue;
        try {
          const parsed = JSON.parse(complete[i]!) as AuditRecord;
          if (typeof parsed.hash === "string") {
            if (!tail.endsWith("\n")) appendFileSync(path, "\n");
            return { hash: parsed.hash, seq: (parsed.seq ?? 0) + 1 };
          }
        } catch {
          // A torn line (killed mid-write) — keep walking backwards.
        }
      }
      if (start === 0) break;
      window *= 4;
    }
  } finally {
    closeSync(fd);
  }
  if (!tail.endsWith("\n")) appendFileSync(path, "\n");
  return undefined;
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
 *
 * Several processes may write the same file (two `berth mcp` sessions share
 * ~/.berth/audit/audit.jsonl by default). Each write takes a lock on
 * `<path>.lock` and reads the chain's head from the file itself, not from
 * memory, before appending and rotating, so concurrent writers produce one
 * chain rather than two interleaved ones that fail verification.
 */
export function createFileAuditSink(options: FileAuditSinkOptions): AuditSink {
  const { path, capturePayloads = false, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES } = options;
  mkdirSync(dirname(path), { recursive: true });

  const lockPath = `${path}.lock`;
  // The head as this sink last wrote it, and the file it wrote it to. Reused
  // only while the file is still exactly as it was left: any other writer's
  // append (or rotation) changes its size or inode, and the head is re-read.
  let cached: { head: ChainHead; ino: number; size: number } | undefined;

  function currentHead(): ChainHead {
    if (cached) {
      try {
        const now = statSync(path);
        if (now.ino === cached.ino && now.size === cached.size) return cached.head;
      } catch {
        // Gone: re-read below.
      }
    }
    // An empty or missing file right after a rotation continues the chain
    // from the segment it rotated into.
    return readHead(path) ?? readHead(`${path}.1`) ?? { hash: CHAIN_GENESIS, seq: 0 };
  }

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
      let lock: HeldLock | undefined;
      try {
        lock = acquireFileLock(lockPath, options.lock);
        const head = currentHead();
        const payload: AuditEvent = { ...event, seq: head.seq };
        if (capturePayloads) {
          if (payload.input !== undefined) payload.input = redact(payload.input, options.redact);
          if (payload.output !== undefined) payload.output = redact(payload.output, options.redact);
        } else {
          delete payload.input;
          delete payload.output;
        }
        if (payload.meta !== undefined) payload.meta = redact(payload.meta, options.redact) as Record<string, unknown>;

        const hash = hashRecord(head.hash, payload);
        const record: AuditRecord = { ...payload, prevHash: head.hash, hash };
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
        const written = statSync(path);
        cached = { head: { hash, seq: head.seq + 1 }, ino: written.ino, size: written.size };
      } catch (err) {
        cached = undefined;
        // Never let auditing fail the thing being audited.
        console.error(`[berth-audit] WARNING: could not write audit record (${err})`);
      } finally {
        lock?.release();
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
      // No `[berth-audit]` prefix, deliberately: the
      // `[agent-init] {...}` prefix was the reason those lines aren't
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

export interface SegmentInput {
  /** How to name this segment in output — a path, usually. */
  segment: string;
  records: AuditRecord[];
}

export interface SegmentVerification {
  valid: boolean;
  /** The chain head after the newest verified record. */
  head: string;
  totalRecords: number;
  perSegment: { segment: string; records: number }[];
  /**
   * True when the oldest segment we hold does NOT begin at genesis, i.e. its
   * first record names a predecessor that isn't on disk any more.
   *
   * This is the normal, expected state of any install that has rotated more
   * than `maxFiles` times — retention deleted the earlier segments. It is
   * ALSO what deleting the early segments to hide something looks like, and
   * the two are indistinguishable from the files alone. So this is surfaced
   * rather than tolerated silently: callers must report it. Verification of
   * everything from that record forward is unaffected and still sound.
   */
  truncatedStart: boolean;
  /** The prevHash verification had to take on trust when `truncatedStart`. */
  startedFrom: string;
  failure?: { segment: string; brokenAt: number; reason: string };
}

/**
 * Verifies a chain across rotated segments, oldest-first.
 *
 * Why this exists rather than each caller looping over `verifyAuditChain`:
 * a caller that seeds the walk with `CHAIN_GENESIS` is correct only until
 * retention prunes the first segment, after which it reports BROKEN at
 * record 0 of the oldest *surviving* segment on every healthy install —
 * making a routine rotation indistinguishable from tampering, and (in
 * `berth attest`'s case) refusing to emit at all. This starts the walk from
 * whatever the oldest held record claims as its predecessor and reports that
 * it did so, which keeps rotation working without ever quietly accepting an
 * unverified boundary.
 */
export function verifyAuditSegments(segments: SegmentInput[]): SegmentVerification {
  const nonEmpty = segments.filter((s) => s.records.length > 0);
  const perSegment = segments.map((s) => ({ segment: s.segment, records: s.records.length }));
  const totalRecords = nonEmpty.reduce((n, s) => n + s.records.length, 0);

  if (nonEmpty.length === 0) {
    return { valid: true, head: CHAIN_GENESIS, totalRecords: 0, perSegment, truncatedStart: false, startedFrom: CHAIN_GENESIS };
  }

  const firstPrev = nonEmpty[0]!.records[0]!.prevHash;
  const truncatedStart = firstPrev !== CHAIN_GENESIS;
  let expected = firstPrev;

  for (const { segment, records } of nonEmpty) {
    const result = verifyAuditChain(records, expected);
    if (!result.valid) {
      return {
        valid: false,
        head: result.endHash,
        totalRecords,
        perSegment,
        truncatedStart,
        startedFrom: firstPrev,
        failure: { segment, brokenAt: result.brokenAt, reason: result.reason ?? "unknown" },
      };
    }
    expected = result.endHash;
  }

  return { valid: true, head: expected, totalRecords, perSegment, truncatedStart, startedFrom: firstPrev };
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
