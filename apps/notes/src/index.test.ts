import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

// An agent framework runs a turn's tool calls in parallel. Every add_note that
// returns an id must still be there afterwards; before updates were serialised,
// most of these were lost.
test("concurrent add_note calls keep every note", async () => {
  await withTempWorkspace(async () => {
    const addNote = app._exports.get("add_note")!;
    const listNotes = app._exports.get("list_notes")!;

    const results = (await Promise.all(
      Array.from({ length: 25 }, (_, i) => addNote.handler({ text: `note ${i}` })),
    )) as { id: string }[];
    const { notes } = (await listNotes.handler(undefined)) as { notes: { id: string }[] };

    assert.equal(notes.length, 25);
    assert.deepEqual(new Set(notes.map((n) => n.id)), new Set(results.map((r) => r.id)));
  });
});

test("complete_note running alongside add_note loses neither", async () => {
  await withTempWorkspace(async () => {
    const addNote = app._exports.get("add_note")!;
    const completeNote = app._exports.get("complete_note")!;
    const listNotes = app._exports.get("list_notes")!;

    const { id } = (await addNote.handler({ text: "first" })) as { id: string };
    await Promise.all([completeNote.handler({ id }), addNote.handler({ text: "second" })]);
    const { notes } = (await listNotes.handler(undefined)) as { notes: { id: string; completed: boolean }[] };

    assert.equal(notes.length, 2);
    assert.equal(notes.find((n) => n.id === id)?.completed, true);
  });
});

// A notes.json that doesn't parse used to read as an empty list, so the next
// add_note overwrote every existing note. Now the call fails and the file is
// left for someone to look at.
test("add_note refuses to overwrite a notes.json it cannot parse", async () => {
  await withTempWorkspace(async () => {
    const addNote = app._exports.get("add_note")!;
    const path = join(process.env.BERTH_WORKSPACE_ROOT!, "notes.json");
    await writeFile(path, '[{"id":"a","text":"kept","completed":false}', "utf-8");

    await assert.rejects(async () => addNote.handler({ text: "new" }), SyntaxError);
    assert.equal(await readFile(path, "utf-8"), '[{"id":"a","text":"kept","completed":false}');

    // and one failed call doesn't jam the queue for the next
    await writeFile(path, "[]", "utf-8");
    await addNote.handler({ text: "after" });
    assert.equal(JSON.parse(await readFile(path, "utf-8")).length, 1);
  });
});
