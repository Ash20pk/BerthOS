#!/usr/bin/env node
// BUILD_PLAN M1.3: a secret an app declares under `secrets:` in berth.yml
// reaches THAT app and no sibling — by env, by /proc/<pid>/environ, and by
// the per-app file's DAC. Two boots of the same two-app container:
//
//   Enforced boot — boundary-app-a declares BOUNDARY_A_API_TOKEN:
//     1. the token is not in `docker inspect` Env (5.5 still holds);
//     2. the shared secrets file does not contain the declared name — an
//        undeclared secret (SHARED_FAKE_TOKEN) stays shared, for compat;
//     3. app A's real process environment has the token; app B's does not
//        (both read as root from /proc/<pid>/environ);
//     4. as app B's uid, /proc/<pidA>/environ is unreadable (EACCES) and
//        /run/berth/secrets.boundary-app-a.env is unreadable (0600, A's uid);
//     5. as app A's uid, its own staged file IS readable — the positive
//        control, without which 4 would also "pass" for a file nobody can read.
//
//   Control boot — same container, no `secrets:` declaration:
//     6. the token lands in BOTH apps' process environments via the shared
//        file — proving the enforced boot's absence assertions can fail, and
//        that an undeclared boot behaves exactly as before M1.3.
//
// Uses target:"dev" like secrets-milestone.mjs: every boundary here is DAC
// (per-app uids + 0600 files), which Docker Desktop enforces exactly like a
// real Linux host — no assertion below degrades where Landlock is inactive.
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import Docker from "dockerode";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_A_DIR = join(__dirname, "fixtures", "boundary-app-a");
const APP_B_DIR = join(__dirname, "fixtures", "boundary-app-b");
const APP_A_CONTAINER_DIR = "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-a";
const APP_B_CONTAINER_DIR = "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-b";
const IMAGE_TAG = "berth/boundary-app-a:dev";
const CONTAINER_NAME = "berth-per-app-secrets-milestone";
const DEV_WORKSPACE = "/workspace/.berth/dev-workspace";
const DEV_WORKSPACE_HOST_DIR = join(REPO_ROOT, ".berth", "dev-workspace");

// apps[] index -> uid, per entrypoint.sh's export_app_identity.
const UID_A = "10000";
const UID_B = "10001";

let failures = 0;
function check(what, ok, extra) {
  if (ok) console.log(`  PASS  ${what}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${what}${extra ? ` — ${extra}` : ""}`);
  }
}

async function execCapture(container, cmd, user) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, ...(user ? { User: user } : {}) });
  const stream = await exec.start({ hijack: true });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const output = Buffer.concat(chunks).toString("utf-8");
  const { ExitCode } = await exec.inspect();
  return { output, exitCode: ExitCode };
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * Pid of the app runtime, found by process *uid* — each app is the only
 * thing running as its uid. Not by reading /proc/<pid>/environ as root:
 * container root has no CAP_SYS_PTRACE, so another uid's environ is
 * unreadable even to it (a boundary this milestone leans on below).
 */
async function appPid(container, uid) {
  const { output } = await execCapture(container, [
    "sh",
    "-c",
    `for d in /proc/[0-9]*; do [ "$(stat -c %u $d 2>/dev/null)" = "${uid}" ] && echo \${d#/proc/}; done | head -1`,
  ]);
  const m = output.match(/(\d+)/);
  if (!m) throw new Error(`could not find a process running as uid ${uid}`);
  return m[1];
}

/** An app's own view of its environment — read as its own uid, the only uid (bar a ptrace-capable one) that can. */
async function appEnviron(container, uid, pid) {
  const res = await execCapture(container, ["sh", "-c", `tr '\\0' '\\n' < /proc/${pid}/environ`], String(uid));
  if (res.exitCode !== 0) throw new Error(`could not read /proc/${pid}/environ as uid ${uid}: ${res.output}`);
  return res.output;
}

async function bootTwoApps(docker, { declare, env, runDir }) {
  const manifestA = await loadManifest(join(APP_A_DIR, "berth.yml"));
  const manifestB = await loadManifest(join(APP_B_DIR, "berth.yml"));
  // The declaration under test, added here rather than in the fixture's
  // berth.yml so capability-enforcement.mjs's boots stay byte-identical.
  // The schema path is unit-tested in @berth/manifest-schema.
  const declaredA = declare ? { ...manifestA, secrets: ["BOUNDARY_A_API_TOKEN"] } : manifestA;

  return startContainer({
    image: IMAGE_TAG,
    name: CONTAINER_NAME,
    manifest: declaredA,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    extraBinds: [`${DEV_WORKSPACE_HOST_DIR}:${DEV_WORKSPACE}`],
    workingDir: APP_A_CONTAINER_DIR,
    env,
    apps: [
      { name: "boundary-app-a", workingDir: APP_A_CONTAINER_DIR, manifest: declaredA },
      { name: "boundary-app-b", workingDir: APP_B_CONTAINER_DIR, manifest: manifestB },
    ],
    secretsRunDir: runDir,
    docker,
  });
}

