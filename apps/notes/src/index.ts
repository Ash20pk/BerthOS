import { defineApp, type ContextBusClient } from "@berthos/sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
// half-written notes.json.
async function writeNotes(notes: Note[]): Promise<void> {
  await mkdir(workspaceRoot(), { recursive: true });
  const tmp = `${notesPath()}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(notes, null, 2), "utf-8");
  await rename(tmp, notesPath());
}

// Agents call tools in parallel (LangChain runs a turn's tool calls
// concurrently), and add_note/complete_note are read-modify-write. Without
// this, two overlapping calls both read the same list and the second write
// drops the first call's note, though both were acknowledged. The app is one
// process, so a promise chain is enough to put the updates in line.
let updates: Promise<unknown> = Promise.resolve();
function updateNotes<T>(fn: (notes: Note[]) => Promise<T> | T): Promise<T> {
  const result = updates.then(async () => fn(await readNotes()));
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
