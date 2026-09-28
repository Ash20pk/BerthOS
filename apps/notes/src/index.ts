import { defineApp, type ContextBusClient } from "@berthos/sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Note {
  id: string;
  text: string;
  completed: boolean;
}

// Read at call time, not module load — a test overriding
// BERTH_WORKSPACE_ROOT after import would otherwise be ignored, since the
// container itself always sets this env var before the module is loaded.
function workspaceRoot(): string {
  return process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
}

function notesPath(): string {
  return join(workspaceRoot(), "notes.json");
}

function lockPath(): string {
  return `${notesPath()}.lock`;
}

// Only a missing file means "no notes yet". A file that fails to parse is
// thrown, not treated as empty: the next write would otherwise replace every
// existing note with just the new one.
async function readNotes(): Promise<Note[]> {
  let raw: string;
  try {
    raw = await readFile(notesPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return JSON.parse(raw) as Note[];
}

// Written to a temp file and renamed into place, so a reader never sees a
// half-written notes.json. The temp file is fsynced before the rename: without
// that, a power loss can leave the rename on disk but not the data, i.e. an
// empty notes.json, and readNotes() refuses to parse that rather than guess.
// The directory is synced too so the rename itself is durable; that part is
// best-effort, since not every filesystem lets a directory be fsynced.
async function writeNotes(notes: Note[]): Promise<void> {
  await mkdir(workspaceRoot(), { recursive: true });
  const tmp = `${notesPath()}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, "wx");
    try {
      await file.writeFile(JSON.stringify(notes, null, 2), "utf-8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, notesPath());
  } catch (err) {
    // Don't leave a stray temp file behind for every failed write.
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDir(dirname(notesPath()));
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // best-effort: some platforms/filesystems reject fsync on a directory
  }
}

// A lock older than this is taken to be left behind by a process that died
// while holding it. An update holds the lock for one read and one small
// write, so a live holder is never anywhere near this old.
const STALE_LOCK_MS = 10_000;
// How long to wait for another process's update before failing the call.
const LOCK_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Cross-process lock on notes.json: a lock file created with O_EXCL beside it.
// Under `berth dev` several containers can share one workspace directory
// (packages/cli/src/util/workspace.ts), so an in-process queue alone doesn't
// keep two instances of this app from interleaving their read-modify-write.
// O_EXCL is atomic on a local filesystem and on the bind mount the containers
// share. A lock whose mtime is older than STALE_LOCK_MS is broken, so a crash
// mid-update can't wedge every later call; it's re-checked just before the
// unlink so a lock another process has only just re-taken is left alone.
async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(workspaceRoot(), { recursive: true });
  const path = lockPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf-8").finally(() => handle.close());
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
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

// Agents call tools in parallel (LangChain runs a turn's tool calls
// concurrently), and add_note/complete_note are read-modify-write. Without
// ordering, two overlapping calls both read the same list and the second write
// drops the first call's note, though both were acknowledged. Updates from
// this process are queued on a promise chain, and each one also takes the
// lock file above so updates from other processes sharing the workspace are
// put in line too.
let updates: Promise<unknown> = Promise.resolve();
function updateNotes<T>(fn: (notes: Note[]) => Promise<T> | T): Promise<T> {
  const result = updates.then(() => withFileLock(async () => fn(await readNotes())));
  updates = result.catch(() => {});
  return result;
}

export default defineApp((app) => {
  // Captured at onAgentReady and read inside export handlers — export
  // handlers only receive `input`, not the AppContext, so publishing from
  // one requires closing over the context bus reference like this.
  let contextBus: ContextBusClient | undefined;

  app.export({
    name: "add_note",
    input: z.object({ text: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async ({ text }) => {
      const note: Note = { id: randomUUID(), text, completed: false };
      await updateNotes(async (notes) => {
        notes.push(note);
        await writeNotes(notes);
      });
      await contextBus?.publish("notes.added", { id: note.id, text: note.text });
      return { id: note.id };
    },
  });

  app.export({
    name: "list_notes",
    output: z.object({ notes: z.array(z.any()) }),
    handler: async () => ({ notes: await readNotes() }),
  });

  app.export({
    name: "complete_note",
    input: z.object({ id: z.string() }),
    output: z.object({ completed: z.boolean() }),
    handler: async ({ id }) => {
      const found = await updateNotes(async (notes) => {
        const note = notes.find((n) => n.id === id);
        // Idempotent rather than a thrown error on an unknown id — an agent
        // retrying a completed/already-gone note shouldn't get a hard failure.
        if (!note) return false;
        note.completed = true;
        await writeNotes(notes);
        return true;
      });
      if (!found) return { completed: false };
      await contextBus?.publish("notes.completed", { id });
      return { completed: true };
    },
  });

  app.onAgentReady(async (ctx) => {
    contextBus = ctx.contextBus;
    await ctx.contextBus.register({ app: "notes" });
  });
});
