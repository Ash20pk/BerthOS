import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 200_000;

function workspaceRoot(): string {
  return process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
}

/** A path under the workspace; anything that resolves outside it is refused here (and by the kernel). */
function inWorkspace(path: string): string {
  const root = resolve(workspaceRoot());
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`${path} is outside the workspace (${root}); repositories live under it`);
  return full;
}

/**
 * Settings on every git command. They're what make git safe to hand an agent
 * in a sandbox, so they're passed with -c rather than left to any config file
 * a repository could carry:
 *
 * - protocol.*.allow: https, http and file only. `ext::` runs an arbitrary
 *   command as a "transport", and ssh/git:// don't go through the egress proxy.
 * - core.hooksPath=/dev/null: no hooks. Another app that can write
 *   /workspace could otherwise plant one that runs with this app's network.
 * - safe.directory=*: apps have their own uids, so a repository another app
 *   created would otherwise be refused as "dubious ownership".
 * - http.proxy: the sandbox's egress proxy, the only way out, which refuses
 *   any host berth.yml doesn't list.
 * - credential.helper: GIT_TOKEN, read by the helper's own shell from the
 *   environment, so it never appears in a URL, a command line or git's
 *   config, and it's only offered to hosts the proxy lets through.
 */
export function baseArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.http.allow=always",
    "-c", "protocol.file.allow=always",
    "-c", "core.hooksPath=/dev/null",
    "-c", "safe.directory=*",
    "-c", "init.defaultBranch=main",
    "-c", "advice.detachedHead=false",
  ];
  if (env.BERTH_EGRESS_PROXY_URL) args.push("-c", `http.proxy=${env.BERTH_EGRESS_PROXY_URL}`);
  // An empty helper first clears any configured ones.
  args.push("-c", "credential.helper=");
  if (env.GIT_TOKEN) {
    args.push("-c", `credential.helper=!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f`);
  }
  return args;
}

function gitEnv(): NodeJS.ProcessEnv {
  const home = process.env.TMPDIR ?? "/tmp";
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Berth agent",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "agent@berth.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_AUTHOR_NAME ?? "Berth agent",
    GIT_COMMITTER_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "agent@berth.invalid",
  };
}

function explain(stderr: string): string {
  if (/CONNECT tunnel failed, response 403|Received HTTP code 403 from proxy/i.test(stderr)) {
    return `${stderr.trim()}\nThe sandbox's egress proxy refused the host: git may only reach the network:host: entries in its berth.yml (and never an internal address). Add the host there and restart the app.`;
  }
  if (/terminal prompts disabled|could not read Username|Authentication failed/i.test(stderr)) {
    return `${stderr.trim()}\nThe remote asked for credentials: set the GIT_TOKEN secret (berth os up --env GIT_TOKEN, or Computer.boot({ env })).`;
  }
  return stderr.trim();
}

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", [...baseArgs(), ...args], { cwd, env: gitEnv(), timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0]} failed: ${explain(stderr || error.message)}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

/** An existing repository under the workspace. */
function repoDir(repo: string): string {
  const dir = inWorkspace(repo);
  if (!existsSync(dir)) throw new Error(`there's no repository at ${repo}: clone one first (the clone export), or check the path`);
  return dir;
}

const BRANCH = /^(?![-+./])[A-Za-z0-9._/-]{1,200}$/;
function branchName(name: string): string {
  if (!BRANCH.test(name) || name.includes("..") || name.endsWith(".lock")) {
    throw new Error(`"${name}" isn't a branch name this app will use (letters, digits, . _ / -, not starting with - + . or /)`);
  }
  return name;
}

async function head(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
}
async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ["branch", "--show-current"])).stdout.trim();
}

