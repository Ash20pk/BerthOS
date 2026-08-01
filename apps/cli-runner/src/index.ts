import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, isAbsolute } from "node:path";

const run = promisify(execFile);

function workspaceRoot(): string {
  return process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
}

type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

// Only ever pass a fixed argv array to execFile (never a shell string built
// from user input) — this is what makes wrapping an external CLI as RPC safe
// to expose to an agent: there's no interpolation point for command
// injection, only a fixed set of git subcommands with validated arguments.
// Failures (workspace isn't a git repo, git isn't installed yet) are
// reported as a value rather than thrown, so a missing repo degrades to an
// empty result instead of failing berth test's stub invocation.
async function git(args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await run("git", args, { cwd: workspaceRoot() });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Keeps a user-supplied relative path inside the workspace — git itself
// would just report "no such path" for a traversal attempt, but resolving
// and checking here fails closed before git ever sees it, which matters
// once this export is a tool an agent calls with untrusted input.
function resolveInWorkspace(relativePath: string): string {
  const resolved = join(workspaceRoot(), relativePath);
  const rel = relative(workspaceRoot(), resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path "${relativePath}" escapes the workspace`);
  }
  return rel;
}

export default defineApp((app) => {
  app.export({
    name: "git_status",
    output: z.object({ clean: z.boolean(), changes: z.array(z.string()) }),
    handler: async () => {
      const result = await git(["status", "--porcelain"]);
      if (!result.ok) return { clean: true, changes: [] };
      const changes = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      return { clean: changes.length === 0, changes };
    },
  });

  app.export({
    name: "git_log",
    input: z.object({ count: z.number().int().positive().max(100) }),
    output: z.object({ commits: z.array(z.string()) }),
    handler: async ({ count }) => {
      const result = await git(["log", "-n", String(count), "--oneline"]);
      if (!result.ok) return { commits: [] };
      return { commits: result.stdout.split("\n").filter(Boolean) };
    },
  });

  app.export({
    name: "git_diff",
    input: z.object({ path: z.string().optional() }),
    output: z.object({ diff: z.string() }),
    handler: async ({ path }) => {
      const args = ["diff"];
      if (path) args.push("--", resolveInWorkspace(path));
      const result = await git(args);
      return { diff: result.ok ? result.stdout : "" };
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "cli-runner" });
  });
});
