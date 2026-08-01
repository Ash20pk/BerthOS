import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "./index.js";

async function withTempWorkspace<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "notes-test-"));
  const previous = process.env.BERTH_WORKSPACE_ROOT;
  process.env.BERTH_WORKSPACE_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BERTH_WORKSPACE_ROOT;
    else process.env.BERTH_WORKSPACE_ROOT = previous;
  }
}

test("add_note persists a note and list_notes returns it", async () => {
  await withTempWorkspace(async () => {
    const addNote = app._exports.get("add_note")!;
    const listNotes = app._exports.get("list_notes")!;

    const { id } = (await addNote.handler({ text: "buy milk" })) as { id: string };
    const { notes } = (await listNotes.handler(undefined)) as { notes: { id: string; text: string; completed: boolean }[] };

    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0], { id, text: "buy milk", completed: false });

    const onDisk = JSON.parse(await readFile(join(process.env.BERTH_WORKSPACE_ROOT!, "notes.json"), "utf-8"));
    assert.deepEqual(onDisk, notes);
  });
});

test("complete_note marks a note completed", async () => {
  await withTempWorkspace(async () => {
    const addNote = app._exports.get("add_note")!;
    const completeNote = app._exports.get("complete_note")!;
    const listNotes = app._exports.get("list_notes")!;

    const { id } = (await addNote.handler({ text: "walk the dog" })) as { id: string };
    const result = await completeNote.handler({ id });
    assert.deepEqual(result, { completed: true });

    const { notes } = (await listNotes.handler(undefined)) as { notes: { id: string; completed: boolean }[] };
    assert.equal(notes.find((n) => n.id === id)?.completed, true);
  });
});

test("complete_note is idempotent for an unknown id", async () => {
  await withTempWorkspace(async () => {
    const completeNote = app._exports.get("complete_note")!;
    const result = await completeNote.handler({ id: "does-not-exist" });
    assert.deepEqual(result, { completed: false });
  });
});
