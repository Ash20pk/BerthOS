import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VmSandbox, readGuestLog, readVmmLines, PID_FILE } from "./sandbox.js";
import { vmRunDir } from "./paths.js";

// No VM: fake-berth-vmm plays berth-vmm and berth-init on the run dir's sockets.
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fake-berth-vmm.test-fixture.js");
// Short, so the socket paths stay under macOS's 104 bytes.
process.env.BERTH_HOME = mkdtempSync("/tmp/bvm-");

function fakeSpawn(mode: string) {
  return ((_cmd: string, args: readonly string[], options: SpawnOptions) =>
    nodeSpawn(process.execPath, [fixture, ...args], { ...options, env: { ...options.env, FAKE_VMM: mode } })) as unknown as typeof nodeSpawn;
}

const started: VmSandbox[] = [];
after(async () => {
  for (const s of started) if (s.isRunning()) await s.stop({ timeoutMs: 500 });
});

const start = (name: string, mode = "ok", apps = 1) =>
  VmSandbox.start({
    name,
    vmm: "/unused/berth-vmm",
    apps: Array.from({ length: apps }, (_, i) => ({ name: `app${i}`, share: `/shares/app${i}` })),
    spawn: fakeSpawn(mode),
    readyTimeoutMs: 10_000,
  }).then((r) => (started.push(r.sandbox), r));

test("start waits for every app's app_ready, calls go over rpc-<i>.sock, stop powers off and cleans the run dir", async () => {
  const { sandbox, ready, timings } = await start("t-ok", "ok", 2);
  assert.deepEqual(ready.apps.sort(), ["app0", "app1"]);
  assert.ok(timings.readyMs >= timings.measuredMs!);
  assert.equal(sandbox.record.measurements?.event, "measurements");
  assert.ok(existsSync(join(sandbox.runDir, "vm.json")));
  const rpc1 = await sandbox.rpc(1);
  assert.deepEqual(await rpc1.call({ id: "a", export: "echo", input: { x: 1 } }), { id: "a", result: { app: 1, echo: { x: 1 } } });
  assert.equal(sandbox.appIndex("app1"), 1);
  assert.equal(sandbox.appIndex("nope"), undefined);
  assert.equal((await sandbox.status()).event, "status");

  const result = await sandbox.stop();
  assert.equal(result.clean, true);
  assert.equal(result.killed, false);
  assert.equal(sandbox.isRunning(), false);
  assert.deepEqual(readdirSync(sandbox.runDir).filter((f) => f.endsWith(".sock") || f === PID_FILE || f === "vm.json"), []);
});

test("greeting-or-retry: a first connection closed without a byte (libkrun before the guest listens) is retried", async () => {
  const { sandbox } = await start("t-silent", "silent");
  const rpc = await sandbox.rpc(0);
  // The fake closes the first RPC connection as soon as it is accepted. A
  // request written after that close is resent on a new connection (nothing
  // was sent); one in flight when it closes fails, and is never re-sent.
  const first = await rpc.call({ id: "1", export: "echo", input: 1 }).then(
    (r) => r,
    (e: Error) => e,
  );
  if (first instanceof Error) assert.match(first.message, /connection closed before the app answered/);
  else assert.deepEqual(first, { id: "1", result: { app: 0, echo: 1 } });
  assert.deepEqual(await rpc.call({ id: "2", export: "echo", input: 2 }), { id: "2", result: { app: 0, echo: 2 } });
  await sandbox.stop();
});

test("find reattaches to a running sandbox from its run dir, and a second process's stop works", async () => {
  const { sandbox } = await start("t-find");
  const found = await VmSandbox.find("t-find");
  assert.ok(found);
  assert.equal(found.pid, sandbox.pid);
  assert.equal(found.bootId, sandbox.bootId);
  const rpc = await found.rpc(0);
  assert.equal(((await rpc.call({ id: "1", export: "echo", input: "hi" })).result as { echo: string }).echo, "hi");
  assert.equal((await found.stop()).clean, true);
  await sandbox.whenExited();
  assert.equal(await VmSandbox.find("t-find"), undefined);
});

test("a stale run dir (dead pid, or a pid that is no longer berth-vmm) is reported and cleaned", async () => {
  const dir = vmRunDir("t-stale");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PID_FILE), "999999\n");
  writeFileSync(join(dir, "control.sock"), "");
  const why: string[] = [];
  assert.equal(await VmSandbox.find("t-stale", { onStale: (w) => why.push(w) }), undefined);
  assert.match(why[0]!, /no longer running/);
  assert.equal(existsSync(join(dir, "control.sock")), false);

  // This test process is alive, but it is not this run dir's berth-vmm.
  writeFileSync(join(dir, PID_FILE), `${process.pid}\n`);
  assert.equal(await VmSandbox.find("t-stale", { onStale: (w) => why.push(w) }), undefined);
  assert.match(why[1]!, /no longer this sandbox's berth-vmm/);
});

test("a guest that ignores shutdown is SIGKILLed after the timeout", async () => {
  const { sandbox } = await start("t-wedged", "wedged");
  const t0 = Date.now();
  const result = await sandbox.stop({ timeoutMs: 300 });
  assert.equal(result.killed, true);
  assert.equal(result.clean, false);
  assert.ok(Date.now() - t0 < 5_000);
  assert.equal(sandbox.isRunning(), false);
});

test("berth-vmm refusing to boot fails start with its own words", async () => {
  await assert.rejects(start("t-refuse", "refuse"), /berth-vmm exited before it booted the VM[\s\S]*refusing to boot it/);
});

test("an app that exits before ready fails start, and the VM is stopped", async () => {
  await assert.rejects(start("t-exits", "app-exits"), /app0 exited before it reported ready/);
  assert.equal(await VmSandbox.find("t-exits"), undefined);
});

test("the starter pumps the log port into guest.log, which other processes read", async () => {
  const seen: string[] = [];
  const { sandbox } = await VmSandbox.start({
    name: "t-logs",
    vmm: "/unused/berth-vmm",
    apps: [{ name: "app0", share: "/shares/app0" }],
    spawn: fakeSpawn("ok"),
    onLog: (l) => seen.push(l.line),
  });
  started.push(sandbox);
  for (let i = 0; i < 100 && readGuestLog(sandbox.runDir).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const lines = readGuestLog(sandbox.runDir);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.line, /capability_policy_applied/);
  assert.equal(seen.length, 1);
  await sandbox.stop();
});

test("only berth-vmm's own JSON lines are read from its stderr", () => {
  const lines = readVmmLines(
    [
      '{"source":"berth-vmm","event":"endpoints","runDir":"/r"}',
      "berth-vmm: some warning",
      '{"source":"someone-else","event":"measurements"}',
      '{"source":"berth-vmm","event":"measurements","kernel":null}',
      '{"source":"berth-vmm","event":"host_sandbox","kind":"seatbelt","applied":true}',
      "[",
    ].join("\n"),
  );
  assert.equal(lines.endpoints?.runDir, "/r");
  assert.equal(lines.hostSandbox?.applied, true);
  assert.equal(lines.measurements?.kernel, null);
  assert.equal(lines.vmConfig, undefined);
});

test("berth-vmm's own lines after boot (the egress dialer's) reach onVmmEvent; the boot lines don't", async () => {
  const { sandbox } = await start("t-vmmev");
  const seen: Record<string, unknown>[] = [];
  const off = sandbox.onVmmEvent((e) => seen.push(e), 20);
  for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  off();
  assert.deepEqual(seen.map((e) => [e.event, e.decision, e.host]), [["egress", "denied", "example.net"]]);
  await sandbox.stop();
});
