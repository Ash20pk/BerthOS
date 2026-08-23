// The break-out box, as a module: boot it, submit attempts, read the flags.
//
// The server and the verification test both drive this file, so what a
// challenger faces and what the test proves cannot drift apart — a box whose
// test boots a different configuration than the public endpoint would be
// evidence of nothing.
//
// Two flags, protected by two different tiers of the shipped enforcement:
//
//   FLAG_KERNEL     a world-readable file at /var/breakout/flag-kernel.txt.
//                   Mode 0644 on purpose: ordinary Unix permissions allow the
//                   read, so ONLY the Landlock domain compiled from
//                   breakout-target's berth.yml stands between a submission
//                   and the flag. If the kernel tier is not doing its job,
//                   this flag leaves the box.
//
//   FLAG_COTENANT   delivered to the co-tenant app as a per-app secret
//                   (M1.3), landing in a 0600 file owned by that app's uid.
//                   Protected by the uid split, not by Landlock.
//
// Nothing here hardens the box beyond what `berth dev` gives any app. That is
// the BUILD_PLAN M2.3 constraint and it is load-bearing: a box with special
// protections would prove something about the box instead of about Berth.

import Docker from "dockerode";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer, invokeAppExport, gatherBootEvidence } from "@berth/docker-orchestrator";

export const TARGET_APP = "breakout-target";
export const KEEPER_APP = "flag-keeper";
export const IMAGE_TAG = "berth/breakout-box:dev";
export const CONTAINER_NAME = "berth-breakout-box";

/** Where the kernel-tier flag is mounted inside the sandbox. Declared by no app. */
export const FLAG_KERNEL_PATH = "/var/breakout/flag-kernel.txt";
/** Where per-app secret scoping puts the co-tenant flag. */
export const FLAG_COTENANT_PATH = `/run/berth/secrets.${KEEPER_APP}.env`;

export function mintFlags() {
  return {
    kernel: `berth{kernel-tier-${randomBytes(16).toString("hex")}}`,
    cotenant: `berth{co-tenant-${randomBytes(16).toString("hex")}}`,
  };
}

/**
 * Boots the box.
 *
 * `weakened` exists for the verification test's negative control only: it
 * switches off the same kernel tier the bench's positive control does, so the
 * test can prove the flags ARE reachable when enforcement is absent. A box
 * whose flag survives because of a filesystem accident rather than because of
 * Landlock would look identical from outside without this.
 */
