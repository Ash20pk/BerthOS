import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import app from "./index.js";

const execFileAsync = promisify(execFile);

// Every test shares the one lazily-created "berth-terminal" tmux session
// (see src/tmux-controller.ts) — killed up front so a leftover session from
// a previous run/crash never leaks state (a stale cwd, a still-running
// command) into these assertions.
await execFileAsync("tmux", ["kill-session", "-t", "berth-terminal"]).catch(() => {});

test("run_command returns just the command's own output", async () => {
  const runCommand = app._exports.get("run_command")!;
  const result = (await runCommand.handler({ command: "echo hello-world" })) as { output: string };
  assert.equal(result.output, "hello-world");
});

test("run_command preserves shell state (cwd) across calls", async () => {
  const runCommand = app._exports.get("run_command")!;
  await runCommand.handler({ command: "cd /tmp" });
  const result = (await runCommand.handler({ command: "pwd" })) as { output: string };
  assert.equal(result.output, "/tmp");
});

test("read_screen reflects the most recent command", async () => {
  const runCommand = app._exports.get("run_command")!;
  const readScreen = app._exports.get("read_screen")!;
  await runCommand.handler({ command: "echo find-me-on-screen" });
  const result = (await readScreen.handler(undefined)) as { text: string };
  assert.match(result.text, /find-me-on-screen/);
});

test("send_keys C-c interrupts a running command without killing the shell", async () => {
  const runCommand = app._exports.get("run_command")!;
  const sendKeys = app._exports.get("send_keys")!;

  await runCommand.handler({ command: "true" }); // ensures the shared session exists

  // Seeded directly via tmux, not through run_command — run_command blocks
  // until it sees its own sentinel, so a still-running "sleep 60" would just
  // make it time out rather than letting this test send C-c mid-command.
  await execFileAsync("tmux", ["send-keys", "-t", "berth-terminal", "sleep 60", "Enter"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await sendKeys.handler({ keys: "C-c" });

  const result = (await runCommand.handler({ command: "echo still-alive" })) as { output: string };
  assert.equal(result.output, "still-alive");
});
