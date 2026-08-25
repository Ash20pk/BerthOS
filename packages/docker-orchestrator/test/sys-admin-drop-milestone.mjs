#!/usr/bin/env node
// BUILD_PLAN M1.1: a booted sandbox carries no container-wide CAP_SYS_ADMIN.
// The /context FUSE mount is performed by a per-sandbox sidecar container
// and propagates in as a bind (docs/internal/design/sys-admin-drop.md), so:
//
//   Sidecar boot:
//     1. `docker inspect` on the sandbox: no SYS_ADMIN in CapAdd, no
//        /dev/fuse device, no apparmor:unconfined — while the sidecar
//        holds exactly those, scoped to one daemon;
//     2. /context is a live FUSE mount inside the sandbox, and writable
//        through the propagated mount (a mount that isn't there would make
//        1 vacuous);
//     3. **negative control:** `docker exec` mount(2) inside the sandbox —
//        as root — fails with EPERM. The kernel, not configuration, refuses.
//
//   Legacy control boot (BERTH_DISABLE_FS_SIDECAR=1):
//     4. the same inspect shows SYS_ADMIN and the same mount(2) SUCCEEDS —
//        proving 1 and 3 can fail, and that the documented fallback posture
//        is exactly the pre-M1.1 one.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import Docker from "dockerode";
import { buildImage, startContainer, stopContainer, sidecarName } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const IMAGE_TAG = "berth/filesystem-sysadmin-drop:dev";
const CONTAINER_NAME = "berth-sys-admin-drop-milestone";

let failures = 0;
function check(what, ok, extra) {
  if (ok) console.log(`  PASS  ${what}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${what}${extra ? ` — ${extra}` : ""}`);
  }
}

async function execCapture(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const { ExitCode } = await exec.inspect();
  return { output: Buffer.concat(chunks).toString("utf-8"), exitCode: ExitCode };
}

async function boot(docker, runDir, disableSidecar) {
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));
  if (disableSidecar) process.env.BERTH_DISABLE_FS_SIDECAR = "1";
  else delete process.env.BERTH_DISABLE_FS_SIDECAR;
  try {
    return await startContainer({
      image: IMAGE_TAG,
      name: CONTAINER_NAME,
      manifest,
      bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
      workingDir: "/workspace/apps/filesystem",
      env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" },
      secretsRunDir: runDir,
      docker,
    });
  } finally {
    delete process.env.BERTH_DISABLE_FS_SIDECAR;
  }
}

async function teardown(docker, running, runDir) {
  await stopContainer(running.container, { secretsRunDir: runDir, docker }).catch(() => {});
  await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
  await docker.getContainer(sidecarName(CONTAINER_NAME)).remove({ force: true }).catch(() => {});
}

async function main() {
  const docker = new Docker();
  // Under the repo (hence $HOME): a Colima VM mounts $HOME but not
  // /var/folders, and a bind the VM can't see is created as an empty dir.
  await mkdir(join(REPO_ROOT, ".berth"), { recursive: true });
  const runDir = await mkdtemp(join(REPO_ROOT, ".berth", "sys-admin-drop-run-"));

  console.log("--- Building apps/filesystem's dev image ---");
  await buildImage({ appDir: APP_DIR, tag: IMAGE_TAG, target: "dev", docker });
  await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
  await docker.getContainer(sidecarName(CONTAINER_NAME)).remove({ force: true }).catch(() => {});

  console.log("\n=== Sidecar boot (the new default) ===");
  const running = await boot(docker, runDir, false);
  try {
    const inspect = await running.container.inspect();
    const capAdd = inspect.HostConfig?.CapAdd ?? [];
    const devices = inspect.HostConfig?.Devices ?? [];
    const secOpt = inspect.HostConfig?.SecurityOpt ?? [];
    console.log("\n--- 1: the sandbox's docker inspect is clean ---");
    check("no SYS_ADMIN in CapAdd", !capAdd.includes("SYS_ADMIN"), `CapAdd was ${JSON.stringify(capAdd)}`);
    check("no /dev/fuse device", !devices.some((d) => d.PathInContainer === "/dev/fuse"), JSON.stringify(devices));
    check("no apparmor:unconfined", !secOpt.some((o) => String(o).includes("apparmor:unconfined")), JSON.stringify(secOpt));

    const sidecarInspect = await docker.getContainer(sidecarName(CONTAINER_NAME)).inspect();
    check(
      "the privilege lives in the sidecar instead (SYS_ADMIN, one process)",
      (sidecarInspect.HostConfig?.CapAdd ?? []).includes("SYS_ADMIN") && sidecarInspect.Config.Entrypoint?.[0] === "/usr/local/bin/semantic-fs-daemon",
    );

    console.log("\n--- 2: /context is a live, writable FUSE mount in the sandbox ---");
    const mounts = await execCapture(running.container, ["sh", "-c", "grep ' /context fuse' /proc/mounts"]);
    check("/context appears as a fuse mount", mounts.exitCode === 0, mounts.output.slice(0, 200));
    const write = await execCapture(running.container, [
      "sh",
      "-c",
      "echo m11-payload > /context/m11-probe.txt && cat /context/m11-probe.txt",
    ]);
    check("a write through the propagated mount round-trips", write.exitCode === 0 && write.output.includes("m11-payload"), write.output.slice(0, 200));

    console.log("\n--- 3: negative control — mount(2) inside the sandbox fails, even as root ---");
    const mountAttempt = await execCapture(running.container, ["sh", "-c", "mkdir -p /tmp/m11 && mount -t tmpfs none /tmp/m11"]);
    check("mount(2) refused", mountAttempt.exitCode !== 0, `exit ${mountAttempt.exitCode}: ${mountAttempt.output.slice(0, 120)}`);
  } finally {
    await teardown(docker, running, runDir);
  }

  console.log("\n=== Legacy control boot (BERTH_DISABLE_FS_SIDECAR=1) ===");
  const legacy = await boot(docker, runDir, true);
  try {
    const inspect = await legacy.container.inspect();
    console.log("\n--- 4: the fallback posture is the honest pre-M1.1 one — proving 1 and 3 can fail ---");
    check("SYS_ADMIN present in the legacy boot", (inspect.HostConfig?.CapAdd ?? []).includes("SYS_ADMIN"));
    const mountAttempt = await execCapture(legacy.container, ["sh", "-c", "mkdir -p /tmp/m11 && mount -t tmpfs none /tmp/m11"]);
    check("the same mount(2) SUCCEEDS with the capability back", mountAttempt.exitCode === 0, `exit ${mountAttempt.exitCode}: ${mountAttempt.output.slice(0, 120)}`);
    // The in-sandbox daemon mounts asynchronously after boot — poll rather
    // than read once (the sidecar path has no such race: its mount exists
    // before the sandbox is even created).
    let legacyMounted = false;
    for (let i = 0; i < 40 && !legacyMounted; i++) {
      const mounts = await execCapture(legacy.container, ["sh", "-c", "grep ' /context fuse' /proc/mounts"]);
      legacyMounted = mounts.exitCode === 0;
      if (!legacyMounted) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check("/context still mounts on the legacy path (in-sandbox daemon)", legacyMounted);
  } finally {
    await teardown(docker, legacy, runDir);
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll SYS_ADMIN-drop checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
