import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOsState, writeOsState } from "./os-state.js";

const STATE = {
  name: "demo",
  containerName: "berth-os-demo",
  image: "berth-os-demo:latest",
  apps: [{ name: "filesystem", appDir: "/repo/apps/filesystem" }],
  startedAt: new Date().toISOString(),
  httpRpc: { url: "http://127.0.0.1:49999", token: "bearer-token-not-for-other-local-users" },
};

/**
 * REMEDIATION.md 5.5: this file holds the HTTP RPC bearer token — full access
 * to the named OS's exports — and was written at the umask's default 0644.
 */
test("writeOsState writes 0600 in a 0700 directory, and still round-trips", async () => {
  const osDir = join(await mkdtemp(join(tmpdir(), "berth-os-state-test-")), "os");

  await writeOsState(STATE, osDir);

  assert.equal((await stat(join(osDir, "demo.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(osDir)).mode & 0o777, 0o700);
  assert.equal((await readOsState("demo", osDir))?.httpRpc?.token, STATE.httpRpc.token);
});

/** `berth os up` overwrites an existing state file, and writeFile()'s `mode` is ignored for a file that already exists. */
test("writeOsState re-tightens a state file left loose by an earlier run", async () => {
  const osDir = join(await mkdtemp(join(tmpdir(), "berth-os-state-test-")), "os");
  await writeOsState(STATE, osDir);
  await chmod(join(osDir, "demo.json"), 0o644);
  await chmod(osDir, 0o755);

  await writeOsState(STATE, osDir);

  assert.equal((await stat(join(osDir, "demo.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(osDir)).mode & 0o777, 0o700);
});
