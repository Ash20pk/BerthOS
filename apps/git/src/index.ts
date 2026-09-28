import { defineApp, requestCapability } from "@berthos/sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "git";
const TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 200_000;

function workspaceRoot(): string {
  const root = resolve(process.env.BERTH_WORKSPACE_ROOT ?? "/workspace");
  return existsSync(root) ? realpathSync(root) : root;
}

function under(root: string, full: string): boolean {
  return full === root || full.startsWith(root + sep);
}

/**
 * The real path of `path`: symlinks in the part that exists are followed, and
 * the rest (what git is about to create) is appended as written. A dangling
 * symlink is refused, since whatever git created through it would land
 * wherever it points.
 */
function realPath(path: string): string {
  const rest: string[] = [];
  let existing = path;
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      const up = dirname(existing);
      if (up === existing) break;
      rest.unshift(basename(existing));
      existing = up;
    }
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    throw new Error(`${path} goes through a link to something that doesn't exist`);
  }
}

/**
 * A path under the workspace, with symlinks resolved, so a link another app
 * planted can't point git somewhere else. Anything outside is refused here
 * (and by the kernel).
 */
function inWorkspace(path: string): string {
  const root = workspaceRoot();
  const full = realPath(resolve(root, path));
  if (!under(root, full)) throw new Error(`${path} is outside the workspace (${root}); repositories live under it`);
  return full;
}

/** Where a remote is: an https host this app declares, or (tests only) a path in the workspace. */
export type Remote = { kind: "https"; host: string } | { kind: "local"; path: string };

/**
 * Local remotes (a path, or file://) are for this app's own tests: pushing to
 * a repository on disk runs that repository's hooks, which git's settings here
 * can't turn off, and a clone from a path copies whatever it names. Even with
 * them on, the path has to be in the workspace.
 */
function localRemotesAllowed(): boolean {
  return process.env.BERTH_GIT_LOCAL_REMOTES === "1";
}

/** Checks a clone URL, or a repository's origin, before git is pointed at it. `base` is what a relative path is relative to. */
export async function checkRemote(url: string, base: string): Promise<Remote> {
  if (url.startsWith("-")) throw new Error("a URL can't start with -");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  let path: string;
  if (scheme === "https") {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${url} isn't a URL`);
    }
    if (parsed.username || parsed.password) throw new Error("put the credentials in the GIT_TOKEN secret, not the URL");
    // Git parses the URL itself, so it has to be one nobody could read two
    // ways: a plain host, no backslashes, spaces or control characters.
    if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[^\s\\]*)?$/i.test(url)) throw new Error(`${url} isn't a URL this app will use (https://host/path, a plain host name)`);
    const host = parsed.host.toLowerCase();
    const { granted } = await requestCapability(APP_NAME, `network:host:${parsed.hostname.toLowerCase()}`);
    if (!granted) throw new Error(`${parsed.hostname} isn't one of this app's network:host: entries in berth.yml, so git won't use it. Add it there and restart the app.`);
    return { kind: "https", host };
  } else if (scheme === "file") {
    path = fileURLToPath(url);
  } else if (scheme || /^[^/]*:/.test(url)) {
    // scp-style host:path is ssh, and "ext::" runs a command.
    throw new Error(`${url} isn't an https:// URL: git here only uses HTTPS (SSH and other transports don't go through the egress proxy)`);
  } else {
    path = resolve(base, url);
  }
  if (!localRemotesAllowed()) throw new Error(`${url} is a path on disk: git here only uses https:// remotes`);
  const real = realPath(path);
  if (!under(workspaceRoot(), real)) throw new Error(`${url} is outside the workspace (${workspaceRoot()})`);
  return { kind: "local", path: real };
}

/**
 * The credential helper, for one host. It answers only a "get" for https and
 * exactly that host, and reads GIT_TOKEN from its own environment, so the
 * token never appears in a URL, a command line or git's config. `host` is
 * checked by checkRemote to be letters, digits, dots, dashes and a port.
 */
