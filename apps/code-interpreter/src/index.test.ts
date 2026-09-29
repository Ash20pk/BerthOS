import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app, { findDenials } from "./index.js";

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

// A refusal the code catches still has to be visible to the caller: the run
// succeeds, and the only trace of the kernel saying no is a line of output.
// Printed rather than provoked, because these tests may run as root, where
// file modes don't refuse anything; the sandbox's Landlock refusals produce
// exactly these messages (checked end to end in the e2e suite).
test("a refusal the code caught is reported in denials, and a clean run has none", async () => {
  await withTempWorkspace(async () => {
    const caught = (await runCode.handler({
      language: "python",
      code: "print('writing...')\nprint(\"PermissionError: [Errno 13] Permission denied: '/etc/berth-x'\")\nprint('done')",
    })) as { exit_code: number; denials: unknown[] };
    assert.equal(caught.exit_code, 0);
    assert.deepEqual(caught.denials, [{ path: "/etc/berth-x", line: "PermissionError: [Errno 13] Permission denied: '/etc/berth-x'" }]);

    const shell = (await runCode.handler({ language: "shell", code: "echo 'touch: /etc/y: Permission denied' >&2; exit 1" })) as { denials: unknown[] };
    assert.deepEqual(shell.denials, [{ path: "/etc/y", line: "touch: /etc/y: Permission denied" }]);

    const clean = (await runCode.handler({ language: "python", code: "print('fine')" })) as { denials: unknown[] };
    assert.deepEqual(clean.denials, []);
  });
});

test("findDenials reads the shapes Python, Node and the shell print a refused path in", () => {
  const found = findDenials(
    [
      "EACCES: permission denied, open '/etc/passwd.new'",
      "Error: EPERM: operation not permitted, mkdir '/opt/x'",
      "mkdir: cannot create directory '/srv/data': Permission denied",
      "bash: line 1: /usr/local/bin/tool: Permission denied",
    ],
    "/workspace",
  );
  assert.deepEqual(
    found.map((d) => d.path),
    ["/etc/passwd.new", "/opt/x", "/srv/data", "/usr/local/bin/tool"],
  );
});

// Every one of these used to be reported as the kernel refusing something.
test("findDenials leaves out refusals that aren't the sandbox's", () => {
  const workspace = "/workspace/.berth/dev-workspace";
  const found = findDenials(
    [
      "git@github.com: Permission denied (publickey).",
      "user@host: Permission denied (publickey,password).",
      "Permission denied, please try again.",
      "ssh: connect to host example.com port 22: Operation not permitted",
      "HTTP 403 from https://api.example.com/v1/repos: Permission denied",
      "kill: (215) - Operation not permitted",
      "cat: app.log: Permission denied",
      `PermissionError: [Errno 13] Permission denied: '${workspace}/locked.txt'`,
      "2026-09-28 WARN permission denied for user alice",
    ],
    workspace,
  );
  assert.deepEqual(found, []);
});

test("findDenials caps what it keeps: ten paths, each line cut short", () => {
  const lines = Array.from({ length: 15 }, (_, i) => `touch: /etc/f${i}: Permission denied ${"x".repeat(500)}`);
  const found = findDenials([lines.join("\n"), lines.join("\n")], "/workspace");
  assert.equal(found.length, 10);
  assert.ok(found.every((d) => d.line.length <= 200));
});

// A plain prefix match counted these as inside the workspace, and dropped them.
test("findDenials resolves a path before deciding it is inside the workspace", () => {
  const found = findDenials(
    [
      "PermissionError: [Errno 13] Permission denied: '/workspace/../etc/x'",
      "touch: /workspace/./../../opt/y: Permission denied",
      "touch: /workspace-other/z: Permission denied",
      "touch: /workspace/sub/../still-inside: Permission denied",
      "touch: /workspace//double: Permission denied",
    ],
    "/workspace/",
  );
  assert.deepEqual(
    found.map((d) => d.path),
    ["/workspace/../etc/x", "/workspace/./../../opt/y", "/workspace-other/z"],
  );
});
