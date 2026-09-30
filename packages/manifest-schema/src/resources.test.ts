import { test } from "node:test";
import assert from "node:assert/strict";
import { BerthManifestSchema } from "./schema.js";
import { appCgroupLimits, sandboxResources, DAEMON_RESERVE, DEFAULT_APP_PIDS } from "./resources.js";

test("resources accepts a positive integer pids", () => {
  assert.deepEqual(BerthManifestSchema.parse({ name: "app", version: "1.0.0", resources: { pids: 64 } }).resources, { pids: 64 });
  for (const pids of [0, -1, 1.5, "64"]) {
    assert.equal(BerthManifestSchema.safeParse({ name: "app", version: "1.0.0", resources: { pids } }).success, false, `pids: ${JSON.stringify(pids)}`);
  }
});

test("an app that declares nothing still gets an equal CPU share and a task limit", () => {
  assert.deepEqual(appCgroupLimits({}), { "cpu.weight": "100", "pids.max": String(DEFAULT_APP_PIDS) });
});

test("declared cpu, memory_mb and pids become cpu.max, memory.high/max/swap.max and pids.max", () => {
  assert.deepEqual(appCgroupLimits({ cpu: 0.5, memory_mb: 256, pids: 64 }), {
    "cpu.weight": "100",
    "cpu.max": "50000 100000",
    "memory.high": String(Math.floor(256 * 1024 * 1024 * 0.9)),
    "memory.max": String(256 * 1024 * 1024),
    "memory.swap.max": "0",
    "pids.max": "64",
  });
});

test("cpu.max rounds half up, and never below the kernel's 1ms minimum quota", () => {
  assert.equal(appCgroupLimits({ cpu: 2 })["cpu.max"], "200000 100000");
  assert.equal(appCgroupLimits({ cpu: 0.000005 })["cpu.max"], "1000 100000");
  assert.equal(appCgroupLimits({ cpu: 0.123455 })["cpu.max"], "12346 100000");
});

test("memory.high sits below memory.max", () => {
  const limits = appCgroupLimits({ memory_mb: 1 });
  assert.ok(Number(limits["memory.high"]) < Number(limits["memory.max"]));
});

test("the sandbox is the sum of its apps plus the daemon reserve, not the max", () => {
  const sandbox = sandboxResources([
    { resources: { cpu: 0.5, memory_mb: 256, pids: 64 } },
    { resources: { cpu: 2, memory_mb: 512 } },
  ]);
  assert.deepEqual(sandbox, {
    cpu: 2.5 + DAEMON_RESERVE.cpu,
    memoryMb: 768 + DAEMON_RESERVE.memoryMb,
    pids: 64 + DEFAULT_APP_PIDS + DAEMON_RESERVE.pids,
  });
});

test("a key one app leaves undeclared is not capped at the container, but pids always is", () => {
  const sandbox = sandboxResources([{ resources: { cpu: 1, memory_mb: 256 } }, { resources: {} }]);
  assert.equal(sandbox.cpu, undefined);
  assert.equal(sandbox.memoryMb, undefined);
  assert.equal(sandbox.pids, 2 * DEFAULT_APP_PIDS + DAEMON_RESERVE.pids);
  assert.deepEqual(sandboxResources([]), { pids: DAEMON_RESERVE.pids });
});

test("gpu stays the largest request: a GPU is shared by the container, not divided between apps", () => {
  assert.equal(sandboxResources([{ resources: { gpu: 1 } }, { resources: { gpu: 2 } }, { resources: {} }]).gpu, 2);
  assert.equal(sandboxResources([{ resources: {} }]).gpu, undefined);
});
