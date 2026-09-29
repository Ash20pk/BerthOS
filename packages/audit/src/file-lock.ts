import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
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
 * The lock names its holder: `<pid> <hostname> <token>`. A holder that dies
 * leaves the file behind, and it is broken as stale:
 *
 * - on this host, only once its pid is gone. A live holder is never broken
 *   however long it takes (stopped, swapping, stuck on a slow disk): breaking
 *   it would let two writers in at once, which is the fork this lock exists
 *   to prevent;
 * - from another host (a shared home directory), where its pid can't be
 *   checked, once it is older than `staleMs`;
 * - when it can't be parsed (a holder that died between creating the file and
 *   writing its name), once it is older than `staleMs`.
 *
 * Breaking is serialized by a second O_EXCL lock, `<path>.break`: only its
 * holder may look at the main lock again, confirm it is still the stale file
 * it judged (same inode and contents) and unlink it. Without that, two
 * breakers of the same stale lock could each remove a file, the second one
 * removing the fresh lock the first had just taken, and both would hold the
 * lock. A `.break` is itself broken only once its holder's pid is gone (or by
 * age, from another host or when malformed): it is held for microseconds.
 *
 * Known gap: a pid reused, since its holder died, by an unrelated process
 * keeps the lock looking live, and writers time out waiting (reported by the
 * sink, not thrown) until that process exits or the lock is removed by hand.
 */

export interface FileLockOptions {
  /** How long to wait for the lock before giving up. Default 15s. */
  waitMs?: number;
  /**
   * A lock held from another host, or one with no readable owner, older than
   * this is presumed abandoned. Default 10s. A lock held on this host is
   * broken only once its holder's pid is gone, whatever its age.
   */
  staleMs?: number;
}

const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_STALE_MS = 10_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export interface HeldLock {
  /** Whether the lock file is still this holder's (it was not broken as stale). */
  held(): boolean;
  /** Throws unless the lock is still this holder's. Called right before the write it guards. */
  assertHeld(): void;
  release(): void;
}

export function acquireFileLock(lockPath: string, options: FileLockOptions = {}): HeldLock {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + waitMs;
  const owner = ownerLine();
  let delay = 1;
  for (;;) {
    if (tryCreate(lockPath, owner)) return heldLock(lockPath, owner);
    breakIfStale(lockPath, staleMs);
    if (Date.now() >= deadline) throw new Error(`timed out after ${waitMs}ms waiting for the lock ${lockPath}`);
    sleepSync(delay);
    delay = Math.min(delay * 2, 25);
  }
}

/**
 * One attempt, without waiting: the lock, or undefined while a live holder
 * has it. A stale lock is broken first, on the same terms as acquireFileLock.
 * For a claim held for as long as some long piece of work takes, where the
 * caller has something better to do than wait.
 */
export function tryAcquireFileLock(lockPath: string, options: Pick<FileLockOptions, "staleMs"> = {}): HeldLock | undefined {
  const owner = ownerLine();
  if (tryCreate(lockPath, owner)) return heldLock(lockPath, owner);
  breakIfStale(lockPath, options.staleMs ?? DEFAULT_STALE_MS);
  return tryCreate(lockPath, owner) ? heldLock(lockPath, owner) : undefined;
}

function heldLock(lockPath: string, owner: string): HeldLock {
  const held = () => readOrUndefined(lockPath) === owner;
  return {
    held,
    assertHeld() {
      if (!held()) throw new Error(`lost the lock ${lockPath}: it was broken as stale while held`);
    },
    release() {
      // Only ever remove our own lock: if it was broken as stale while we
      // held it, the file there now is someone else's.
      removeIfOwned(lockPath, owner);
    },
  };
}

function ownerLine(): string {
  return `${process.pid} ${hostname()} ${randomBytes(6).toString("hex")}\n`;
}

/** Creates `path` holding `owner`, or returns false if it already exists. */
function tryCreate(path: string, owner: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, owner);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function removeIfOwned(path: string, owner: string): void {
  try {
    if (readFileSync(path, "utf-8") === owner) unlinkSync(path);
  } catch {
    // Already gone.
  }
}

interface Observed {
  content: string;
  ino: number;
  ageMs: number;
}

/** A lock file's contents and inode, read from one open so they belong together. */
function observe(path: string): Observed | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined; // Released in the meantime.
  }
  try {
    const stat = fstatSync(fd);
    return { content: readFileSync(fd, "utf-8"), ino: stat.ino, ageMs: Date.now() - stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function breakIfStale(lockPath: string, staleMs: number): void {
  const seen = observe(lockPath);
  if (!seen || !isStale(seen, staleMs)) return;

  const breakPath = `${lockPath}.break`;
  const breaker = ownerLine();
  if (!tryCreate(breakPath, breaker)) {
    // Someone else is breaking it. If they died doing so, clear their claim
    // so the next attempt can go ahead; never take it over in place.
    const claim = observe(breakPath);
    if (claim && isStale(claim, staleMs) && statSync(breakPath, { throwIfNoEntry: false })?.ino === claim.ino) {
      try {
        unlinkSync(breakPath);
      } catch {
        // Already gone.
      }
    }
    return;
  }
  try {
    // The only process allowed to remove the main lock right now. It is still
    // the stale file we judged only if nothing replaced it since: a new lock
    // (after someone else broke the old one) has a new inode and a new token.
    const now = observe(lockPath);
    if (now && now.ino === seen.ino && now.content === seen.content) unlinkSync(lockPath);
  } finally {
    removeIfOwned(breakPath, breaker);
  }
}

function isStale(lock: Observed, staleMs: number): boolean {
  const [pidText, host, token] = lock.content.trimEnd().split(" ");
  const pid = Number(pidText);
  // An empty or half-written file is a holder between its create and its
  // write, or one that died there: only its age can tell.
  if (!Number.isInteger(pid) || pid <= 0 || !host || !token) return lock.ageMs > staleMs;
  // A pid on another host can't be checked from here.
  if (host !== hostname()) return lock.ageMs > staleMs;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM: alive, owned by another user.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