async function main() {
  const docker = new Docker();
  // Under the repo (hence $HOME), not os.tmpdir(): a Colima VM mounts $HOME
  // but not /var/folders, and a bind whose host path the VM cannot see is
  // silently created as an empty directory at the mountpoint.
  await mkdir(join(REPO_ROOT, ".berth"), { recursive: true });
  const runDir = await mkdtemp(join(REPO_ROOT, ".berth", "per-app-secrets-run-"));
  const token = `a-secret-${randomBytes(24).toString("hex")}`;
  const sharedToken = `shared-${randomBytes(24).toString("hex")}`;
  const env = {
    BERTH_WORKSPACE_ROOT: DEV_WORKSPACE,
    BOUNDARY_A_API_TOKEN: token,
    SHARED_FAKE_TOKEN: sharedToken,
  };

  console.log("--- Building the boundary fixtures' dev image ---");
  await buildImage({ appDir: APP_A_DIR, tag: IMAGE_TAG, target: "dev", docker });
  await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
  for (const name of ["boundary-app-a", "boundary-app-b"]) {
    await mkdir(join(DEV_WORKSPACE_HOST_DIR, name), { recursive: true });
  }

  console.log("\n=== Enforced boot: boundary-app-a declares secrets: [BOUNDARY_A_API_TOKEN] ===");
  const running = await bootTwoApps(docker, { declare: true, env, runDir });
  try {
    try {
      await waitFor(async () => {
        try {
          await appPid(running.container, UID_A);
          await appPid(running.container, UID_B);
          return true;
        } catch {
          return false;
        }
      }, 30000, "both app runtimes to be running under their own uids");
    } catch (err) {
      const logs = await running.container.logs({ stdout: true, stderr: true, tail: 60 });
      console.error("--- container log ---\n" + logs.toString("utf-8") + "\n--- end log ---");
      throw err;
    }

    const inspect = await running.container.inspect();
    const envBlob = (inspect.Config.Env ?? []).join("\n");
    console.log("\n--- 1: docker inspect carries neither value ---");
    check("declared token not in Env", !envBlob.includes(token));
    check("shared token not in Env either (5.5 unchanged)", !envBlob.includes(sharedToken));

    console.log("\n--- 2: the shared file holds only the undeclared secret ---");
    const shared = await execCapture(running.container, ["cat", "/run/berth/secrets.env"]);
    check("shared secrets file exists (undeclared secret still travels)", shared.exitCode === 0);
    check("declared name absent from the shared file", !shared.output.includes("BOUNDARY_A_API_TOKEN"));
    check("undeclared secret present in the shared file", shared.output.includes(sharedToken));

    const pidA = await appPid(running.container, UID_A);
    const pidB = await appPid(running.container, UID_B);

    console.log("\n--- 3: process environments (each read as that app's own uid) ---");
    const envA = await appEnviron(running.container, UID_A, pidA);
    const envB = await appEnviron(running.container, UID_B, pidB);
    check("app A's environment has its declared secret", envA.includes(`BOUNDARY_A_API_TOKEN=${token}`));
    check("app B's environment does NOT have A's secret", !envB.includes(token), "the declared secret leaked into a sibling's environment");
    check("both apps still see the undeclared shared secret", envA.includes(sharedToken) && envB.includes(sharedToken));

    console.log("\n--- 4: as app B's uid, A's environ and A's file are unreadable ---");
    const bReadsAEnviron = await execCapture(running.container, ["cat", `/proc/${pidA}/environ`], UID_B);
    check("B cannot read /proc/<pidA>/environ", bReadsAEnviron.exitCode !== 0, `exit ${bReadsAEnviron.exitCode}: ${bReadsAEnviron.output.slice(0, 120)}`);
    const rootReadsAEnviron = await execCapture(running.container, ["cat", `/proc/${pidA}/environ`]);
    check("even container root (no CAP_SYS_PTRACE) cannot read A's environ", rootReadsAEnviron.exitCode !== 0);
    const bReadsAFile = await execCapture(running.container, ["cat", "/run/berth/secrets.boundary-app-a.env"], UID_B);
    check("B cannot read A's staged secrets file", bReadsAFile.exitCode !== 0, `exit ${bReadsAFile.exitCode}`);
    const mode = await execCapture(running.container, ["stat", "-c", "%a %u", "/run/berth/secrets.boundary-app-a.env"]);
    check("A's staged file is 0600 owned by A's uid", mode.output.includes(`600 ${UID_A}`), `stat said "${mode.output.trim()}"`);

    console.log("\n--- 5: positive control — A's own uid can read its own file ---");
    const aReadsOwn = await execCapture(running.container, ["cat", "/run/berth/secrets.boundary-app-a.env"], UID_A);
    check("A reads its own staged file", aReadsOwn.exitCode === 0 && aReadsOwn.output.includes(token));
  } finally {
    if (!process.env.BERTH_TEST_KEEP) {
      await stopContainer(running.container, { removeVolumes: true, secretsRunDir: runDir }).catch(() => {});
      await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
    }
  }

  console.log("\n=== Control boot: same container, NO secrets: declaration ===");
  const control = await bootTwoApps(docker, { declare: false, env, runDir });
  try {
    await waitFor(async () => {
      try {
        await appPid(control.container, UID_A);
        await appPid(control.container, UID_B);
        return true;
      } catch {
        return false;
      }
    }, 30000, "both app runtimes (control boot)");
    const pidA = await appPid(control.container, UID_A);
    const pidB = await appPid(control.container, UID_B);
    const envA = await appEnviron(control.container, UID_A, pidA);
    const envB = await appEnviron(control.container, UID_B, pidB);
    console.log("\n--- 6: without a declaration, the token reaches BOTH apps (pre-M1.3 behavior; proves 3/4 can fail) ---");
    check("app A sees the token via the shared file", envA.includes(token));
    check("app B ALSO sees the token — the enforced boot's isolation is real, not vacuous", envB.includes(token));
    const staged = await execCapture(control.container, ["ls", "/run/berth/secrets.boundary-app-a.env"]);
    check("no per-app staged file exists in an undeclared boot", staged.exitCode !== 0);
  } finally {
    await stopContainer(control.container, { removeVolumes: true, secretsRunDir: runDir }).catch(() => {});
    await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll per-app secret scoping checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
