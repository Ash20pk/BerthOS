import Docker from "dockerode";
import { startContainer, type RunningContainer } from "@berth/docker-orchestrator";
import type { BerthManifest } from "@berth/manifest-schema";
import { buildDevImage, devImageTag } from "./build.js";
import { resolveDevBindMount, devStatePath } from "./workspace.js";
import type { AppSpec } from "./multi-app.js";

export interface BootDevContainerOptions {
  appDir: string;
  manifest: BerthManifest;
  /** Primary app first, companions after — exactly what resolveApps() returns. */
  apps: AppSpec[];
  docker: Docker;
  /** Defaults to `berth-dev-<app>`, which is also what `berth mcp` looks for. */
  containerName?: string;
  grantsServerUrl?: string;
  meshCoordinatorUrl?: string;
  /**
   * Where progress lines go. `berth dev` sends them to stdout; `berth mcp`
   * MUST send them to stderr, because its stdout *is* the MCP transport and a
   * stray human-readable line there is a protocol framing error, not a log.
   */
  log: (message: string) => void;
}

/**
 * Builds the dev image and starts the container the way `berth dev` does:
 * the read-only workspace mount with writable holes carved back into it
 * (resolveDevBindMount), one named `.berth` volume per app for the generated
 * capability policy, and BERTH_WORKSPACE_ROOT pointing at the shared writable
 * app-data directory.
 *
 * Extracted from `berth dev` so `berth mcp` can boot its own container rather
 * than requiring a second terminal. That two-step ("run `berth dev` over
 * here, then point your MCP client at `berth mcp` over there") is the thing
 * that made the MCP path a poor front door: an MCP client spawns exactly one
 * command and has nowhere to put the other one.
 *
 * Deliberately *not* extracted: the file watcher, log tailing, port/credential
 * diagnostics, and signal handling. Those are `berth dev`'s interactive shell,
 * and a bridge process wants none of them.
 */
export async function bootDevContainer(options: BootDevContainerOptions): Promise<RunningContainer> {
  const { appDir, manifest, apps, docker, log } = options;
  const companions = apps.slice(1);

  log(`Building dev image for "${manifest.name}"...`);
  await buildDevImage(appDir, manifest, companions);

  const { bindMount, extraBinds, workingDir, workspaceRoot } = resolveDevBindMount(
    appDir,
    companions.map((a) => ({ appDir: a.appDir, relPath: a.relPath })),
  );

  const volumeName = `berth-${manifest.name}-app-state`;
  await docker.createVolume({ Name: volumeName }).catch(() => {
    /* already exists */
  });
  for (const companion of companions) {
    const companionVolume = `berth-${manifest.name}-${companion.name}-app-state`;
    await docker.createVolume({ Name: companionVolume }).catch(() => {
      /* already exists */
    });
    extraBinds.push(`${companionVolume}:${devStatePath("/workspace", companion.relPath)}`);
  }

  return startContainer({
    image: devImageTag(manifest),
    name: options.containerName ?? `berth-dev-${manifest.name}`,
    manifest,
    bindMount,
    extraBinds,
    workingDir,
    appStateVolume: volumeName,
    apps:
      apps.length > 1
        ? apps.map((a) => ({ name: a.name, workingDir: `/workspace/${a.relPath}`, manifest: a.manifest }))
        : undefined,
    env: {
      BERTH_WORKSPACE_ROOT: workspaceRoot,
      ...(options.grantsServerUrl ? { BERTH_GRANTS_SERVER_URL: options.grantsServerUrl } : {}),
    },
    meshCoordinatorUrl: options.meshCoordinatorUrl,
    docker,
  });
}
