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

/**
 * What two sessions on one host share: the container by the session's name,
 * if there is one, and who holds the claim to boot it.
 */
interface Host {
  container?: string;
  claim?: string;
}

function fakeSteps(options: { running?: boolean; host?: Host; session?: string } = {}) {
  const log: string[] = [];
  const boot = deferred<string>();
  const ready = deferred();
  const connect = deferred<{ rpc: string }>();
  let bootSignal: AbortSignal | undefined;
  const host: Host = options.host ?? (options.running ? { container: "existing" } : {});
  const session = options.session ?? "a";
  const steps: SandboxSteps<string, { rpc: string }> = {
    find: async () => host.container,
    claimBoot: () => {
      if (host.claim) return undefined;
      host.claim = session;
      return () => {
        if (host.claim === session) host.claim = undefined;
      };
    },
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
  return { steps, log, boot, ready, connect, host, bootSignal: () => bootSignal };
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

// Two sessions that found no container at once both used to boot it, and the
// loser's sidecar start removed the winner's semantic-fs sidecar by name.
test("of two sessions booting the same container at once, one boots and the other attaches to it", async () => {
  const host: Host = {};
  const a = fakeSteps({ host, session: "a" });
  const b = fakeSteps({ host, session: "b" });
  const options = { ...allowBoot, claimPollMs: 5 };
  const first = startBackgroundSandbox(a.steps, options);
  const second = startBackgroundSandbox(b.steps, options);
  await tick();
  assert.equal(host.claim, "a");
  assert.deepEqual(b.log, [], "the second session boots nothing while the first holds the claim");
  assert.equal(second.owns(), false);

  // The first session's container appears once its boot creates it, before it is ready.
  host.container = "c1";
  a.boot.resolve("c1");
  await tick();
  a.ready.resolve();
  await tick();
  a.connect.resolve({ rpc: "r1" });
  assert.deepEqual(await first.ready, { rpc: "r1", bootedHere: true });
  assert.equal(host.claim, undefined, "the claim is let go once the container is up");

  b.ready.resolve();
  b.connect.resolve({ rpc: "r1" });
  assert.deepEqual(await second.ready, { rpc: "r1", bootedHere: false });
  assert.deepEqual(b.log, ["waitReady", "connect c1 false"], "waits for the other session's container to be ready, then attaches");
  await second.stop();
  assert.deepEqual(b.log, ["waitReady", "connect c1 false"], "and never stops a container it didn't boot");
  assert.equal(second.owns(), false);
});

test("a session waiting on another's boot boots itself once that boot fails", async () => {
  const host: Host = {};
  const a = fakeSteps({ host, session: "a" });
  const b = fakeSteps({ host, session: "b" });
  const options = { ...allowBoot, claimPollMs: 5 };
  const first = startBackgroundSandbox(a.steps, options);
  const second = startBackgroundSandbox(b.steps, options);
  await tick();
  a.boot.reject(new Error("image build failed"));
  await assert.rejects(first.ready, /image build failed/);
  assert.equal(host.claim, undefined);

  for (let i = 0; i < 50 && !b.log.includes("boot"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(host.claim, "b");
  assert.equal(second.owns(), true);
  assert.deepEqual(b.log, ["boot"]);
  await second.stop();
});

test("a claim taken just after another session finished its boot attaches rather than booting again", async () => {
  const host: Host = {};
  const fake = fakeSteps({ host });
  // Nothing there at the first look; by the time the claim is taken, there is.
  let looks = 0;
  fake.steps.find = async () => (looks++ === 0 ? undefined : "c1");
  fake.connect.resolve({ rpc: "r1" });
  const sandbox = startBackgroundSandbox(fake.steps, allowBoot);
  assert.deepEqual(await sandbox.ready, { rpc: "r1", bootedHere: false });
  assert.deepEqual(fake.log, ["connect c1 false"]);
  assert.equal(host.claim, undefined);
  assert.equal(sandbox.owns(), false);
});
