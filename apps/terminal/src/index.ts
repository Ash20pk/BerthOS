import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { spawn } from "node:child_process";

function workspaceRoot(): string {
  return process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 100_000;

// Vanishingly unlikely to appear in real command output — used to split a
// command's own stdout from the trailing $PWD we append to it, which is how
// a persistent working directory survives across calls without a real
// long-lived shell process backing this app (each run_command is its own
// `bash -c`, re-cd'd via the tracked cwd rather than a surviving process
// whose own `cd` state would otherwise be lost the moment it exits).
const CWD_MARKER = "__berth_terminal_cwd__";

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`
    : text;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  timedOut: boolean;
}

// This is the whole point of a "terminal" app: `command` is handed to bash
// verbatim (pipes, redirects, globs, quoting all work like a real shell),
// not parsed into a fixed argv scoped to one allowlisted binary the way a
// narrower CLI-wrapping app would. stdin is closed rather than left
// connected to anything, so a command
// expecting interactive input hits EOF immediately instead of hanging the
// RPC call, and a timeout + SIGKILL bounds a command that never exits on
// its own (e.g. a runaway server) — real terminals don't need either
// safeguard because a human is there to Ctrl-C; an RPC call awaiting a
// response needs both.
export function runInShell(command: string, cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    const wrapped = `${command}\nprintf '%s' "${CWD_MARKER}$PWD"`;
    // detached: true makes bash the leader of its own process group, so a
    // timeout can kill the *group* (a pipeline, a backgrounded job, `sleep`
    // as a grandchild of bash) rather than just the bash process itself —
    // killing only bash leaves a grandchild holding the stdout pipe open,
    // and `close` wouldn't fire until that grandchild exits on its own.
    const child = spawn("bash", ["-c", wrapped], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));

    child.on("close", (code) => {
      clearTimeout(timer);
      const markerIndex = stdout.lastIndexOf(CWD_MARKER);
      let endCwd = cwd;
      if (markerIndex !== -1) {
        endCwd = stdout.slice(markerIndex + CWD_MARKER.length) || cwd;
        stdout = stdout.slice(0, markerIndex);
      }
      resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code ?? -1, cwd: endCwd, timedOut });
    });
  });
}

export default defineApp((app) => {
  // Lazily resolved on first use rather than at module load — a test (or a
  // container whose entrypoint sets BERTH_WORKSPACE_ROOT after this module
  // is imported) overriding the env var would otherwise be ignored.
  let cwd: string | undefined;
  function currentCwd(): string {
    if (cwd === undefined) cwd = workspaceRoot();
    return cwd;
  }

  app.export({
    name: "run_command",
    input: z.object({ command: z.string() }),
    output: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number(),
      cwd: z.string(),
      timedOut: z.boolean(),
    }),
    handler: async ({ command }) => {
      const result = await runInShell(command, currentCwd());
      cwd = result.cwd;
      return result;
    },
  });

  app.export({
    name: "get_cwd",
    output: z.object({ cwd: z.string() }),
    handler: () => ({ cwd: currentCwd() }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "terminal" });
  });
});
