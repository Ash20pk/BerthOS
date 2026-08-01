import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInstanceId } from "./resolve-instance.js";

async function withFleetState(instances: Array<{ id: string; appName: string; startedAt: string }>) {
  const fleetsDir = await mkdtemp(join(tmpdir(), "berth-resolve-instance-test-"));
  await mkdir(fleetsDir, { recursive: true });
  await writeFile(join(fleetsDir, "prod.json"), JSON.stringify({ fleet: "prod", instances }));
  return fleetsDir;
}

test("resolveInstanceId returns an explicit --instance id without consulting fleet state", async () => {
  const id = await resolveInstanceId("prod", "myapp", "explicit-id", "/nonexistent-dir");
  assert.equal(id, "explicit-id");
});

test("resolveInstanceId finds the single recorded instance for an app", async (t) => {
  const fleetsDir = await withFleetState([{ id: "inst-1", appName: "myapp", startedAt: "2026-01-01T00:00:00Z" }]);
  t.after(() => rm(fleetsDir, { recursive: true, force: true }));

  const id = await resolveInstanceId("prod", "myapp", undefined, fleetsDir);
  assert.equal(id, "inst-1");
});

test("resolveInstanceId picks the most recently started match when there are several", async (t) => {
  const fleetsDir = await withFleetState([
    { id: "inst-1", appName: "myapp", startedAt: "2026-01-01T00:00:00Z" },
    { id: "inst-2", appName: "myapp", startedAt: "2026-01-02T00:00:00Z" },
  ]);
  t.after(() => rm(fleetsDir, { recursive: true, force: true }));

  const id = await resolveInstanceId("prod", "myapp", undefined, fleetsDir);
  assert.equal(id, "inst-2");
});

test("resolveInstanceId throws a clear error when nothing matches", async (t) => {
  const fleetsDir = await withFleetState([{ id: "inst-1", appName: "other-app", startedAt: "2026-01-01T00:00:00Z" }]);
  t.after(() => rm(fleetsDir, { recursive: true, force: true }));

  await assert.rejects(
    () => resolveInstanceId("prod", "myapp", undefined, fleetsDir),
    /no recorded instance for "myapp" on fleet "prod"/,
  );
});