export function credentialHelper(host: string): string {
  if (!/^[a-z0-9.-]+(:[0-9]+)?$/.test(host)) throw new Error(`${host} isn't a host name this app will use`);
  return `!f() { test "$1" = get || exit 0; p=; h=; while IFS= read -r l; do case "$l" in protocol=*) p="\${l#protocol=}";; host=*) h="\${l#host=}";; "") break;; esac; done; test "$p" = https && test "$h" = ${host} || exit 0; echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f`;
}

interface GitOptions {
  /** The remote a network command talks to: it decides which transport is allowed and who gets the token. */
  remote?: Remote;
}

/**
 * Settings on every git command. They're passed with -c, which outranks any
 * config file, because the repository's own .git/config is writable by any
 * app with filesystem:write:/workspace and git would otherwise run commands
 * it names. What -c can't switch off (filter drivers, textconv, url
 * rewriting) checkedRepo() refuses instead.
 *
 * - protocol.*: https only, plus the file transport for a local remote in
 *   tests. `ext::` runs a command, and ssh/git:// don't go through the
 *   egress proxy.
 * - core.hooksPath=/dev/null: no hooks.
 * - core.fsmonitor, core.pager, core.editor, core.sshCommand, the gpg
 *   signing switches: each names a program git would run.
 * - submodules, gc and maintenance off: nothing runs in a repository we
 *   didn't check, or in the background.
 * - safe.bareRepository=explicit: a bare repository committed inside a
 *   working tree isn't picked up by accident.
 * - safe.directory=<cwd>: apps have their own uids, so a repository another
 *   app created would otherwise be refused as "dubious ownership". Only the
 *   directory being operated on is trusted, never "*".
 * - http.proxy: the sandbox's egress proxy, the only way out, which refuses
 *   any host berth.yml doesn't list.
 * - credential.helper: cleared, then, for an https remote when GIT_TOKEN is
 *   set, one that answers only for that remote's host.
 */
export function baseArgs(cwd: string, opts: GitOptions = {}, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    ...(opts.remote?.kind === "local" ? ["-c", "protocol.file.allow=always"] : []),
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.pager=cat",
    "-c", "core.editor=false",
    "-c", "sequence.editor=false",
    "-c", "core.sshCommand=false",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "push.gpgSign=false",
    "-c", "log.showSignature=false",
    "-c", "submodule.recurse=false",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "push.recurseSubmodules=no",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
    "-c", "safe.bareRepository=explicit",
    "-c", `safe.directory=${cwd}`,
    "-c", "init.defaultBranch=main",
    "-c", "advice.detachedHead=false",
  ];
  if (env.BERTH_EGRESS_PROXY_URL) args.push("-c", `http.proxy=${env.BERTH_EGRESS_PROXY_URL}`);
  // An empty helper first clears any configured ones.
  args.push("-c", "credential.helper=");
  if (opts.remote?.kind === "https" && env.GIT_TOKEN) args.push("-c", `credential.helper=${credentialHelper(opts.remote.host)}`);
  return args;
}

let home: string | undefined;

/**
 * The environment git runs with: built up, not inherited, so the token and
 * the rest of this app's environment don't reach every program git starts.
 * GIT_TOKEN is only there for a command talking to an https remote. HOME is
 * a directory of our own (mkdtemp makes it 0700 with a random name) and no
 * global or system config is read, so a .gitconfig planted in /tmp or
 * elsewhere can't add settings.
 */
export function gitEnv(opts: GitOptions = {}, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  home ??= mkdtempSync(join(tmpdir(), "berth-git-home-"));
  const out: Record<string, string> = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    // Don't look above the workspace for a repository.
    GIT_CEILING_DIRECTORIES: workspaceRoot(),
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? "Berth agent",
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? "agent@berth.invalid",
    GIT_COMMITTER_NAME: env.GIT_AUTHOR_NAME ?? "Berth agent",
    GIT_COMMITTER_EMAIL: env.GIT_AUTHOR_EMAIL ?? "agent@berth.invalid",
  };
  for (const key of ["TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO"]) {
    if (env[key]) out[key] = env[key]!;
  }
  if (opts.remote?.kind === "https" && env.GIT_TOKEN) out.GIT_TOKEN = env.GIT_TOKEN;
  return out;
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

