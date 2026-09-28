import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { execFile, type ExecFileException } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
// A runaway `print()` loop shouldn't be able to blow up the RPC payload (or
// this process's own memory) just because the code it ran misbehaved —
// same defensive posture E2B/AutoGen's own executors take on output size.
const MAX_OUTPUT_CHARS = 200_000;

type Language = "python" | "javascript" | "shell";

const RUNNERS: Record<Language, (code: string) => { command: string; args: string[] }> = {
  python: (code) => ({ command: "python3", args: ["-c", code] }),
  javascript: (code) => ({ command: "node", args: ["-e", code] }),
  shell: (code) => ({ command: "bash", args: ["-c", code] }),
};

// Read at call time, not module load — a test overriding
// BERTH_WORKSPACE_ROOT after import would otherwise be ignored, since the
// container itself always sets this env var before the module is loaded
// (same pattern apps/notes, apps/filesystem, apps/terminal all use).
function workspaceRoot(): string {
  return process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
}

function truncate(output: string): string {
  return output.length > MAX_OUTPUT_CHARS
    ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated, ${output.length - MAX_OUTPUT_CHARS} more characters]`
    : output;
}

interface RunCodeResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  denials: string[];
}

const DENIAL = /Permission denied|Operation not permitted|\bEACCES\b|\bEPERM\b|PermissionError/;
const MAX_DENIALS = 10;

/**
 * The lines of a run's output that report the sandbox refusing something.
 * Code that hits a denial usually handles it (a Python `except OSError`
 * printing the error, a shell `|| echo failed`), so the run itself succeeds
 * and the refusal is only text in stdout. Pulled out here so a caller, and
 * berth mcp's audit trail, can see that the kernel said no without parsing
 * every language's error format.
 */
export function findDenials(...outputs: string[]): string[] {
  const found: string[] = [];
  for (const output of outputs) {
    for (const line of output.split("\n")) {
      const trimmed = line.trim().slice(0, 300);
      if (!DENIAL.test(trimmed) || found.includes(trimmed)) continue;
      found.push(trimmed);
      if (found.length === MAX_DENIALS) return found;
    }
  }
  return found;
}

function runCode(command: string, args: string[], timeoutMs: number): Promise<RunCodeResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_CHARS * 2, cwd: workspaceRoot() },
      (error, stdout, stderr) => {
        const denials = findDenials(stderr, stdout);
        if (!error) {
          resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exit_code: 0, timed_out: false, denials });
          return;
        }
        // execFile's timeout option kills the process with `killSignal`
        // (SIGTERM by default) rather than surfacing a distinct timeout
        // error — `killed` + a signal is the only way to tell "we killed
        // it" apart from "it caught/raised that same signal on its own."
        const execError = error as ExecFileException;
        const timedOut = Boolean(execError.killed && execError.signal);
        const exitCode = typeof execError.code === "number" ? execError.code : 1;
        resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exit_code: exitCode, timed_out: timedOut, denials });
      },
    );
  });
}

export default defineApp((app) => {
  app.export({
    name: "run_code",
    input: z.object({
      language: z.enum(["python", "javascript", "shell"]),
      code: z.string(),
      timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
    }),
    output: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exit_code: z.number(),
      timed_out: z.boolean(),
      denials: z.array(z.string()),
    }),
    handler: async ({ language, code, timeout_ms }) => {
      const { command, args } = RUNNERS[language](code);
      return runCode(command, args, timeout_ms ?? DEFAULT_TIMEOUT_MS);
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "code-interpreter" });
  });
});
