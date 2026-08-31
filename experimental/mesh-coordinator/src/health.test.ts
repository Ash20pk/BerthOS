import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMeshCoordinatorServer } from "./index.js";

test("GET /health answers ok without auth", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-mesh-health-"));
  const app = await createMeshCoordinatorServer({ dataDir });
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("mesh-coordinator.sqlite opens in WAL mode", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "berth-mesh-wal-"));
  const app = await createMeshCoordinatorServer({ dataDir });
  try {
    const db = new DatabaseSync(join(dataDir, "mesh-coordinator.sqlite"));
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    db.close();
    assert.equal(mode.journal_mode, "wal");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
