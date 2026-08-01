import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app, { runInShell } from "./index.js";

// currentCwd() inside index.ts resolves BERTH_WORKSPACE_ROOT exactly once,
// on this module's first run_command/get_cwd call — outside a real
// container /workspace doesn't exist, so that first resolution needs a real
// directory to hand spawn() as its cwd before any test's own `cd` can move
// it elsewhere.
process.env.BERTH_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "terminal-test-initial-"));

const runCommand = app._exports.get("run_command")!;
const getCwd = app._exports.get("get_cwd")!;

// cwd is a single module-level session (the whole point of a persistent
// terminal), so each test claims its own fresh temp dir via `cd` rather than
// relying on BERTH_WORKSPACE_ROOT — that env var is only ever consulted
// once, on this module's very first run_command/get_cwd call.
//
// Resolved via realpath before use: each run_command spawns a brand-new
// bash process with Node's `cwd` spawn option, which chdir(2)s at the OS
// level before bash starts — a fresh process's own getcwd() returns the
// physically resolved path, unlike a shell builtin `cd`'s symlink-preserving
// logical PWD. On macOS (where /tmp is itself a symlink to /private/tmp)
// that means later cwd values come back de-symlinked even though this dir's
// own literal string wasn't; resolving up front keeps every comparison
// consistent regardless of host OS.
async function cdToFreshDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const result = (await runCommand.handler({ command: `cd "${dir}"` })) as { exitCode: number; cwd: string };
  assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, dir);
  return dir;
}

test("run_command executes a command and returns its stdout and exit code", async () => {
  await cdToFreshDir("terminal-test-");
  const result = (await runCommand.handler({ command: "echo hello-terminal" })) as { stdout: string; exitCode: number };
  assert.equal(result.stdout.trim(), "hello-terminal");
  assert.equal(result.exitCode, 0);
});

test("cwd persists across calls like cd in a real terminal session", async () => {
  const dir = await cdToFreshDir("terminal-test-cwd-");
  await runCommand.handler({ command: "mkdir sub" });

  const cdResult = (await runCommand.handler({ command: "cd sub" })) as { cwd: string };
  assert.equal(cdResult.cwd, join(dir, "sub"));

  const pwdResult = (await runCommand.handler({ command: "pwd" })) as { stdout: string; cwd: string };
  assert.equal(pwdResult.stdout.trim(), join(dir, "sub"));
  assert.equal(pwdResult.cwd, join(dir, "sub"));

  const cwdExport = (await getCwd.handler(undefined)) as { cwd: string };
  assert.equal(cwdExport.cwd, join(dir, "sub"));
});

test("captures stderr and a non-zero exit code without throwing", async () => {
  await cdToFreshDir("terminal-test-exit-");
  const result = (await runCommand.handler({ command: "echo oops 1>&2; exit 3" })) as {
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  };
  assert.equal(result.stderr.trim(), "oops");
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test("runInShell kills a command that exceeds its timeout", async () => {
  const start = Date.now();
  const result = await runInShell("sleep 5", tmpdir(), 200);
  const elapsedMs = Date.now() - start;

  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs < 2000, `expected the kill to cut sleep short, took ${elapsedMs}ms`);
});
