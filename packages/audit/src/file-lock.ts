import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * A cross-process lock on a file, taken synchronously: `<path>` is created
 * with O_EXCL, and whoever creates it holds the lock until they unlink it.
 *
 * Why this exists: several processes append to the same audit file (two
 * `berth mcp` sessions, `berth mcp` next to `berth os up`), and each one used
 * to read the chain's head once at startup and then keep it in memory. The
 * second writer's records then named a predecessor the first writer had
 * already moved past, the chain forked, and every verification of the file
 * failed from that line on. Holding this lock around "read the head, append,
 * rotate" makes the writers take turns on one chain.
 *
 * Synchronous on purpose, like the sink it serves: the critical section is a
 * stat, a tail read and one append, so the wait is milliseconds, and an async
 * lock would let a crash land between the head read and the write.
 *
 * A holder that dies leaves the file behind. It is treated as stale, and
 * broken, when the pid it names is gone on this host, or when it is older
 * than `staleMs` (a holder never keeps it for more than one append).
 */

export interface FileLockOptions {
  /** How long to wait for the lock before giving up. Default 15s. */
  waitMs?: number;
  /** A lock older than this is presumed abandoned. Default 10s. */
  staleMs?: number;
}

const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_STALE_MS = 10_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export interface HeldLock {
  release(): void;
}

export function acquireFileLock(lockPath: string, options: FileLockOptions = {}): HeldLock {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + waitMs;
  const owner = `${process.pid} ${hostname()} ${randomBytes(6).toString("hex")}\n`;
  let delay = 1;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      return {
        release() {
          // Only ever remove our own lock: if it was broken as stale while we
          // held it, the file there now is someone else's.
          try {
            if (readFileSync(lockPath, "utf-8") === owner) unlinkSync(lockPath);
          } catch {
            // Already gone.
          }
        },
      };
    }
    breakIfStale(lockPath, staleMs);
    if (Date.now() >= deadline) throw new Error(`timed out after ${waitMs}ms waiting for the lock ${lockPath}`);
    sleepSync(delay);
    delay = Math.min(delay * 2, 25);
  }
}

function breakIfStale(lockPath: string, staleMs: number): void {
  let content: string;
  let ageMs: number;
  try {
    content = readFileSync(lockPath, "utf-8");
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return; // Released between our open and this read: just retry.
  }
  if (!isStale(content, ageMs, staleMs)) return;

  // Moved aside rather than unlinked, so that two processes breaking the same
  // stale lock can't have the slower one delete the faster one's fresh lock:
  // only one rename of a given file succeeds, and the content check below
  // catches the case where the file had already been replaced.
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return;
  }
  try {
    if (readFileSync(aside, "utf-8") !== content) {
      // Not the lock we judged stale — put it back (fails harmlessly if a
      // new one has appeared in the meantime).
      try {
        linkSync(aside, lockPath);
      } catch {
        // A newer lock is already in place.
      }
    }
  } finally {
    try {
      unlinkSync(aside);
    } catch {
      // Already gone.
    }
  }
}

function isStale(content: string, ageMs: number, staleMs: number): boolean {
  if (ageMs > staleMs) return true;
  const [pidText, host] = content.split(" ");
  const pid = Number(pidText);
  // An empty file is a holder between its create and its write: young, so live.
  // A pid reused since the holder died looks alive here; the age check above
  // catches that case, a few seconds later.
  if (!Number.isInteger(pid) || pid <= 0 || host !== hostname()) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
