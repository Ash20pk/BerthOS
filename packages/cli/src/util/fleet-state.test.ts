import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFleetState, appendFleetInstances } from "./fleet-state.js";

test("readFleetState returns an empty record for a fleet with no history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-state-test-"));
  try {
    const state = await readFleetState("prod", dir);
    assert.deepEqual(state, { fleet: "prod", instances: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendFleetInstances persists across separate calls and accumulates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-state-test-"));
  try {
    await appendFleetInstances("prod", [{ id: "inst-1", appName: "github-assistant", startedAt: "2026-01-01T00:00:00.000Z" }], dir);
    await appendFleetInstances("prod", [{ id: "inst-2", appName: "github-assistant", startedAt: "2026-01-01T00:01:00.000Z" }], dir);

    const state = await readFleetState("prod", dir);
    assert.equal(state.instances.length, 2);
    assert.deepEqual(
      state.instances.map((i) => i.id),
      ["inst-1", "inst-2"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state for one fleet alias is isolated from another", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-state-test-"));
  try {
    await appendFleetInstances("prod", [{ id: "inst-1", appName: "app-a", startedAt: "2026-01-01T00:00:00.000Z" }], dir);
    await appendFleetInstances("staging", [{ id: "inst-2", appName: "app-a", startedAt: "2026-01-01T00:00:00.000Z" }], dir);

    const prod = await readFleetState("prod", dir);
    const staging = await readFleetState("staging", dir);
    assert.deepEqual(
      prod.instances.map((i) => i.id),
      ["inst-1"],
    );
    assert.deepEqual(
      staging.instances.map((i) => i.id),
      ["inst-2"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
