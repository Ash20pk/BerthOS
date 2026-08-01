import { defineApp, type ContextBusClient } from "@berth/sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function readNotes(): Promise<Note[]> {
  try {
    return JSON.parse(await readFile(notesPath(), "utf-8")) as Note[];
  } catch {
    return [];
  }
}

async function writeNotes(notes: Note[]): Promise<void> {
  await mkdir(workspaceRoot(), { recursive: true });
  await writeFile(notesPath(), JSON.stringify(notes, null, 2), "utf-8");
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
      const notes = await readNotes();
      notes.push(note);
      await writeNotes(notes);
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
      const notes = await readNotes();
      const note = notes.find((n) => n.id === id);
      // Idempotent rather than a thrown error on an unknown id — an agent
      // retrying a completed/already-gone note shouldn't get a hard failure.
      if (!note) return { completed: false };
      note.completed = true;
      await writeNotes(notes);
      await contextBus?.publish("notes.completed", { id: note.id });
      return { completed: true };
    },
  });

  app.onAgentReady(async (ctx) => {
    contextBus = ctx.contextBus;
    await ctx.contextBus.register({ app: "notes" });
  });
});
