import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrCreateOperatorToken } from "./operator-token.js";

test("mints a token on first call, persists it, and returns the same one on later calls", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-grants-operator-token-test-"));
  try {
    const first = readOrCreateOperatorToken(dataDir);
    assert.ok(first.length > 0);

    const persisted = await readFile(join(dataDir, "operator.token"), "utf-8");
    assert.equal(persisted.trim(), first);

    const second = readOrCreateOperatorToken(dataDir);
    assert.equal(second, first);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("two different data dirs get two different tokens", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "berth-grants-operator-token-test-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "berth-grants-operator-token-test-b-"));
  try {
    assert.notEqual(readOrCreateOperatorToken(dirA), readOrCreateOperatorToken(dirB));
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});
