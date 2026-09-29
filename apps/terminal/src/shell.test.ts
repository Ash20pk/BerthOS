import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
// Stand-ins for what a real app process carries: the host's RPC token, a
// declared secret's value, a provider key.
process.env.BERTH_HTTP_RPC_TOKEN = "rpc-token-must-not-leak";
process.env.OPENAI_API_KEY = "api-key-must-not-leak";
// A stand-in ttyd that records each start and the environment it got, then
// exits at once, as a crashed ttyd would.
const fakeBin = mkdtempSync("/tmp/bterm-bin-");
const ttydLog = `${fakeBin}/starts.log`;
writeFileSync(ttydLog, "");
writeFileSync(`${fakeBin}/ttyd`, `#!/bin/sh\nenv >> "${ttydLog}"\necho --- >> "${ttydLog}"\n`);
chmodSync(`${fakeBin}/ttyd`, 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
const { runCommand, readScreen, shellEnv, isLoginShell } = await import("./tmux-controller.js");

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

test("the shell doesn't see the app's secrets", async () => {
  const seen = await runCommand('echo "[${BERTH_HTTP_RPC_TOKEN-}${OPENAI_API_KEY-}${BERTH_TERMINAL_CREDENTIAL-}]"');
  assert.equal(seen.trim(), "[]");
  // Still a working environment, not an empty one.
  assert.equal((await runCommand('test -n "$PATH" && test -n "$HOME" && echo ok')).trim(), "ok");
});

test("shellEnv keeps what a terminal needs and drops everything else", () => {
  const env = shellEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/app",
    TMUX_TMPDIR: "/tmp/app",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HTTPS_PROXY: "http://127.0.0.1:8090",
    BERTH_TERMINAL_CREDENTIAL: "berth:secret",
    BERTH_HTTP_RPC_TOKEN: "token",
    GITHUB_TOKEN: "ghp_x",
    ANTHROPIC_API_KEY: "sk-x",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "PATH", "SHELL", "TMUX_TMPDIR"]);
});

test("only a shell listed in /etc/shells counts as a login shell", () => {
  const etcShells = "# comment\n/bin/sh\n/bin/bash\n";
  assert.equal(isLoginShell("/bin/sh", etcShells), true);
  for (const notAShell of ["/usr/bin/false", "/usr/bin/true", "/bin/sync", "/sbin/nologin"]) {
    assert.equal(isLoginShell(notAShell, etcShells), false, notAShell);
  }
  // No /etc/shells: known shells only.
  assert.equal(isLoginShell("/bin/sh", null), true);
  assert.equal(isLoginShell("/usr/bin/true", null), false);
  assert.equal(isLoginShell("/does/not/exist/bash", null), false);
});

test("ttyd is started again after it exits, without the app's secrets", async () => {
  const starts = () => readFileSync(ttydLog, "utf8").split("---").length - 1;
  // Each call after the fake has exited should start it again; polled, since
  // when the exit is seen depends on the scheduler.
  for (let i = 0; i < 20 && starts() < 2; i++) {
    await runCommand("true");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(starts() >= 2, `ttyd started ${starts()} time(s)`);
  const log = readFileSync(ttydLog, "utf8");
  assert.doesNotMatch(log, /must-not-leak|berth:test/);
});

test.after(async () => {
  await execFileAsync("tmux", ["kill-server"]).catch(() => {});
});
