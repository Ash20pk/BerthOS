import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, open, readdir, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "./file-lock.js";

const run = promisify(execFile);

// A pid that was just in use on this host and now isn't: a crashed holder's.
async function deadPid(): Promise<number> {
  const child = execFile(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

// A lock nobody can name the owner of would stall every later call for the
// full stale timeout; one whose owner couldn't be written is removed at once.
test("a lock whose owner can't be written is removed, not left to stall the next call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-lock-"));
  const path = join(dir, "notes.json.lock");
  const probe = await open(join(dir, "probe"), "w");
  const FileHandle = Object.getPrototypeOf(probe) as { writeFile: (...args: unknown[]) => Promise<void> };
  await probe.close();
  const writeFileOriginal = FileHandle.writeFile;
  // The only write a lock around a no-op makes is its owner record.
  FileHandle.writeFile = async () => {
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  };
  try {
    await assert.rejects(withFileLock(path, async () => {}), { code: "ENOSPC" });
  } finally {
    FileHandle.writeFile = writeFileOriginal;
  }
  assert.deepEqual(await readdir(dir), ["probe"]);

  const started = Date.now();
  assert.equal(await withFileLock(path, async () => "next"), "next");
  assert.ok(Date.now() - started < 1_000, `the next call waited ${Date.now() - started} ms`);
});

// Every contender sees the same stale lock at once; before breakers were
// serialized, one could unlink the fresh lock another had just taken in its
// place, and two holders ran at the same time. Six processes, many rounds,
// each holder checking with an O_EXCL marker that it's alone.
test("processes racing to break a stale lock never hold it at the same time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-lock-"));
  const path = join(dir, "notes.json.lock");
  const marker = join(dir, "inside");
  const lockModule = new URL("./file-lock.js", import.meta.url).href;
  const script = `
    const { withFileLock } = await import(${JSON.stringify(lockModule)});
    const { open, unlink } = await import("node:fs/promises");
    const startAt = Number(process.env.START_AT);
    while (Date.now() < startAt) {}
    let overlaps = 0;
    let held = 0;
    for (let i = 0; i < 3; i++) {
      await withFileLock(${JSON.stringify(path)}, async () => {
        let inside;
        try {
          inside = await open(${JSON.stringify(marker)}, "wx");
        } catch {
          overlaps++;
          return;
        }
        held++;
        await new Promise((resolve) => setTimeout(resolve, 2));
        await inside.close();
        await unlink(${JSON.stringify(marker)});
      });
    }
    console.log(JSON.stringify({ overlaps, held }));
  `;
  for (let round = 0; round < 15; round++) {
    await writeFile(path, `${JSON.stringify({ pid: await deadPid(), host: hostname(), token: `seed-${round}` })}\n`);
    const startAt = Date.now() + 400;
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () =>
        run(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, START_AT: String(startAt) } }),
      ),
    );
    const results = outputs.map((o) => JSON.parse(o.stdout) as { overlaps: number; held: number });
    assert.deepEqual(results, Array.from({ length: 6 }, () => ({ overlaps: 0, held: 3 })), `round ${round}`);
    assert.deepEqual(await readdir(dir), [], `round ${round} left files behind`);
  }
});
