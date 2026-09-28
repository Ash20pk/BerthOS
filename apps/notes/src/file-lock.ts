import { open, stat, unlink } from "node:fs/promises";

// A lock older than this is taken to be left behind by a process that died
// while holding it. An update holds the lock for one read and one small
// write, so a live holder is never anywhere near this old.
const STALE_LOCK_MS = 10_000;
// How long to wait for another process's update before failing the call.
const LOCK_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cross-process lock: a lock file at `path`, created with O_EXCL, which is
 * atomic on a local filesystem and on the bind mount containers share. A lock
 * whose mtime is older than STALE_LOCK_MS is broken, so a crash mid-update
 * can't wedge every later call; it's re-checked just before the unlink so a
 * lock another process has only just re-taken is left alone.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  for (;;) {
    let handle;
    try {
      handle = await open(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (handle) {
      try {
        await handle.writeFile(`${process.pid}\n`, "utf-8");
      } catch (err) {
        // A lock nobody can tell the owner of (a full disk, say) would stall
        // every later call until it aged out; this one is ours, so it goes now.
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw err;
      }
      await handle.close();
      break;
    }
    const held = await stat(path).catch(() => undefined);
    if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
      const again = await stat(path).catch(() => undefined);
      if (again && again.ino === held.ino && again.mtimeMs === held.mtimeMs) {
        await unlink(path).catch(() => {});
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`notes: timed out waiting for ${path}; another process is updating the notes`);
    }
    await sleep(delay + Math.random() * delay);
    delay = Math.min(delay * 2, 100);
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}
