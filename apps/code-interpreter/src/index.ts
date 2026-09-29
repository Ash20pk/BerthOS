import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { execFile, type ExecFileException } from "node:child_process";
import { posix } from "node:path";

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

/** One line of a run's output that looks like the sandbox refusing access to a path. */
interface PossibleDenial {
  /** The absolute path the line says was refused. */
  path: string;
  /** The line itself, trimmed and capped. */
  line: string;
}

interface RunCodeResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  denials: PossibleDenial[];
}

// The errno messages a refused open/mkdir/exec produces, in the shapes the
// three runtimes print them: Python's `[Errno 13] Permission denied: '/x'`,
// Node's `EACCES: permission denied, open '/x'`, coreutils' `touch: cannot
// touch '/x': Permission denied` and bash's `bash: /x: Permission denied`.
const DENIAL = /\b(?:EACCES|EPERM)\b|Permission denied|Operation not permitted/i;
// An absolute path, quoted or bare, on the same line.
const PATH = /['"`](\/[^'"`]*)['"`]|(?:^|[\s:(])(\/[^\s:'"`,)]+)/;
// Refusals that aren't the sandbox: remote auth (ssh, git over ssh), a
// password prompt, and an error that came back from a URL.
const NOT_THE_SANDBOX = /Permission denied \((?:publickey|password|keyboard-interactive)|Permission denied, please try again|\bssh:|git@|https?:\/\//i;
const MAX_DENIALS = 10;
const MAX_LINE_CHARS = 200;

/**
 * The lines of a run's output that look like the sandbox refusing a path.
 * Code that hits a denial usually handles it (a Python `except OSError`
 * printing the error, a shell `|| echo failed`), so the run itself succeeds
 * and the refusal is only text in stdout.
 *
 * "Look like" is all this can say: it reads the output, it doesn't see the
 * syscall. So it only counts a line that names an absolute path, drops the
 * common refusals that have nothing to do with the sandbox (ssh publickey,
 * password prompts, errors from a remote URL), and drops paths inside this
 * app's own workspace, which its declared capability allows: a refusal there
 * is a file's own permissions, not the sandbox. What's left is reported as a
 * possible refusal, never as a fact about the kernel.
 */
export function findDenials(outputs: string[], workspace: string = workspaceRoot()): PossibleDenial[] {
  const found: PossibleDenial[] = [];
  // Resolved first: as plain text, `/workspace/../etc/x` starts with the
  // workspace and would be dropped as inside it.
  const root = posix.resolve(workspace);
  const inWorkspace = (path: string) => {
    const resolved = posix.resolve(root, path);
    return resolved === root || resolved.startsWith(`${root === "/" ? "" : root}/`);
  };
  for (const output of outputs) {
    for (const raw of output.split("\n")) {
      const line = raw.trim();
      if (!DENIAL.test(line) || NOT_THE_SANDBOX.test(line)) continue;
      const match = PATH.exec(line);
      const path = match?.[1] ?? match?.[2];
      if (!path || inWorkspace(path)) continue;
      if (found.some((d) => d.path === path)) continue;
      found.push({ path: path.slice(0, MAX_LINE_CHARS), line: line.slice(0, MAX_LINE_CHARS) });
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
        const denials = findDenials([stderr, stdout]);
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
      denials: z.array(z.object({ path: z.string(), line: z.string() })),
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