export async function bootBox({ repoRoot, flags, weakened = false, containerName = CONTAINER_NAME, log = () => {} }) {
  const docker = new Docker();
  const targetDir = join(repoRoot, "breakout", "apps", TARGET_APP);
  const keeperDir = join(repoRoot, "breakout", "apps", KEEPER_APP);
  const containerTargetDir = `/workspace/breakout/apps/${TARGET_APP}`;
  const containerKeeperDir = `/workspace/breakout/apps/${KEEPER_APP}`;
  const devWorkspaceHost = join(repoRoot, ".berth", "dev-workspace");
  const devWorkspace = "/workspace/.berth/dev-workspace";
  const stateDir = join(repoRoot, "breakout", "state");
  const flagDirHost = join(stateDir, `flags-${containerName}`);
  const runDir = join(stateDir, `run-${containerName}`);

  for (const app of [TARGET_APP, KEEPER_APP]) await mkdir(join(devWorkspaceHost, app), { recursive: true });
  await mkdir(flagDirHost, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await chmod(runDir, 0o700);

  // 0644: the flag is readable by anyone at the DAC layer, so a refusal can
  // only come from the capability policy. Making it 0600 root-owned would be
  // a stronger-looking box and a weaker proof.
  const flagFileHost = join(flagDirHost, "flag-kernel.txt");
  await writeFile(flagFileHost, `${flags.kernel}\n`);
  await chmod(flagFileHost, 0o644);

  const targetManifest = await loadManifest(join(targetDir, "berth.yml"));
  const keeperManifest = await loadManifest(join(keeperDir, "berth.yml"));

  log("building the box image");
  await buildImage({ appDir: targetDir, tag: IMAGE_TAG, target: "dev", docker });
  await docker.getContainer(containerName).remove({ force: true }).catch(() => {});

  const previousSidecarFlag = process.env.BERTH_DISABLE_FS_SIDECAR;
  if (weakened) process.env.BERTH_DISABLE_FS_SIDECAR = "1";

  log(`booting ${weakened ? "a DELIBERATELY WEAKENED box (negative control)" : "the box"}`);
  let running;
  try {
    running = await startContainer({
      image: IMAGE_TAG,
      name: containerName,
      manifest: targetManifest,
      bindMount: { hostPath: repoRoot, containerPath: "/workspace" },
      extraBinds: [`${devWorkspaceHost}:${devWorkspace}`, `${flagDirHost}:/var/breakout:ro`],
      workingDir: containerTargetDir,
      env: {
        BERTH_WORKSPACE_ROOT: devWorkspace,
        BERTH_APP_ENTRY: "src/index.js",
        // Declared by flag-keeper's berth.yml `secrets:`, so per-app scoping
        // delivers it to that app alone.
        BREAKOUT_FLAG_COTENANT: flags.cotenant,
        ...(weakened ? { BERTH_DISABLE_FS_SIDECAR: "1" } : {}),
      },
      apps: [
        { name: TARGET_APP, workingDir: containerTargetDir, manifest: targetManifest },
        { name: KEEPER_APP, workingDir: containerKeeperDir, manifest: keeperManifest },
      ],
      ...(weakened ? { extraSecurityOpt: [`seccomp=${NO_LANDLOCK_SECCOMP}`] } : {}),
      secretsRunDir: runDir,
      docker,
    });
  } finally {
    if (weakened) {
      if (previousSidecarFlag === undefined) delete process.env.BERTH_DISABLE_FS_SIDECAR;
      else process.env.BERTH_DISABLE_FS_SIDECAR = previousSidecarFlag;
    }
  }

  await waitForApps(running.container, log);

  return {
    docker,
    container: running.container,
    containerName,
    async attempt(code, timeoutMs = 30000) {
      const response = await invokeAppExport(running.container, TARGET_APP, { export: "attempt", input: { code } }, { docker, timeoutMs });
      if (response.error) return { ok: false, output: `the box could not run this attempt: ${response.error}` };
      return response.result;
    },
    async enforcement() {
      try {
        const evidence = await gatherBootEvidence(docker, containerName, IMAGE_TAG);
        return { doctorProbe: evidence.doctorProbe, rulesetReports: evidence.rulesetReports, bootId: evidence.bootId, imageDigest: evidence.imageDigest };
      } catch (err) {
        return { error: err.message };
      }
    },
    async stop() {
      await stopContainer(running.container, { secretsRunDir: runDir, docker }).catch(() => {});
      await docker.getContainer(containerName).remove({ force: true }).catch(() => {});
      await rm(flagDirHost, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** The same profile the benchmark's positive control uses. Negative-control only. */
const NO_LANDLOCK_SECCOMP = JSON.stringify({
  defaultAction: "SCMP_ACT_ALLOW",
  syscalls: [{ names: ["landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self"], action: "SCMP_ACT_ERRNO", errnoRet: 38 }],
});

async function waitForApps(container, log, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  log("waiting for both apps to be ready");
  while (Date.now() < deadline) {
    const logs = Buffer.from(await container.logs({ stdout: true, stderr: true, follow: false, tail: 5000 })).toString("utf-8");
    if (logs.includes(`"${TARGET_APP}" ready`) && logs.includes(`"${KEEPER_APP}" ready`)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = Buffer.from(await container.logs({ stdout: true, stderr: true, follow: false, tail: 40 })).toString("utf-8");
  throw new Error(`timed out waiting for the box's apps. Last output:\n${logs}`);
}

/**
 * Did this attempt's output contain a flag? Checked on the host, against the
 * live values, rather than by asking the submission to say so.
 */
export function detectCapture(output, flags) {
  const captured = [];
  if (output.includes(flags.kernel)) captured.push("FLAG_KERNEL");
  if (output.includes(flags.cotenant)) captured.push("FLAG_COTENANT");
  return captured;
}
