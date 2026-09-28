import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A tmux server of our own (TMUX_TMPDIR), so nothing here touches a session
// on the machine running the tests, and so the server starts with this
// process's environment rather than an existing server's.
// Under /tmp, not os.tmpdir(): macOS's per-user temp path is too long for the
// socket path tmux builds inside it.
process.env.TMUX_TMPDIR = mkdtempSync("/tmp/bterm-");
// What every sandboxed app has: its own system user, whose login shell
// refuses to run. /usr/bin/false stands in for /sbin/nologin, which not every
// test host has.
process.env.SHELL = "/usr/bin/false";
process.env.BERTH_WORKSPACE_ROOT = tmpdir();
process.env.BERTH_TERMINAL_CREDENTIAL = "berth:test";
const { runCommand, readScreen } = await import("./tmux-controller.js");

test("the shell starts when the app user's login shell refuses logins", async () => {
  assert.equal((await runCommand("echo alive")).trim(), "alive");
});

test("a session that ended is recreated on the next call", async () => {
  await execFileAsync("tmux", ["kill-session", "-t", "berth-terminal"]);
  assert.equal((await runCommand("echo again")).trim(), "again");
});

test("concurrent first calls share one session instead of racing to create it", async () => {
  // No server at all, as on the first call after boot. Each of these used to
  // run has-session, see nothing, and run new-session; all but one then
  // failed with "duplicate session".
  await execFileAsync("tmux", ["kill-server"]).catch(() => {});
  const results = await Promise.allSettled([runCommand("echo one"), runCommand("echo two"), readScreen(), runCommand("echo three")]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
    results.map((r) => (r.status === "rejected" ? String(r.reason) : "")).join("\n"),
  );
  const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"]);
  assert.deepEqual(stdout.trim().split("\n"), ["berth-terminal"]);
});

test.after(async () => {
  await execFileAsync("tmux", ["kill-server"]).catch(() => {});
});