function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", [...baseArgs(cwd, opts), ...args], { cwd, env: gitEnv(opts), timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0]} failed: ${explain(stderr || error.message)}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

/**
 * The repository-level settings git may run with. Everything else in
 * .git/config is refused rather than filtered: filter.*.clean/smudge,
 * diff.*.textconv, merge.*.driver, include.path, url.*.insteadOf,
 * remote.*.pushurl, remote.*.push, remote.*.uploadpack, credential.* and
 * http.* all either run a command, send the token somewhere else or change
 * what a push does, and -c can't unset most of them. These are the ones git
 * writes itself when it clones, and on push --set-upstream.
 */
const ALLOWED_CONFIG = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/i,
  /^remote\..+\.(url|fetch)$/i,
  /^branch\..+\.(remote|merge)$/i,
  /^extensions\.(objectformat|refstorage)$/i,
  /^user\.(name|email)$/i,
];

/**
 * An existing repository under the workspace that git may run in. Checked on
 * every call, because anything with filesystem:write:/workspace can change
 * it between calls: the directory must be the top of its own working tree,
 * with its git directory in the workspace, borrowing no objects from
 * elsewhere, and with nothing in .git/config outside ALLOWED_CONFIG. (A
 * writer racing a call between this check and git starting isn't covered;
 * the -c settings still hold then, and the token is only in the environment
 * of fetch, clone and push, which don't run filters.)
 */
async function checkedRepo(repo: string): Promise<string> {
  const dir = inWorkspace(repo);
  if (!existsSync(dir)) throw new Error(`there's no repository at ${repo}: clone one first (the clone export), or check the path`);
  const where = await git(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]).catch(() => {
    throw new Error(`${repo} isn't a git repository: clone one first (the clone export), or check the path`);
  });
  const [top, gitDir, commonDir] = where.stdout.trim().split("\n").map((p) => realpathSync(p));
  if (top !== dir) throw new Error(`${repo} isn't the top of a repository (git found ${top})`);
  const root = workspaceRoot();
  if (!under(root, gitDir!) || !under(root, commonDir!)) throw new Error(`${repo}'s git directory is outside the workspace`);
  for (const file of ["alternates", "http-alternates"]) {
    if (existsSync(join(commonDir!, "objects", "info", file))) throw new Error(`${repo} borrows objects from another repository (objects/info/${file}), which this app won't use`);
  }
  const { stdout } = await git(dir, ["config", "--local", "--list", "-z"]);
  const keys = stdout.split("\0").filter(Boolean).map((entry) => entry.split("\n")[0]!);
  const refused = [...new Set(keys.filter((key) => !ALLOWED_CONFIG.some((allowed) => allowed.test(key))))];
  if (refused.length > 0) {
    throw new Error(
      `${repo}'s .git/config sets ${refused.join(", ")}, which this app won't run git with: settings like these can make git run a command, ` +
        `send the token to another repository or change what a push does, and anything that can write the workspace could have put them there. ` +
        `Remove them (git config --local --unset-all <key>) and try again.`,
    );
  }
  return dir;
}

/** The URL `origin` points at, checked like a clone URL. */
async function origin(dir: string, push: boolean): Promise<Remote> {
  const { stdout } = await git(dir, ["remote", "get-url", ...(push ? ["--push"] : []), "origin"]).catch(() => {
    throw new Error("the repository has no remote called origin");
  });
  return checkRemote(stdout.trim(), dir);
}

const BRANCH = /^(?![-+./])[A-Za-z0-9._/-]{1,200}$/;
function branchName(name: string): string {
  if (!BRANCH.test(name) || name.includes("..") || name.endsWith(".lock")) {
    throw new Error(`"${name}" isn't a branch name this app will use (letters, digits, . _ / -, not starting with - + . or /)`);
  }
  return name;
}

async function head(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
}
async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ["branch", "--show-current"])).stdout.trim();
}

