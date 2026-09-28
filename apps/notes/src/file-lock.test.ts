import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock.js";

// A lock nobody can name the owner of would stall every later call for the
// full stale timeout; one whose owner couldn't be written is removed at once.
test("a lock whose owner can't be written is removed, not left to stall the next call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-lock-"));
  const path = join(dir, "notes.json.lock");
  const probe = await open(join(dir, "probe"), "w");
  const FileHandle = Object.getPrototypeOf(probe) as { writeFile: (...args: unknown[]) => Promise<void> };
  await probe.close();
  const writeFileOriginal = FileHandle.writeFile;
  // The only write a lock around a no-op makes is its owner record.
  FileHandle.writeFile = async () => {
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  };
  try {
    await assert.rejects(withFileLock(path, async () => {}), { code: "ENOSPC" });
  } finally {
    FileHandle.writeFile = writeFileOriginal;
  }
  assert.deepEqual(await readdir(dir), ["probe"]);

  const started = Date.now();
  assert.equal(await withFileLock(path, async () => "next"), "next");
  assert.ok(Date.now() - started < 1_000, `the next call waited ${Date.now() - started} ms`);
});
