#!/usr/bin/env node
// Real, running verification of REMEDIATION 1.6: `berth dev` no longer gives a
// resident app write access to the developer's own repository.
//
// It used to bind-mount the whole pnpm workspace root read-write at
// /workspace. Four first-party apps declare `filesystem:write:/workspace`, so
// the kernel policy granted them exactly that — the real repo, on the real
// host. Writing `.git/hooks/pre-commit` or any `package.json`'s `scripts` is
// host-side code execution on the developer's next commit or build; rewriting
// the app's own `berth.yml` and letting the file watcher restart the container
// recompiled the attacker's own capability list into the enforced policy.
//
// This test drives the *real* mount layout — it imports resolveDevBindMount
// from the built CLI rather than reconstructing the binds by hand, so a change
// to how `berth dev` mounts things can't pass here while breaking there.
//
// The app under test is apps/filesystem, chosen because its declared write
// path IS /workspace and its exports are a thin, unvalidating wrapper over
// fs (any escape has to be refused by the kernel, not by app code).
//
// A warning if you run this as a negative control (make the mount read-write
// again and watch it fail — it was confirmed to, on all seven assertions):
// against the old behaviour the writes genuinely land. It plants
// `.git/hooks/pre-commit` and `pwned-root.txt` in the repo you ran it from and
// overwrites `apps/filesystem/berth.yml`. That is the finding, not a bug in
// the test, so it deliberately does not clean up after itself — back those
// three paths up first.
//
// Runs anywhere Docker does. Read-only bind mounts are a VFS property
// (EROFS), not a Landlock rule, so unlike capability-enforcement.mjs none of
// this degrades to informational on a kernel without Landlock — which is
// most of the point: this holds on Docker Desktop, where agent-init fails
// open and every Landlock assertion is unverifiable.
import Docker from "dockerode";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer, createStdioRpcClient } from "../dist/index.js";
import { resolveDevBindMount } from "../../cli/dist/util/workspace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const TAG = "berth/filesystem:dev";
const CONTAINER_NAME = "berth-test-dev-workspace-mount";

const docker = new Docker();
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** apps/filesystem's write_file resolves relative to BERTH_WORKSPACE_ROOT, so `..` is how you aim outside it. */
async function writeVia(rpc, path, content) {
  const response = await rpc.call({ id: String(Math.random()), export: "write_file", input: { path, content } });
  return response.error ?? null;
}

