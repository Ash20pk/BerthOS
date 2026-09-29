import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { hostname } from "node:os";

// A lock from another host (another container sharing the workspace under
// `berth dev`: each has its own hostname and pid namespace) whose mtime is
// older than this is taken to be left behind by a process that died holding
// it. An update holds the lock for one read and one small write, so a live
// holder is never anywhere near this old.
const STALE_LOCK_MS = 10_000;
// How long to wait for another process's update before failing the call.
const LOCK_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Owner {
  pid: number;
  host: string;
  token: string;
}

interface Observed {
  ino: number;
  mtimeMs: number;
  content: string;
}

/** Creates `path` with O_EXCL and records who holds it; undefined if it already exists. */
async function tryCreate(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw err;
  }
  const content = `${JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() } satisfies Owner)}\n`;
  try {
    await handle.writeFile(content, "utf-8");
  } catch (err) {
    // A lock nobody can tell the owner of (a full disk, say) would stall
    // every later call until it aged out; this one is ours, so it goes now.
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw err;
  }
  await handle.close();
  return content;
}

// Through one handle, so the inode and the content are of the same file even
// if the path is replaced in between.
async function observe(path: string): Promise<Observed | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    return { ino: info.ino, mtimeMs: info.mtimeMs, content: await handle.readFile("utf-8") };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// On this host a lock is stale exactly when its holder is dead. A lock from
// another host (or one whose owner can't be read) can only be judged by age.
function isStale(lock: Observed): boolean {
  let owner: Partial<Owner> | undefined;
  try {
    owner = JSON.parse(lock.content) as Partial<Owner>;
  } catch {
    owner = undefined;
  }
  if (owner?.host === hostname() && typeof owner.pid === "number") return !isAlive(owner.pid);
  return Date.now() - lock.mtimeMs > STALE_LOCK_MS;
}

const same = (a: Observed | undefined, b: Observed): boolean => a !== undefined && a.ino === b.ino && a.content === b.content;

/**
 * Breaks the stale lock at `path` that was observed as `stale`, if it's still
 * that same lock. Breakers are serialized by a second O_EXCL lock,
 * `<path>.break`: only its holder may unlink the main lock, and only after
 * re-reading it and finding the same inode and content it judged stale. That
 * way two processes that both saw the stale lock can't both unlink "it",
 * the second removing a fresh lock a third process has just taken.
 *
 * Returns false when another breaker holds `<path>.break`, so the caller
 * waits its turn rather than spinning.
 */
async function breakStale(path: string, stale: Observed): Promise<boolean> {
  const breakPath = `${path}.break`;
  const mine = await tryCreate(breakPath);
  if (mine === undefined) {
    // Another breaker is at it; its hold lasts a couple of syscalls. One
    // that died holding it is cleared the same way a main lock is.
    const breaker = await observe(breakPath);
    if (breaker && isStale(breaker) && same(await observe(breakPath), breaker)) await unlink(breakPath).catch(() => {});
    return false;
  }
  try {
    const now = await observe(path);
    if (now && same(now, stale) && isStale(now)) await unlink(path).catch(() => {});
  } finally {
    await releaseIfMine(breakPath, mine);
  }
  return true;
}

// A holder whose lock was broken from another host (it outlived
// STALE_LOCK_MS) mustn't then remove the lock someone else took after it.
async function releaseIfMine(path: string, content: string): Promise<void> {
  const now = await observe(path);
  if (now?.content === content) await unlink(path).catch(() => {});
}

/**
 * Cross-process lock: a lock file at `path`, created with O_EXCL, which is
 * atomic on a local filesystem and on the bind mount containers share. It
 * records the holder's pid, hostname and a unique token. A stale lock (see
 * isStale()) is broken, so a crash mid-update can't wedge every later call.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  let content: string | undefined;
  for (;;) {
    content = await tryCreate(path);
    if (content !== undefined) break;
    const held = await observe(path);
    if (held && isStale(held) && (await breakStale(path, held))) continue;
    if (Date.now() > deadline) {
      throw new Error(`notes: timed out waiting for ${path}; another process is updating the notes`);
    }
    await sleep(delay + Math.random() * delay);
    delay = Math.min(delay * 2, 100);
  }
  try {
    return await fn();
  } finally {
    await releaseIfMine(path, content);
  }
}
