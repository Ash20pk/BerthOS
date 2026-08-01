import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFleet } from "./fleet.js";

test("resolveFleet defaults to count 1 for the bare e2b/daytona names", async () => {
  const e2b = await resolveFleet("e2b");
  assert.equal(e2b.adapter.name, "e2b");
  assert.equal(e2b.count, 1);

  const daytona = await resolveFleet("daytona");
  assert.equal(daytona.adapter.name, "daytona");
  assert.equal(daytona.count, 1);
});

test("resolveFleet reads count from a ~/.berthrc alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ prod: { adapter: "e2b", count: 5 } }));
    const resolved = await resolveFleet("prod", configPath);
    assert.equal(resolved.adapter.name, "e2b");
    assert.equal(resolved.count, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFleet defaults an alias with no count to 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ staging: { adapter: "daytona" } }));
    const resolved = await resolveFleet("staging", configPath);
    assert.equal(resolved.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFleet throws a clear error for an unknown alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ prod: { adapter: "e2b" } }));
    await assert.rejects(() => resolveFleet("nonexistent", configPath), /unknown fleet "nonexistent"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFleet passes through env from the alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ prod: { adapter: "e2b", env: { FOO: "bar" } } }));
    const resolved = await resolveFleet("prod", configPath);
    assert.deepEqual(resolved.env, { FOO: "bar" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
