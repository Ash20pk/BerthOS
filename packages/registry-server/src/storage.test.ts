import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, BundleExistsError } from "./storage.js";

test("a stored version can't be overwritten, even by a racing second write", async () => {
  const blobs = new BlobStore(await mkdtemp(join(tmpdir(), "berth-blobs-")));
  const path = await blobs.write("app", "1.0.0", Buffer.from("first"));

  await assert.rejects(() => blobs.write("app", "1.0.0", Buffer.from("second")), BundleExistsError);
  assert.equal(await readFile(path, "utf-8"), "first");
});

test("remove() clears a bundle so the version can be published again", async () => {
  const blobs = new BlobStore(await mkdtemp(join(tmpdir(), "berth-blobs-")));
  const path = await blobs.write("app", "1.0.0", Buffer.from("orphan"));
  await blobs.remove(path);
  assert.equal(existsSync(path), false);
  await blobs.write("app", "1.0.0", Buffer.from("retry"));
  assert.equal(await readFile(path, "utf-8"), "retry");
});
