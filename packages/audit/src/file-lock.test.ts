import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, tryAcquireFileLock } from "./file-lock.js";

function tmpLock(): string {
  return join(mkdtempSync(join(tmpdir(), "berth-lock-")), "audit.jsonl.lock");
}

/** Backdates a file, as if its holder had been sitting on it for `ms`. */
function age(path: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
}

const DEAD_PID = 2147483646;

// A live holder that is merely slow (stopped, swapping, a stalled disk) used
// to be broken once its lock passed staleMs, letting a second writer in.
test("a live holder on this host is never broken, however old its lock", () => {
  const path = tmpLock();
  const held = `${process.pid} ${hostname()} slowholder\n`;
  writeFileSync(path, held);
  age(path, 60_000);
  assert.throws(() => acquireFileLock(path, { waitMs: 100, staleMs: 10 }), /timed out/);
  assert.equal(readFileSync(path, "utf-8"), held);
});

test("a slow holder in this process keeps the lock past staleMs", () => {
  const path = tmpLock();
  const a = acquireFileLock(path, { staleMs: 10 });
  age(path, 1_000);
  assert.throws(() => acquireFileLock(path, { waitMs: 100, staleMs: 10 }), /timed out/);
  assert.equal(a.held(), true);
  a.release();
  assert.equal(existsSync(path), false);
});

test("a dead holder on this host is broken, however young its lock", () => {
  const path = tmpLock();
  writeFileSync(path, `${DEAD_PID} ${hostname()} deadbeef\n`);
  const lock = acquireFileLock(path, { waitMs: 2_000, staleMs: 60_000 });
  assert.equal(lock.held(), true);
  lock.release();
  assert.equal(existsSync(path), false);
});

test("a lock from another host is broken by age only", () => {
  const path = tmpLock();
  writeFileSync(path, `${process.pid} some-other-host deadbeef\n`);
  assert.throws(() => acquireFileLock(path, { waitMs: 100, staleMs: 60_000 }), /timed out/);
  age(path, 1_000);
  acquireFileLock(path, { waitMs: 2_000, staleMs: 500 }).release();
});

test("a malformed lock is broken by age only", () => {
  const path = tmpLock();
  writeFileSync(path, "");
  assert.throws(() => acquireFileLock(path, { waitMs: 100, staleMs: 60_000 }), /timed out/);
  age(path, 1_000);
  acquireFileLock(path, { waitMs: 2_000, staleMs: 500 }).release();
});

test("a breaker that died leaves a .break that is cleared once its pid is gone, and not before", () => {
  const path = tmpLock();
  writeFileSync(path, `${DEAD_PID} ${hostname()} deadbeef\n`);
  const live = `${process.pid} ${hostname()} breaking\n`;
  writeFileSync(`${path}.break`, live);
  assert.throws(() => acquireFileLock(path, { waitMs: 100 }), /timed out/);
  assert.equal(readFileSync(`${path}.break`, "utf-8"), live, "a live breaker's claim is left alone");

  writeFileSync(`${path}.break`, `${DEAD_PID} ${hostname()} breaking\n`);
  acquireFileLock(path, { waitMs: 2_000 }).release();
  assert.equal(existsSync(`${path}.break`), false);
});

test("a holder whose lock was replaced knows it no longer holds it, and leaves the new one alone", () => {
  const path = tmpLock();
  const lock = acquireFileLock(path);
  const other = `${process.pid} ${hostname()} someoneelse\n`;
  writeFileSync(path, other);
  assert.equal(lock.held(), false);
  assert.throws(() => lock.assertHeld(), /lost the lock/);
  lock.release();
  assert.equal(readFileSync(path, "utf-8"), other);
});

// The reviewer's repro: with a stale lock and three or more contenders, the
// old break (rename aside, link back if it had changed) let two of them in.
// Each contender here holds the lock while creating a marker file with
// O_EXCL, so a second holder at the same time fails to create it.
test("contenders racing to break the same stale lock take turns", async () => {
  const path = tmpLock();
  const marker = `${path}.inside`;
  const lockModule = new URL("./file-lock.js", import.meta.url).href;
  const script = `
    const { acquireFileLock } = await import(${JSON.stringify(lockModule)});
    const { closeSync, openSync, unlinkSync } = await import("node:fs");
    const [lock, marker, startAt] = process.argv.slice(1);
    while (Date.now() < Number(startAt)) {}
    const held = acquireFileLock(lock, { waitMs: 10000 });
    let overlap = false;
    try { closeSync(openSync(marker, "wx")); } catch { overlap = true; }
    const t = Date.now(); while (Date.now() - t < 2) {}
    if (!overlap) unlinkSync(marker);
    held.release();
    if (overlap) process.stdout.write("OVERLAP");
  `;
  let overlaps = 0;
  for (let round = 0; round < 15; round++) {
    writeFileSync(path, `${DEAD_PID} ${hostname()} deadbeef\n`);
    const startAt = Date.now() + 300;
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script, path, marker, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`contender exited ${code}: ${err}`))));
        }),
      ),
    );
    overlaps += outputs.filter((o) => o.includes("OVERLAP")).length;
  }
  assert.equal(overlaps, 0);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.break`), false);
});

test("tryAcquireFileLock takes a free or stale lock at once, and returns undefined while a live holder has it", () => {
  const path = tmpLock();
  const first = tryAcquireFileLock(path);
  assert.ok(first);
  assert.equal(tryAcquireFileLock(path), undefined);
  first.release();

  writeFileSync(path, `${DEAD_PID} ${hostname()} deadbeef\n`);
  const second = tryAcquireFileLock(path);
  assert.ok(second, "a dead holder's lock is broken and taken");
  second.release();
  assert.equal(existsSync(path), false);
});
