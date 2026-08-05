import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "./index.js";

const runCode = app._exports.get("run_code")!;

async function withTempWorkspace<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "code-interpreter-test-"));
  const previous = process.env.BERTH_WORKSPACE_ROOT;
  process.env.BERTH_WORKSPACE_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BERTH_WORKSPACE_ROOT;
    else process.env.BERTH_WORKSPACE_ROOT = previous;
  }
}

test("runs a Python snippet and captures stdout", async () => {
  await withTempWorkspace(async () => {
    const result = (await runCode.handler({ language: "python", code: "print('hello from python')" })) as any;
    assert.equal(result.stdout.trim(), "hello from python");
    assert.equal(result.stderr, "");
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
  });
});

test("runs a JavaScript snippet and captures stdout", async () => {
  await withTempWorkspace(async () => {
    const result = (await runCode.handler({ language: "javascript", code: "console.log('hello from node')" })) as any;
    assert.equal(result.stdout.trim(), "hello from node");
    assert.equal(result.exit_code, 0);
  });
});

test("runs a shell snippet and captures stdout", async () => {
  await withTempWorkspace(async () => {
    const result = (await runCode.handler({ language: "shell", code: "echo hello from shell" })) as any;
    assert.equal(result.stdout.trim(), "hello from shell");
    assert.equal(result.exit_code, 0);
  });
});

test("a non-zero exit code and stderr both come through uncorrupted", async () => {
  await withTempWorkspace(async () => {
    const result = (await runCode.handler({
      language: "python",
      code: "import sys; sys.stderr.write('boom'); sys.exit(7)",
    })) as any;
    assert.equal(result.stderr.trim(), "boom");
    assert.equal(result.exit_code, 7);
    assert.equal(result.timed_out, false);
  });
});

test("a real syntax error surfaces as a non-zero exit with the interpreter's own error text on stderr", async () => {
  await withTempWorkspace(async () => {
    const result = (await runCode.handler({ language: "javascript", code: "this is not valid javascript(((" })) as any;
    assert.notEqual(result.exit_code, 0);
    assert.match(result.stderr, /SyntaxError/);
  });
});

test("a real timeout kills the process and is reported distinctly from a normal failure", async () => {
  await withTempWorkspace(async () => {
    const result = (await runCode.handler({
      language: "python",
      code: "import time; time.sleep(5)",
      timeout_ms: 200,
    })) as any;
    assert.equal(result.timed_out, true);
    assert.notEqual(result.exit_code, 0);
  });
});

test("output past the truncation cap is cut, not silently dropped or left to blow up memory", async () => {
  await withTempWorkspace(async () => {
    const result = (await runCode.handler({ language: "python", code: "print('x' * 300_000)" })) as any;
    assert.ok(result.stdout.length < 300_000);
    assert.match(result.stdout, /truncated/);
  });
});

test("code runs with BERTH_WORKSPACE_ROOT as its cwd, matching this app's declared filesystem:write capability", async () => {
  await withTempWorkspace(async () => {
    const result = (await runCode.handler({ language: "shell", code: "pwd" })) as any;
    // realpath, not a direct string compare — macOS resolves /var's own
    // /private/var symlink by the time a subprocess's shell reports $PWD,
    // even though mkdtemp() itself returned the unresolved path.
    const expected = await realpath(process.env.BERTH_WORKSPACE_ROOT!);
    assert.equal(result.stdout.trim(), expected);
  });
});