async function main() {
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));
  const { bindMount, extraBinds, workingDir, workspaceRoot } = resolveDevBindMount(APP_DIR);

  console.log("Mount layout under test:");
  console.log(`  ${bindMount.hostPath} -> ${bindMount.containerPath}${bindMount.readOnly ? " (ro)" : " (rw)"}`);
  for (const bind of extraBinds) console.log(`  ${bind}`);
  console.log(`  BERTH_WORKSPACE_ROOT=${workspaceRoot}`);

  check("the workspace root is mounted read-only", bindMount.readOnly === true, "still read-write — every assertion below is moot");

  console.log("\nBuilding filesystem's dev image...");
  await buildImage({ appDir: APP_DIR, tag: TAG, target: "dev", appName: manifest.name, docker });

  const stateVolume = "berth-test-dev-mount-app-state";
  await docker.createVolume({ Name: stateVolume }).catch(() => {});

  console.log("Starting the sandbox with berth dev's real mount layout...");
  const running = await startContainer({
    image: TAG,
    name: CONTAINER_NAME,
    manifest,
    bindMount,
    extraBinds,
    workingDir,
    appStateVolume: stateVolume,
    env: { BERTH_WORKSPACE_ROOT: workspaceRoot },
    docker,
  });

  try {
    // Attach *before* waiting for the app to be ready, which is the ordering
    // every other stdio-RPC milestone uses. Attaching after the runtime has
    // already started reading stdin gets a stream whose writes never arrive,
    // and every call then times out against a perfectly healthy app — which
    // is exactly what happened while writing this test.
    const rpc = await createStdioRpcClient(running.container, docker);
    const ready = await waitFor(async () => {
      const logs = (await running.container.logs({ stdout: true, stderr: true })).toString("utf-8");
      return /"filesystem" ready/.test(logs);
    }, 60000);
    check("the app booted and registered its exports", ready, "never printed its ready line");

    try {
      console.log("\n--- Test 1: the app can still write its own workspace ---");
      // Asserted first and deliberately: every denial below would also "pass"
      // against an app that simply cannot write anything at all.
      const ownError = await writeVia(rpc, "hello.txt", "from the app");
      check("write_file succeeds inside the dev workspace", ownError === null, `got error: ${ownError}`);
      const onHost = join(REPO_ROOT, ".berth", "dev-workspace", "hello.txt");
      check(
        "and it lands on the host where the developer can see it",
        existsSync(onHost) && readFileSync(onHost, "utf-8") === "from the app",
        `expected ${onHost} to exist with that content`,
      );

      console.log("\n--- Test 2: it cannot write the repository root ---");
      const rootError = await writeVia(rpc, "../../pwned-root.txt", "x");
      check("a write to the workspace root is refused", rootError !== null, "the write succeeded");
      check(
        "no file appeared at the repo root on the host",
        !existsSync(join(REPO_ROOT, "pwned-root.txt")),
        "a file was created in the developer's own repository",
      );

      console.log("\n--- Test 3: it cannot write .git/hooks ---");
      // The specific escalation named in 1.6: a pre-commit hook is host-side
      // code execution the next time the developer commits.
      const hookError = await writeVia(rpc, "../../.git/hooks/pre-commit", "#!/bin/sh\necho pwned\n");
      check("a write to .git/hooks/pre-commit is refused", hookError !== null, "the write succeeded");
      check(
        "no hook appeared on the host",
        !existsSync(join(REPO_ROOT, ".git", "hooks", "pre-commit")),
        "a git hook was planted in the developer's own repository",
      );

      console.log("\n--- Test 4: it cannot rewrite its own berth.yml ---");
      // The other half of 1.6's chain: rewrite the manifest, let the watcher
      // restart the container, and the attacker's own capability list is what
      // gets compiled into the enforced policy on the way back up.
      const before = readFileSync(join(APP_DIR, "berth.yml"), "utf-8");
      const manifestError = await writeVia(rpc, "../../apps/filesystem/berth.yml", "name: pwned\nversion: 9.9.9\n");
      check("a write to its own berth.yml is refused", manifestError !== null, "the write succeeded");
      check(
        "the manifest on the host is byte-identical",
        readFileSync(join(APP_DIR, "berth.yml"), "utf-8") === before,
        "the app rewrote its own manifest on the developer's disk",
      );

      console.log("\n--- Test 5: the capability policy is still writable ---");
      // Not a security property — a regression guard. .berth has to stay
      // writable through the read-only mount or generate-capability-policy.js
      // fails and agent-init has no policy to apply, which would show up as an
      // unrelated boot failure days later.
      const logs = (await running.container.logs({ stdout: true, stderr: true })).toString("utf-8");
      check(
        "generate-capability-policy wrote a real policy",
        /\[berth:capability-policy\] wrote/.test(logs),
        "no policy was written — .berth is not writable through the read-only mount",
      );
    } finally {
      rpc.close();
    }
  } finally {
    await stopContainer(running.container).catch(() => {});
    rmSync(join(REPO_ROOT, ".berth", "dev-workspace", "hello.txt"), { force: true });
  }

  // A separate container, because the failure mode it guards against is
  // specific to companions: the primary's .berth gets a writable volume via
  // startContainer's own appStateVolume option, but a companion's is a bind
  // dev.ts adds by hand. Miss it and generate-capability-policy.js hits EROFS
  // on the read-only mount, agent-init has no policy to apply, and the app
  // fails minutes later for a reason that looks nothing like a mount problem.
  console.log("\n--- Test 6: companions get a writable .berth through the read-only mount ---");
  const companionDir = join(REPO_ROOT, "apps", "code-editor");
  const multi = resolveDevBindMount(APP_DIR, [{ appDir: companionDir, relPath: "apps/code-editor" }]);
  for (const [name, relPath] of [
    ["filesystem", "apps/filesystem"],
    ["code-editor", "apps/code-editor"],
  ]) {
    const volume = `berth-test-dev-mount-${name}-app-state`;
    await docker.createVolume({ Name: volume }).catch(() => {});
    multi.extraBinds.push(`${volume}:/workspace/${relPath}/.berth`);
  }

  const multiRunning = await startContainer({
    image: TAG,
    name: `${CONTAINER_NAME}-multi`,
    manifest,
    bindMount: multi.bindMount,
    extraBinds: multi.extraBinds,
    workingDir: multi.workingDir,
    env: { BERTH_WORKSPACE_ROOT: multi.workspaceRoot },
    apps: [
      { name: "filesystem", workingDir: "/workspace/apps/filesystem", manifest },
      { name: "code-editor", workingDir: "/workspace/apps/code-editor", manifest: await loadManifest(join(companionDir, "berth.yml")) },
    ],
    docker,
  });

  try {
    const wroteBoth = await waitFor(async () => {
      const logs = (await multiRunning.container.logs({ stdout: true, stderr: true })).toString("utf-8");
      return logs.includes("wrote /workspace/apps/filesystem/.berth") && logs.includes("wrote /workspace/apps/code-editor/.berth");
    }, 60000);
    check("both apps wrote a capability policy", wroteBoth, "at least one .berth was not writable — check the logs for EROFS");
  } finally {
    await stopContainer(multiRunning.container).catch(() => {});
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} check(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("All dev workspace mount checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