export default defineApp((app) => {
  // The download (the only part with the network and the token) is kept
  // apart from the checkout (the only part that runs filters), and the new
  // repository is checked in between.
  app.export({
    name: "clone",
    input: z.object({ url: z.string(), dir: z.string() }),
    output: z.object({ path: z.string(), branch: z.string(), head: z.string() }),
    handler: async ({ url, dir }) => {
      await mkdir(workspaceRoot(), { recursive: true });
      const root = workspaceRoot();
      const target = inWorkspace(dir);
      const remote = await checkRemote(url, root);
      await git(root, ["clone", "--no-checkout", "--", remote.kind === "local" ? remote.path : url, target], { remote });
      const repo = await checkedRepo(target);
      if (await head(repo)) await git(repo, ["reset", "--hard", "-q", "HEAD"]);
      return { path: relative(root, repo), branch: await currentBranch(repo), head: await head(repo) };
    },
  });

  app.export({
    name: "status",
    input: z.object({ repo: z.string() }),
    output: z.object({ branch: z.string(), ahead: z.number(), behind: z.number(), changes: z.array(z.object({ path: z.string(), status: z.string() })) }),
    handler: async ({ repo }) => {
      const { stdout } = await git(await checkedRepo(repo), ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
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
      const { stdout } = await git(await checkedRepo(repo), ["diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : [])]);
      return { diff: stdout.slice(0, MAX_DIFF_CHARS), truncated: stdout.length > MAX_DIFF_CHARS };
    },
  });

  app.export({
    name: "log",
    input: z.object({ repo: z.string(), limit: z.number() }),
    output: z.object({ commits: z.array(z.object({ sha: z.string(), author: z.string(), date: z.string(), subject: z.string() })) }),
    handler: async ({ repo, limit }) => {
      const n = Math.min(Math.max(1, Math.floor(limit) || 20), 500);
      const { stdout } = await git(await checkedRepo(repo), ["log", `-n${n}`, "--date=iso-strict", "--format=%H%x1f%an%x1f%ad%x1f%s"]);
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
      const dir = await checkedRepo(repo);
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
      const dir = await checkedRepo(repo);
      await git(dir, ["add", "--", ...paths]);
      const { stdout } = await git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--name-only"]);
      return { staged: stdout.split("\n").filter(Boolean) };
    },
  });

  app.export({
    name: "commit",
    input: z.object({ repo: z.string(), message: z.string() }),
    output: z.object({ sha: z.string(), summary: z.string() }),
    handler: async ({ repo, message }) => {
      if (!message.trim()) throw new Error("a commit needs a message");
      const dir = await checkedRepo(repo);
      const { stdout } = await git(dir, ["commit", "-m", message]);
      return { sha: await head(dir), summary: stdout.split("\n")[0] ?? "" };
    },
  });

  // Never forced: the refspec is spelled out, refs/heads/<branch> to the
  // same name with no "+", so neither a refspec-like branch name nor a
  // remote.origin.push in the config (which checkedRepo refuses anyway) can
  // rewrite a remote's history or push to a different branch.
  app.export({
    name: "push",
    input: z.object({ repo: z.string(), branch: z.string() }),
    output: z.object({ output: z.string() }),
    handler: async ({ repo, branch }) => {
      const dir = await checkedRepo(repo);
      const name = branchName(branch);
      const remote = await origin(dir, true);
      const { stdout, stderr } = await git(dir, ["push", "--set-upstream", "origin", `refs/heads/${name}:refs/heads/${name}`], { remote });
      return { output: `${stdout}${stderr}`.trim() };
    },
  });

  // A fetch (network and token, no working tree) and then a fast-forward
  // (working tree, no network or token), rather than `git pull`, which does
  // both in one process.
  app.export({
    name: "pull",
    input: z.object({ repo: z.string() }),
    output: z.object({ output: z.string(), head: z.string() }),
    handler: async ({ repo }) => {
      const dir = await checkedRepo(repo);
      const remote = await origin(dir, false);
      const fetched = await git(dir, ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { remote });
      const merged = await git(await checkedRepo(repo), ["merge", "--ff-only", "@{upstream}"]);
      return { output: `${fetched.stdout}${fetched.stderr}${merged.stdout}${merged.stderr}`.trim(), head: await head(dir) };
    },
  });
});
