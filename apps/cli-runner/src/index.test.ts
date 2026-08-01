import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "./index.js";

const run = promisify(execFile);

async function withWorkspace<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.BERTH_WORKSPACE_ROOT;
  process.env.BERTH_WORKSPACE_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BERTH_WORKSPACE_ROOT;
    else process.env.BERTH_WORKSPACE_ROOT = previous;
  }
}

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cli-runner-test-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "berth-test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "hello\n", "utf-8");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "initial commit"], { cwd: dir });
  return dir;
}

test("git_status/git_log/git_diff reflect a real repo's history", async () => {
  const dir = await makeGitRepo();
  await withWorkspace(dir, async () => {
    const gitStatus = app._exports.get("git_status")!;
    const clean = (await gitStatus.handler(undefined)) as { clean: boolean; changes: string[] };
    assert.deepEqual(clean, { clean: true, changes: [] });

    await writeFile(join(dir, "README.md"), "hello again\n", "utf-8");
    const dirty = (await gitStatus.handler(undefined)) as { clean: boolean; changes: string[] };
    assert.equal(dirty.clean, false);
    assert.equal(dirty.changes.length, 1);

    const gitLog = app._exports.get("git_log")!;
    const { commits } = (await gitLog.handler({ count: 10 })) as { commits: string[] };
    assert.equal(commits.length, 1);
    assert.match(commits[0]!, /initial commit/);

    const gitDiff = app._exports.get("git_diff")!;
    const { diff } = (await gitDiff.handler({ path: "README.md" })) as { diff: string };
    assert.match(diff, /hello again/);
  });
});

test("exports degrade gracefully when the workspace isn't a git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-runner-test-norepo-"));
  await withWorkspace(dir, async () => {
    const gitStatus = app._exports.get("git_status")!;
    assert.deepEqual(await gitStatus.handler(undefined), { clean: true, changes: [] });

    const gitLog = app._exports.get("git_log")!;
    assert.deepEqual(await gitLog.handler({ count: 5 }), { commits: [] });

    const gitDiff = app._exports.get("git_diff")!;
    assert.deepEqual(await gitDiff.handler({ path: undefined }), { diff: "" });
  });
});

test("git_diff rejects a path that escapes the workspace", async () => {
  const dir = await makeGitRepo();
  await withWorkspace(dir, async () => {
    const gitDiff = app._exports.get("git_diff")!;
    await assert.rejects(async () => {
      await gitDiff.handler({ path: "../outside" });
    }, /escapes the workspace/);
  });
});