export default defineApp((app) => {
  app.export({
    name: "clone",
    input: z.object({ url: z.string(), dir: z.string() }),
    output: z.object({ path: z.string(), branch: z.string(), head: z.string() }),
    handler: async ({ url, dir }) => {
      if (url.startsWith("-")) throw new Error("a URL can't start with -");
      const target = inWorkspace(dir);
      await mkdir(workspaceRoot(), { recursive: true });
      await git(workspaceRoot(), ["clone", "--", url, target]);
      return { path: relative(resolve(workspaceRoot()), target), branch: await currentBranch(target), head: await head(target) };
    },
  });

  app.export({
    name: "status",
    input: z.object({ repo: z.string() }),
    output: z.object({ branch: z.string(), ahead: z.number(), behind: z.number(), changes: z.array(z.object({ path: z.string(), status: z.string() })) }),
    handler: async ({ repo }) => {
      const { stdout } = await git(repoDir(repo), ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
      let branch = "";
      let ahead = 0;
      let behind = 0;
      const changes: { path: string; status: string }[] = [];
      for (const line of stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const m = /\+(\d+) -(\d+)/.exec(line);
          if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
        } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
          const parts = line.split(" ");
          const xy = parts[1]!;
          const path = line.startsWith("2 ") ? parts.slice(9).join(" ").split("\t")[0]! : parts.slice(8).join(" ");
          changes.push({ path, status: xy.replace(/\./g, " ").trim() || xy });
        } else if (line.startsWith("? ")) changes.push({ path: line.slice(2), status: "untracked" });
        else if (line.startsWith("u ")) changes.push({ path: line.split(" ").slice(10).join(" "), status: "conflict" });
      }
      return { branch, ahead, behind, changes };
    },
  });

  app.export({
    name: "diff",
    input: z.object({ repo: z.string(), staged: z.boolean() }),
    output: z.object({ diff: z.string(), truncated: z.boolean() }),
    handler: async ({ repo, staged }) => {
      const { stdout } = await git(repoDir(repo), ["diff", ...(staged ? ["--cached"] : [])]);
      return { diff: stdout.slice(0, MAX_DIFF_CHARS), truncated: stdout.length > MAX_DIFF_CHARS };
    },
  });

  app.export({
    name: "log",
    input: z.object({ repo: z.string(), limit: z.number() }),
    output: z.object({ commits: z.array(z.object({ sha: z.string(), author: z.string(), date: z.string(), subject: z.string() })) }),
    handler: async ({ repo, limit }) => {
      const n = Math.min(Math.max(1, Math.floor(limit) || 20), 500);
      const { stdout } = await git(repoDir(repo), ["log", `-n${n}`, "--date=iso-strict", "--format=%H%x1f%an%x1f%ad%x1f%s"]);
      const commits = stdout.split("\n").filter(Boolean).map((l) => {
        const [sha, author, date, subject] = l.split("\x1f");
        return { sha: sha!, author: author!, date: date!, subject: subject ?? "" };
      });
      return { commits };
    },
  });

  app.export({
    name: "branch",
    input: z.object({ repo: z.string(), name: z.string(), create: z.boolean() }),
    output: z.object({ branch: z.string() }),
    handler: async ({ repo, name, create }) => {
      const dir = repoDir(repo);
      await git(dir, ["switch", ...(create ? ["-c"] : []), branchName(name)]);
      return { branch: await currentBranch(dir) };
    },
  });

  app.export({
    name: "add",
    input: z.object({ repo: z.string(), paths: z.array(z.string()) }),
    output: z.object({ staged: z.array(z.string()) }),
    handler: async ({ repo, paths }) => {
      if (paths.length === 0) throw new Error("name at least one path to stage (\".\" for everything)");
      const dir = repoDir(repo);
      await git(dir, ["add", "--", ...paths]);
      const { stdout } = await git(dir, ["diff", "--cached", "--name-only"]);
      return { staged: stdout.split("\n").filter(Boolean) };
    },
  });

  app.export({
    name: "commit",
    input: z.object({ repo: z.string(), message: z.string() }),
    output: z.object({ sha: z.string(), summary: z.string() }),
    handler: async ({ repo, message }) => {
      if (!message.trim()) throw new Error("a commit needs a message");
      const dir = repoDir(repo);
      const { stdout } = await git(dir, ["commit", "-m", message]);
      return { sha: await head(dir), summary: stdout.split("\n")[0] ?? "" };
    },
  });

  // Never forced: `branch` is a plain name, so no "+ref" or "src:dst" refspec
  // can rewrite a remote's history or push to a different branch.
  app.export({
    name: "push",
    input: z.object({ repo: z.string(), branch: z.string() }),
    output: z.object({ output: z.string() }),
    handler: async ({ repo, branch }) => {
      const { stdout, stderr } = await git(repoDir(repo), ["push", "--set-upstream", "origin", branchName(branch)]);
      return { output: `${stdout}${stderr}`.trim() };
    },
  });

  app.export({
    name: "pull",
    input: z.object({ repo: z.string() }),
    output: z.object({ output: z.string(), head: z.string() }),
    handler: async ({ repo }) => {
      const dir = repoDir(repo);
      const { stdout, stderr } = await git(dir, ["pull", "--ff-only"]);
      return { output: `${stdout}${stderr}`.trim(), head: await head(dir) };
    },
  });
});
