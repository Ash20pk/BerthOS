import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A workspace and a bare "remote" of our own inside it, reached over file://
// (which BERTH_GIT_LOCAL_REMOTES turns on for tests), so none of this needs
// a network.
const root = mkdtempSync(join(tmpdir(), "git-app-test-"));
const workspace = join(root, "workspace");
mkdirSync(workspace);
const remote = join(workspace, "remote.git");
process.env.BERTH_WORKSPACE_ROOT = workspace;
process.env.BERTH_GIT_LOCAL_REMOTES = "1";
delete process.env.BERTH_EGRESS_PROXY_URL;
delete process.env.GIT_TOKEN;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=seed", "-c", "user.email=seed@test", ...args], { cwd, encoding: "utf-8" });
execFileSync("git", ["init", "--bare", "-b", "main", remote]);
const seed = join(root, "seed");
execFileSync("git", ["clone", remote, seed], { stdio: "ignore" });
writeFileSync(join(seed, "README.md"), "hello\n");
sh(seed, "add", ".");
sh(seed, "commit", "-m", "initial");
sh(seed, "push", "origin", "main");

const { default: app, baseArgs, gitEnv, credentialHelper, checkRemote } = await import("./index.js");
const call = (name: string, input: unknown) => app._exports.get(name)!.handler(input) as Promise<any>;

