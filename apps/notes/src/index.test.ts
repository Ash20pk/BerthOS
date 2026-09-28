import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
    // every write renamed its temp file into place; none are left lying around
    assert.deepEqual(await readdir(process.env.BERTH_WORKSPACE_ROOT!), ["notes.json"]);
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

// Under `berth dev` several containers share one workspace, so the in-process
// queue isn't enough on its own. Separate processes each firing parallel
// add_note calls at the same notes.json must still keep every note.
test("add_note calls from separate processes keep every note", async () => {
  await withTempWorkspace(async () => {
    const dir = process.env.BERTH_WORKSPACE_ROOT!;
    const moduleUrl = new URL("./index.js", import.meta.url).href;
    const script = `
      const app = (await import(${JSON.stringify(moduleUrl)})).default;
      const add = app._exports.get("add_note");
      const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => add.handler({ text: "p" + i })));
      console.log(JSON.stringify(ids.map((r) => r.id)));
    `;
    const run = promisify(execFile);
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, BERTH_WORKSPACE_ROOT: dir },
          cwd: fileURLToPath(new URL(".", import.meta.url)),
        }),
      ),
    );
    const acknowledged = outputs.flatMap((o) => JSON.parse(o.stdout) as string[]);
    const onDisk = JSON.parse(await readFile(join(dir, "notes.json"), "utf-8")) as { id: string }[];

    assert.equal(acknowledged.length, 40);
    assert.deepEqual(new Set(onDisk.map((n) => n.id)), new Set(acknowledged));
    assert.deepEqual(await readdir(dir), ["notes.json"]);
  });
});

test("add_note waits for a lock another process holds", async () => {
  await withTempWorkspace(async () => {
    const addNote = app._exports.get("add_note")!;
    const lock = join(process.env.BERTH_WORKSPACE_ROOT!, "notes.json.lock");
    await writeFile(lock, "99999\n", "utf-8");

    let done = false;
    const pending = Promise.resolve(addNote.handler({ text: "waited" })).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(done, false);

    await unlink(lock);
    await pending;
    const onDisk = JSON.parse(await readFile(join(process.env.BERTH_WORKSPACE_ROOT!, "notes.json"), "utf-8"));
    assert.equal(onDisk.length, 1);
  });
});

// A process that dies mid-update leaves its lock file behind; that mustn't
// wedge every later call.
test("add_note breaks a stale lock left by a dead process", async () => {
  await withTempWorkspace(async () => {
    const addNote = app._exports.get("add_note")!;
    const lock = join(process.env.BERTH_WORKSPACE_ROOT!, "notes.json.lock");
    await writeFile(lock, "99999\n", "utf-8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    await addNote.handler({ text: "after crash" });
    assert.deepEqual(await readdir(process.env.BERTH_WORKSPACE_ROOT!), ["notes.json"]);
  });
});
