import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A workspace and a bare "remote" of our own, reached over file://, so none
// of this needs a network.
const root = mkdtempSync(join(tmpdir(), "git-app-test-"));
const workspace = join(root, "workspace");
const remote = join(root, "remote.git");
process.env.BERTH_WORKSPACE_ROOT = workspace;
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

const { default: app, baseArgs } = await import("./index.js");
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
  await assert.rejects(call("clone", { url: "ext::sh -c touch% /tmp/pwned-by-ext", dir: "ext" }), /transport 'ext' not allowed/);
  assert.equal(existsSync("/tmp/pwned-by-ext"), false);
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

test("GIT_TOKEN reaches git only through the credential helper's own shell", () => {
  assert.ok(!baseArgs({}).some((a) => a.includes("password=")), "no helper without a token");
  const withToken = baseArgs({ GIT_TOKEN: "ghp_secretvalue" });
  assert.ok(withToken.some((a) => a.includes('password=$GIT_TOKEN')));
  assert.ok(!withToken.some((a) => a.includes("ghp_secretvalue")), "the value itself is never an argument");
  assert.ok(withToken.includes("protocol.allow=never") && withToken.includes("core.hooksPath=/dev/null"));
});