test("clone, then status and log see the remote's history", async () => {
  const cloned = await call("clone", { url: `file://${remote}`, dir: "repo" });
  assert.deepEqual({ path: cloned.path, branch: cloned.branch }, { path: "repo", branch: "main" });
  assert.match(cloned.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(await call("status", { repo: "repo" }), { branch: "main", ahead: 0, behind: 0, changes: [] });
  const { commits } = await call("log", { repo: "repo", limit: 5 });
  assert.equal(commits[0].subject, "initial");
});

test("change, stage, diff, commit and push reach the remote", async () => {
  writeFileSync(join(workspace, "repo", "README.md"), "hello\nworld\n");
  writeFileSync(join(workspace, "repo", "new.txt"), "new\n");
  const status = await call("status", { repo: "repo" });
  assert.deepEqual(status.changes.sort((a: any, b: any) => (a.path < b.path ? -1 : 1)), [
    { path: "README.md", status: "M" },
    { path: "new.txt", status: "untracked" },
  ]);
  assert.deepEqual((await call("add", { repo: "repo", paths: ["."] })).staged, ["README.md", "new.txt"]);
  assert.match((await call("diff", { repo: "repo", staged: true })).diff, /\+world/);
  const commit = await call("commit", { repo: "repo", message: "Add world" });
  assert.match(commit.sha, /^[0-9a-f]{40}$/);
  assert.equal((await call("status", { repo: "repo" })).ahead, 1);
  await call("push", { repo: "repo", branch: "main" });
  assert.match(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s %an"], { encoding: "utf-8" }), /^Add world Berth agent/);
});

test("a new branch is created, switched to and pushed", async () => {
  assert.deepEqual(await call("branch", { repo: "repo", name: "feature/x", create: true }), { branch: "feature/x" });
  writeFileSync(join(workspace, "repo", "x.txt"), "x\n");
  await call("add", { repo: "repo", paths: ["x.txt"] });
  await call("commit", { repo: "repo", message: "x" });
  await call("push", { repo: "repo", branch: "feature/x" });
  assert.match(execFileSync("git", ["--git-dir", remote, "branch"], { encoding: "utf-8" }), /feature\/x/);
  assert.equal(sh(join(workspace, "repo"), "rev-parse", "--abbrev-ref", "feature/x@{upstream}").trim(), "origin/feature/x");
  await call("branch", { repo: "repo", name: "main", create: false });
});

test("pull fast-forwards to someone else's push", async () => {
  sh(seed, "pull", "origin", "main");
  writeFileSync(join(seed, "other.txt"), "from elsewhere\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-m", "elsewhere");
  sh(seed, "push", "origin", "main");
  const pulled = await call("pull", { repo: "repo" });
  assert.equal((await call("log", { repo: "repo", limit: 1 })).commits[0].subject, "elsewhere");
  assert.match(pulled.head, /^[0-9a-f]{40}$/);
});

test("the ext:: transport, which runs a command, is refused", async () => {
  const marker = join(root, "pwned-by-ext");
  await assert.rejects(call("clone", { url: `ext::sh -c touch% ${marker}`, dir: "ext" }), /only uses HTTPS/);
  assert.equal(existsSync(marker), false);
  // git's own guard, underneath the app's: ext isn't an allowed protocol.
  assert.throws(
    () => execFileSync("git", [...baseArgs(workspace), "clone", `ext::sh -c touch% ${marker}`, join(root, "ext")], { cwd: workspace, env: gitEnv(), stdio: "pipe" }),
    /transport 'ext' not allowed/,
  );
  assert.equal(existsSync(marker), false);
});

test("hooks never run, even if something plants one", async () => {
  const marker = join(root, "hook-ran");
  const hook = join(workspace, "repo", ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(workspace, "repo", "y.txt"), "y\n");
  await call("add", { repo: "repo", paths: ["y.txt"] });
  await call("commit", { repo: "repo", message: "y" });
  assert.equal(existsSync(marker), false);
});

test("paths outside the workspace, and refspec-like branch names, are refused", async () => {
  await assert.rejects(call("status", { repo: "../../etc" }), /outside the workspace/);
  await assert.rejects(call("status", { repo: "no-such-repo" }), /there's no repository at no-such-repo/);
  await assert.rejects(call("clone", { url: `file://${remote}`, dir: "/tmp/elsewhere" }), /outside the workspace/);
  for (const name of ["+main", "-f", "main:other", "a..b", "x.lock", "/abs"]) {
    await assert.rejects(call("push", { repo: "repo", branch: name }), /isn't a branch name/, name);
  }
});

test("GIT_TOKEN reaches git only through the credential helper, and only for an https remote", () => {
  const github = { kind: "https" as const, host: "github.com" };
  const env = { GIT_TOKEN: "ghp_secretvalue", PATH: "/usr/bin:/bin", AWS_SECRET_ACCESS_KEY: "other" };
  assert.ok(!baseArgs(workspace, {}, env).some((a) => a.includes("password=")), "no helper for a local command");
  assert.ok(!baseArgs(workspace, { remote: github }, { PATH: "/bin" }).some((a) => a.includes("password=")), "no helper without a token");
  const withToken = baseArgs(workspace, { remote: github }, env);
  assert.ok(withToken.some((a) => a.includes('password=$GIT_TOKEN')));
  assert.ok(!withToken.some((a) => a.includes("ghp_secretvalue")), "the value itself is never an argument");
  for (const setting of ["protocol.allow=never", "core.hooksPath=/dev/null", "core.fsmonitor=false", "commit.gpgSign=false", `safe.directory=${workspace}`]) {
    assert.ok(withToken.includes(setting), setting);
  }
  assert.ok(!withToken.includes("safe.directory=*"));
  assert.ok(!withToken.includes("protocol.file.allow=always"), "no file transport for an https remote");
  assert.ok(!withToken.some((a) => a.startsWith("protocol.http.")), "no plain http");

  // The environment is built, not inherited: the token only for https, nothing else of ours.
  assert.equal(gitEnv({}, env).GIT_TOKEN, undefined);
  assert.equal(gitEnv({ remote: { kind: "local", path: remote } }, env).GIT_TOKEN, undefined);
  assert.equal(gitEnv({ remote: github }, env).GIT_TOKEN, "ghp_secretvalue");
  assert.equal(gitEnv({ remote: github }, env).AWS_SECRET_ACCESS_KEY, undefined);
  // No global or system config, and a HOME of our own rather than /tmp.
  const { HOME, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM } = gitEnv({}, env);
  assert.deepEqual({ GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM }, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  assert.notEqual(HOME, tmpdir());
  assert.match(HOME!, /berth-git-home-/);
});

test("the credential helper answers only a get, for https and its own host", () => {
  const helper = credentialHelper("github.com");
  const ask = (action: string, request: string) =>
    execFileSync("sh", ["-c", `${helper.slice(1)} ${action}`], { input: request, env: { PATH: "/usr/bin:/bin", GIT_TOKEN: "ghp_secretvalue" }, encoding: "utf-8" });
  assert.equal(ask("get", "protocol=https\nhost=github.com\npath=a/b.git\n\n"), "username=x-access-token\npassword=ghp_secretvalue\n");
  assert.equal(ask("get", "protocol=https\nhost=evil.example.com\n\n"), "", "another host");
  assert.equal(ask("get", "protocol=https\nhost=github.com.evil.example.com\n\n"), "", "a host that starts the same");
  assert.equal(ask("get", "protocol=http\nhost=github.com\n\n"), "", "plain http");
  // store and erase exit without reading (git ignores the closed pipe), so nothing is written to them here.
  assert.equal(ask("store", ""), "");
  assert.equal(ask("erase", ""), "");
  assert.throws(() => credentialHelper("github.com; rm -rf /"), /isn't a host name/);
});

test("remotes: https to declared hosts only, and no ssh, http or credentials in the URL", async () => {
  // berth.yml declares network:host:github.com.
  assert.deepEqual(await checkRemote("https://github.com/owner/repo.git", workspace), { kind: "https", host: "github.com" });
  await assert.rejects(checkRemote("https://evil.example.com/owner/repo.git", workspace), /isn't one of this app's network:host: entries/);
  await assert.rejects(checkRemote("https://user:pass@github.com/owner/repo.git", workspace), /GIT_TOKEN secret, not the URL/);
  for (const url of ["https://github.com\\@evil.example.com/x.git", "https://github.com/x y", "https://%67ithub.com/x.git"]) {
    await assert.rejects(checkRemote(url, workspace), /isn't a URL this app will use/, url);
  }
  for (const url of ["http://github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git", "git@github.com:owner/repo.git", "git://github.com/owner/repo.git"]) {
    await assert.rejects(checkRemote(url, workspace), /only uses HTTPS/, url);
  }
});

test("a local clone from outside the workspace is refused, and local remotes are off outside tests", async () => {
  const outside = join(root, "seed");
  await assert.rejects(call("clone", { url: outside, dir: "copy" }), /outside the workspace/);
  await assert.rejects(call("clone", { url: `file://${outside}`, dir: "copy" }), /outside the workspace/);
  await assert.rejects(call("clone", { url: "../seed", dir: "copy" }), /outside the workspace/);
  await assert.rejects(call("clone", { url: "file:///etc", dir: "copy" }), /outside the workspace/);
  delete process.env.BERTH_GIT_LOCAL_REMOTES;
  try {
    await assert.rejects(call("clone", { url: `file://${remote}`, dir: "copy" }), /a path on disk/);
    await assert.rejects(call("pull", { repo: "repo" }), /a path on disk/);
  } finally {
    process.env.BERTH_GIT_LOCAL_REMOTES = "1";
  }
  assert.equal(existsSync(join(workspace, "copy")), false);
});

test("a symlink out of the workspace, or a directory inside a repository, isn't a repository here", async () => {
  symlinkSync(join(root, "seed"), join(workspace, "escape"));
  await assert.rejects(call("status", { repo: "escape" }), /outside the workspace/);
  await assert.rejects(call("clone", { url: `file://${remote}`, dir: "escape/inner" }), /outside the workspace/);
  symlinkSync(join(root, "nowhere"), join(workspace, "dangling"));
  await assert.rejects(call("clone", { url: `file://${remote}`, dir: "dangling" }), /link to something that doesn't exist/);
  mkdirSync(join(workspace, "repo", "sub"), { recursive: true });
  await assert.rejects(call("status", { repo: "repo/sub" }), /isn't the top of a repository/);
});

// Each of these makes git run a command (here, one that writes the token to
// a file), redirects the token, or rewrites what a push does. Another app
// with filesystem:write:/workspace can write .git/config, so every export
// refuses a repository whose config has them, and nothing runs.
test("a repository whose config would run a command or redirect a push is refused", async () => {
  const repo = join(workspace, "repo");
  const leak = join(root, "leaked");
  const script = join(root, "leak.sh");
  writeFileSync(script, `#!/bin/sh\necho "$GIT_TOKEN" >> ${leak}\ncat\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(repo, ".gitattributes"), "* filter=leak diff=leak\n");
  writeFileSync(join(repo, "README.md"), "changed\n");
  const cases: [string, string][] = [
    ["core.fsmonitor", script],
    ["diff.external", script],
    ["filter.leak.clean", script],
    ["filter.leak.smudge", script],
    ["diff.leak.textconv", script],
    ["gpg.program", script],
    ["core.pager", script],
    ["core.sshCommand", script],
    ["core.hooksPath", join(root, "hooks")],
    ["include.path", join(root, "included")],
    ["includeIf.gitdir:/.path", join(root, "included")],
    ["url.file:///elsewhere.insteadOf", `file://${remote}`],
    ["url.file:///elsewhere.pushInsteadOf", `file://${remote}`],
    ["remote.origin.pushurl", "https://github.com/attacker/repo.git"],
    ["remote.origin.push", "+refs/heads/main:refs/heads/main"],
    ["remote.origin.receivepack", script],
    ["remote.origin.uploadpack", script],
    ["credential.helper", script],
    ["http.extraHeader", "X: y"],
    ["merge.leak.driver", script],
    ["extensions.worktreeConfig", "true"],
  ];
  const before = execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf-8" });
  try {
    for (const [key, value] of cases) {
      sh(repo, "config", "--local", key, value);
      for (const [name, input] of [
        ["status", { repo: "repo" }],
        ["diff", { repo: "repo", staged: false }],
        ["add", { repo: "repo", paths: ["."] }],
        ["commit", { repo: "repo", message: "leak" }],
        ["log", { repo: "repo", limit: 1 }],
        ["branch", { repo: "repo", name: "main", create: false }],
        ["push", { repo: "repo", branch: "main" }],
        ["pull", { repo: "repo" }],
      ] as const) {
        await assert.rejects(call(name, input), new RegExp(`sets ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which this app won't run git with`, "i"), `${key} on ${name}`);
      }
      sh(repo, "config", "--local", "--unset-all", key);
    }
  } finally {
    sh(repo, "checkout", "--", "README.md");
    sh(repo, "rm", "-q", "--cached", "--ignore-unmatch", ".gitattributes");
    execFileSync("rm", ["-f", join(repo, ".gitattributes")]);
  }
  assert.equal(existsSync(leak), false, existsSync(leak) ? readFileSync(leak, "utf-8") : "");
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf-8" }), before, "nothing was pushed");
  assert.deepEqual((await call("status", { repo: "repo" })).changes, []);
});

test("push never forces: a remote that has moved on is left alone", async () => {
  // Someone else pushes; our clone then commits on the old tip.
  sh(seed, "pull", "-q", "origin", "main");
  writeFileSync(join(seed, "theirs.txt"), "theirs\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-m", "theirs");
  sh(seed, "push", "-q", "origin", "main");
  const theirs = execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf-8" });
  writeFileSync(join(workspace, "repo", "ours.txt"), "ours\n");
  await call("add", { repo: "repo", paths: ["ours.txt"] });
  await call("commit", { repo: "repo", message: "ours" });
  await assert.rejects(call("push", { repo: "repo", branch: "main" }), /rejected|non-fast-forward|fetch first/);
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf-8" }), theirs);
  // And a config refspec that would force it is refused before git runs.
  sh(join(workspace, "repo"), "config", "remote.origin.push", "+refs/heads/main:refs/heads/main");
  await assert.rejects(call("push", { repo: "repo", branch: "main" }), /sets remote\.origin\.push/);
  sh(join(workspace, "repo"), "config", "--unset-all", "remote.origin.push");
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf-8" }), theirs);
});

// git pushes to every remote.origin.url, but get-url shows only the first, so
// a second one planted in the config would get the push (and the token)
// without ever being checked. A remote section named after the checked URL
// would be applied by git to a command given that URL, so those go too.
test("a remote with a second url, or named like a URL, is refused and nothing is pushed there", async () => {
  const repo = join(workspace, "repo");
  const other = join(workspace, "other.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", other]);
  sh(repo, "pull", "-q", "--rebase", "origin", "main");
  sh(repo, "config", "--local", "--add", "remote.origin.url", `file://${other}`);
  try {
    for (const [name, input] of [
      ["push", { repo: "repo", branch: "main" }],
      ["pull", { repo: "repo" }],
      ["status", { repo: "repo" }],
    ] as const) {
      await assert.rejects(call(name, input), /gives remote\.origin\.url more than one value/, name);
    }
  } finally {
    sh(repo, "config", "--local", "--unset-all", "remote.origin.url");
    sh(repo, "config", "--local", "remote.origin.url", remote);
  }
  for (const section of [remote, `file://${remote}`]) {
    sh(repo, "config", "--local", `remote.${section}.url`, `file://${other}`);
    await assert.rejects(call("push", { repo: "repo", branch: "main" }), /sets remote\..*\.url, which this app won't run git with/, section);
    sh(repo, "config", "--local", "--remove-section", `remote.${section}`);
  }
  assert.equal(execFileSync("git", ["--git-dir", other, "for-each-ref"], { encoding: "utf-8" }), "", "nothing reached the other repository");

  // With the config back to one url, the push reaches origin, and the upstream is set as --set-upstream would.
  await call("push", { repo: "repo", branch: "main" });
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf-8" }), sh(repo, "rev-parse", "main"));
  assert.equal(sh(repo, "rev-parse", "origin/main"), sh(repo, "rev-parse", "main"));
  assert.equal(sh(repo, "rev-parse", "--abbrev-ref", "main@{upstream}").trim(), "origin/main");
});

test("a fetch refspec in the config doesn't add refs of its own to a pull", async () => {
  const repo = join(workspace, "repo");
  sh(repo, "config", "--local", "--add", "remote.origin.fetch", "+refs/heads/*:refs/tags/planted/*");
  try {
    await call("pull", { repo: "repo" });
    assert.equal(sh(repo, "for-each-ref", "refs/tags/planted"), "");
  } finally {
    sh(repo, "config", "--local", "--unset", "remote.origin.fetch", "planted");
  }
});
