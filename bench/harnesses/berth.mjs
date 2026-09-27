// Harness adapter: Berth, in its shipped configuration — and, as the
// benchmark's positive control, Berth with its kernel tier deliberately
// switched off.
//
// The probe does NOT run via `docker exec`. It runs inside the app's own
// process, reached over the app's RPC socket, because that process is the one
// agent-init applied the Landlock domain, the seccomp filter and the uid drop
// to. Probing by exec would produce escapes no agent could actually perform,
// and would make this column meaningless.
//
// Two apps boot in one sandbox (bench-probe-a and bench-probe-b) so the
// co-tenancy rows have a real neighbour to fail to reach.

import Docker from "dockerode";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest } from "@berthos/manifest-schema";
import { buildImage, startContainer, stopContainer, invokeAppExport, gatherBootEvidence } from "@berthos/docker-orchestrator";
import { describePorts, probeControlPlane } from "./docker.mjs";

const IMAGE_TAG = "berth/bench-probe:dev";
const CONTAINER_NAME = "berth-bench-berth";
const APP_A = "bench-probe-a";
const APP_B = "bench-probe-b";

/**
 * The weakening, expressed only through knobs that already ship — nothing
 * invented for the benchmark:
 *
 *   BERTH_DISABLE_FS_SIDECAR=1  restores the pre-M1.1 posture: CAP_SYS_ADMIN,
 *                               /dev/fuse and apparmor:unconfined back on the
 *                               sandbox (container.ts's documented fallback).
 *   seccomp profile             ENOSYSes the three landlock syscalls — the
 *                               same profile attestation-milestone.mjs uses to
 *                               make an enforcing kernel behave like Docker
 *                               Desktop's.
 *
 * Together they take the kernel tier away while leaving everything else — the
 * per-app uids, the secrets model, the socket directory modes — in place. The
 * rows that flip are exactly the rows Landlock and seccomp were carrying,
 * which is what a positive control is for.
 */
const NO_LANDLOCK_SECCOMP = JSON.stringify({
  defaultAction: "SCMP_ACT_ALLOW",
  syscalls: [{ names: ["landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self"], action: "SCMP_ACT_ERRNO", errnoRet: 38 }],
});

