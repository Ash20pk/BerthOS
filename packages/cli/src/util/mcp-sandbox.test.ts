import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxNotReadyError, startBackgroundSandbox, type SandboxSteps } from "./mcp-sandbox.js";

// The Docker side stood in for: each step is a promise the test settles, and
// `log` is the order things happened in.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeSteps(options: { running?: boolean } = {}) {
  const log: string[] = [];
  const boot = deferred<string>();
  const ready = deferred();
  const connect = deferred<{ rpc: string }>();
  let bootSignal: AbortSignal | undefined;
  const steps: SandboxSteps<string, { rpc: string }> = {
    find: async () => (options.running ? "existing" : undefined),
    boot: (signal) => {
      bootSignal = signal;
      log.push("boot");
      return boot.promise;
    },
    waitReady: () => {
      log.push("waitReady");
      return ready.promise;
    },
    connect: (container, bootedHere) => {
      log.push(`connect ${container} ${bootedHere}`);
      return options.running ? Promise.resolve({ rpc: "attached" }) : connect.promise;
    },
    stopByName: async () => void log.push("stopByName"),
  };
  return { steps, log, boot, ready, connect, bootSignal: () => bootSignal };
}

const allowBoot = { allowBoot: true, noBootMessage: "no container", settleMs: 50 };

test("calls made before the sandbox is ready wait for it, then get it", async () => {
  const fake = fakeSteps();
  const sandbox = startBackgroundSandbox(fake.steps, allowBoot);
  const first = sandbox.whenReady({ waitMs: 5_000 });
  const second = sandbox.whenReady({ waitMs: 5_000 });
  await tick();
  assert.equal(sandbox.state(), "starting");
  assert.equal(sandbox.owns(), true, "owned from the decision to boot, before the boot returns");

  fake.boot.resolve("c1");
  await tick();
  fake.ready.resolve();
  await tick();
  fake.connect.resolve({ rpc: "r1" });
  assert.deepEqual(await first, { rpc: "r1", bootedHere: true });
  assert.deepEqual(await second, { rpc: "r1", bootedHere: true });
  assert.equal(sandbox.state(), "ready");
  assert.deepEqual(fake.log, ["boot", "waitReady", "connect c1 true"]);
});

test("a failed boot is reported to every call, and what it created is stopped", async () => {
  const fake = fakeSteps();
  const sandbox = startBackgroundSandbox(fake.steps, allowBoot);
  const call = sandbox.whenReady({ waitMs: 5_000 });
  fake.boot.reject(new Error("image build failed"));
  await assert.rejects(call, /image build failed/);
  await assert.rejects(sandbox.whenReady({ waitMs: 5_000 }), /image build failed/);
  assert.equal(sandbox.state(), "failed");
  // bootDevContainer can fail after the sidecar or container exists.
  assert.deepEqual(fake.log, ["boot", "stopByName"]);
});

test("a failure after the boot (attaching RPC) also stops the sandbox", async () => {
  const fake = fakeSteps();
  const sandbox = startBackgroundSandbox(fake.steps, allowBoot);
  fake.boot.resolve("c1");
  fake.ready.resolve();
  await tick();
  fake.connect.reject(new Error("attach failed"));
  await assert.rejects(sandbox.ready, /attach failed/);
  assert.deepEqual(fake.log, ["boot", "waitReady", "connect c1 true", "stopByName"]);
});

test("a name someone else already took is not stopped", async () => {
  const fake = fakeSteps();
  const sandbox = startBackgroundSandbox(fake.steps, allowBoot);
  fake.boot.reject(Object.assign(new Error("Conflict. The container name is already in use"), { statusCode: 409 }));
  await assert.rejects(sandbox.ready, /already in use/);
  assert.equal(sandbox.owns(), false);
  await sandbox.stop();
  assert.deepEqual(fake.log, ["boot"]);
});

test("stopping mid-boot stops by name at once, without waiting for the boot, and again once it settles", async () => {
  const fake = fakeSteps();
  const sandbox = startBackgroundSandbox(fake.steps, { ...allowBoot, settleMs: 10_000 });
  const call = sandbox.whenReady({ waitMs: 60_000 });
  await tick();

  const stopping = sandbox.stop();
  await tick();
  assert.equal(fake.bootSignal()?.aborted, true, "the boot is told to stop");
  assert.deepEqual(fake.log, ["boot", "stopByName"], "stopped by name while the boot is still running");

  // The image finishes building and the container appears after the first stop.
  fake.boot.resolve("c1");
  await stopping;
  await assert.rejects(call, SandboxNotReadyError);
  assert.equal(sandbox.state(), "stopped");
  assert.ok(!fake.log.includes("waitReady"), "a boot told to stop goes no further");
  assert.equal(fake.log.filter((l) => l === "stopByName").length >= 2, true);
});

test("stopping mid-boot doesn't wait longer than settleMs for a boot that never returns", async () => {
  const fake = fakeSteps();
  const sandbox = startBackgroundSandbox(fake.steps, { ...allowBoot, settleMs: 20 });
  await tick();
  const startedAt = Date.now();
  await sandbox.stop();
  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(fake.log, ["boot", "stopByName", "stopByName"]);
});

test("a sandbox that was already running is attached to, and left running", async () => {
  const fake = fakeSteps({ running: true });
  const sandbox = startBackgroundSandbox(fake.steps, allowBoot);
  assert.deepEqual(await sandbox.ready, { rpc: "attached", bootedHere: false });
  await sandbox.stop();
  assert.deepEqual(fake.log, ["connect existing false"]);
  assert.equal(sandbox.owns(), false);
});

test("--no-boot with nothing running fails without booting", async () => {
  const fake = fakeSteps();
  const sandbox = startBackgroundSandbox(fake.steps, { allowBoot: false, noBootMessage: "no running container and --no-boot" });
  await assert.rejects(sandbox.whenReady({ waitMs: 1_000 }), /--no-boot/);
  assert.deepEqual(fake.log, []);
  assert.equal(sandbox.owns(), false);
});

test("a call's wait is bounded, and ends as soon as its client cancels it", async () => {
  const fake = fakeSteps();
  const sandbox = startBackgroundSandbox(fake.steps, allowBoot);
  await assert.rejects(sandbox.whenReady({ waitMs: 20 }), /still starting after 0s/);

  const controller = new AbortController();
  const cancelled = sandbox.whenReady({ waitMs: 60_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /cancelled the call while the sandbox was starting/);
  await assert.rejects(sandbox.whenReady({ waitMs: 60_000, signal: AbortSignal.abort() }), /cancelled the call/);

  // The boot itself carries on for the calls that are still waiting.
  assert.equal(sandbox.state(), "starting");
  await sandbox.stop();
});