function makeHarness({ id, title, description, weakened }) {
  return {
    id,
    title,
    description,
    async run({ repoRoot, hostEndpoint, secretValue, log }) {
      const docker = new Docker();
      const appADir = join(repoRoot, "bench", "fixtures", APP_A);
      const appBDir = join(repoRoot, "bench", "fixtures", APP_B);
      const containerAppADir = `/workspace/bench/fixtures/${APP_A}`;
      const containerAppBDir = `/workspace/bench/fixtures/${APP_B}`;
      const devWorkspaceHost = join(repoRoot, ".berth", "dev-workspace");
      const devWorkspace = "/workspace/.berth/dev-workspace";
      const runDir = join(repoRoot, ".berth", `bench-run-${id}`);

      // Both apps' data directories must exist on the host before boot:
      // entrypoint.sh's grant_dev_workspace chgrps them to `berth` and makes
      // them group-writable, which is what leaves Landlock as the ONLY thing
      // that can refuse the cross-app write. Without this the co-tenancy rows
      // would pass on DAC and prove nothing about the kernel tier.
      for (const app of [APP_A, APP_B]) await mkdir(join(devWorkspaceHost, app), { recursive: true });
      await writeFile(join(devWorkspaceHost, APP_B, "sibling-owned.txt"), "the co-tenant's data\n");
      await mkdir(runDir, { recursive: true });
      await chmod(runDir, 0o700);

      const manifestA = await loadManifest(join(appADir, "berth.yml"));
      const manifestB = await loadManifest(join(appBDir, "berth.yml"));

      log("building the bench-probe image");
      await buildImage({ appDir: appADir, tag: IMAGE_TAG, target: "dev", docker });
      await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});

      const previousSidecarFlag = process.env.BERTH_DISABLE_FS_SIDECAR;
      if (weakened) process.env.BERTH_DISABLE_FS_SIDECAR = "1";

      log(`booting ${weakened ? "the deliberately weakened" : "the shipped"} configuration`);
      let running;
      try {
        running = await startContainer({
          image: IMAGE_TAG,
          name: CONTAINER_NAME,
          manifest: manifestA,
          bindMount: { hostPath: repoRoot, containerPath: "/workspace" },
          extraBinds: [`${devWorkspaceHost}:${devWorkspace}`],
          workingDir: containerAppADir,
          env: {
            BERTH_WORKSPACE_ROOT: devWorkspace,
            // Relative, so it resolves against each app's own cwd (run_app
            // cds into the app dir). Lets the fixtures be plain JS with no
            // build step — the default entry is <appdir>/dist/index.js.
            BERTH_APP_ENTRY: "src/index.js",
            BENCH_DATA_DIR: `${devWorkspace}/${APP_A}`,
            BENCH_SIBLING_DIR: `${devWorkspace}/${APP_B}`,
            BENCH_SIBLING_SOCKET: `/run/berth/${APP_B}/rpc.sock`,
            // App B's per-app secrets file: 0600, owned by B's uid (M1.3).
            BENCH_FOREIGN_SECRET_PATH: `/run/berth/secrets.${APP_B}.env`,
            ...(hostEndpoint ? { BENCH_HOST_ENDPOINT: hostEndpoint } : {}),
            // Declared in each app's berth.yml `secrets:`, so each reaches
            // exactly one app — the thing the foreign-secret row tests.
            BENCH_SECRET_A: secretValue,
            BENCH_SECRET_B: secretValue,
            ...(weakened ? { BERTH_DISABLE_FS_SIDECAR: "1" } : {}),
          },
          apps: [
            { name: APP_A, workingDir: containerAppADir, manifest: manifestA },
            { name: APP_B, workingDir: containerAppBDir, manifest: manifestB },
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

      try {
        log("waiting for both apps to be ready");
        await waitForApps(running.container);

        log("running the probe inside the app's own restricted process");
        const response = await invokeAppExport(running.container, APP_A, { export: "run_probe", input: {} }, { docker, timeoutMs: 120000 });
        if (response.error || !response.result?.json) throw new Error(`run_probe failed: ${response.error ?? JSON.stringify(response)}`);
        const probeResults = JSON.parse(response.result.json);

        // --- host-side observations -----------------------------------------
        const info = await running.container.inspect();
        const envStrings = info.Config?.Env ?? [];
        const secretInEnv = envStrings.some((e) => e.includes(secretValue));
        const observations = {
          "secret-in-metadata": secretInEnv
            ? { outcome: "escaped", detail: "the secret is readable in `docker inspect` Config.Env" }
            : { outcome: "contained", detail: "the secret is absent from container metadata — delivered through a 0600 file bind, not Env" },
          "published-port-exposure": describePorts(info),
          // Berth loses this row by construction, and the table says so
          // rather than omitting the row — see docs/threat-model.md on the
          // `docker exec` bypass.
          "control-plane-exec": await probeControlPlane(docker, running.container),
        };

        // The M2.1 payoff: record whether the kernel tier was actually live
        // for this run, measured rather than assumed. A Berth column scored on
        // a host where nothing enforces has to say so.
        let enforcement;
        try {
          const evidence = await gatherBootEvidence(docker, CONTAINER_NAME, IMAGE_TAG);
          enforcement = {
            doctorProbe: evidence.doctorProbe,
            rulesetReports: evidence.rulesetReports,
            bootId: evidence.bootId,
            imageDigest: evidence.imageDigest,
            policies: evidence.policies,
          };
        } catch (err) {
          enforcement = { error: `could not gather boot evidence: ${err.message}` };
        }

        return {
          probeResults,
          observations,
          meta: {
            image: IMAGE_TAG,
            apps: [APP_A, APP_B],
            weakened: Boolean(weakened),
            ...(weakened ? { weakenedBy: ["BERTH_DISABLE_FS_SIDECAR=1", "seccomp profile ENOSYSing the landlock syscalls"] } : {}),
            enforcement,
          },
        };
      } finally {
        await stopContainer(running.container, { secretsRunDir: runDir, docker }).catch(() => {});
        await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});
      }
    },
  };
}

/** Both apps have to be serving before the co-tenancy rows mean anything. */
async function waitForApps(container, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = Buffer.from(await container.logs({ stdout: true, stderr: true, follow: false, tail: 5000 })).toString("utf-8");
    if (logs.includes(`"${APP_A}" ready`) && logs.includes(`"${APP_B}" ready`)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = Buffer.from(await container.logs({ stdout: true, stderr: true, follow: false, tail: 40 })).toString("utf-8");
  throw new Error(`timed out waiting for both bench-probe apps to report ready. Last container output:\n${logs}`);
}

export const harness = makeHarness({
  id: "berth",
  title: "Berth (as shipped)",
  description: "`berth dev`'s posture: capabilities from berth.yml compiled into a Landlock domain + seccomp filter, per-app uids, secrets via a 0600 file.",
});

export const weakenedHarness = makeHarness({
  id: "berth-weakened",
  title: "Berth (deliberately weakened — positive control)",
  description: "The same Berth with its kernel tier switched off: BERTH_DISABLE_FS_SIDECAR=1 plus a seccomp profile that ENOSYSes the landlock syscalls.",
  weakened: true,
});
