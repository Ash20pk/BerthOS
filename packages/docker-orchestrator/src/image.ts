import Docker from "dockerode";
import tarFs from "tar-fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, cp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
/** packages/docker-orchestrator/docker — shipped alongside dist/ via the package's "files" field. */
const DOCKER_ASSETS_DIR = join(__dirname, "..", "docker");
/** packages/context-bus-daemon — a sibling workspace package, staged into every build context so base.Dockerfile's builder stage can compile it. */
const CONTEXT_BUS_DAEMON_DIR = join(__dirname, "..", "..", "context-bus-daemon");
/** packages/agent-init — same reasoning as CONTEXT_BUS_DAEMON_DIR. */
const AGENT_INIT_DIR = join(__dirname, "..", "..", "agent-init");
/** packages/semantic-fs-daemon — same reasoning as CONTEXT_BUS_DAEMON_DIR. */
const SEMANTIC_FS_DAEMON_DIR = join(__dirname, "..", "..", "semantic-fs-daemon");

export type BuildTarget = "dev" | "production";

export interface BuildImageOptions {
  /** Directory containing the resident app's berth.yml, package.json, and source. */
  appDir: string;
  /** Image tag, e.g. "berth/github-assistant:dev" or "berth/github-assistant:1.0.0". */
  tag: string;
  target: BuildTarget;
  /**
   * Companion apps for a multi-app-per-sandbox build — staged into
   * `apps/<name>/` subdirectories instead of the single-app flattened root.
   * Requires `appName` (the primary's own name, for its own apps/<name>/
   * subdirectory). Omitted (or empty) preserves today's single-app layout
   * exactly.
   */
  companions?: { name: string; appDir: string }[];
  /** The primary app's own name — only needed when `companions` is non-empty. */
  appName?: string;
  docker?: Docker;
}

function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Materializes a real (non-symlinked-outside) node_modules for the
 * production image. A dev image relies on a bind mount plus the host's own
 * pnpm-managed node_modules, so it never needs this — but a production image
 * has no bind mount, so anything resolved via a pnpm workspace's relative
 * symlinks (e.g. `@berth/sdk -> ../../../../packages/sdk`) would dangle once
 * copied in isolation. `pnpm deploy --legacy` is pnpm's own mechanism for
 * producing a fully self-contained package directory from a workspace
 * member — every dependency copied for real, nothing outside the target
 * directory. Standalone (non-workspace) apps just get a normal prod install.
 */
async function stageProductionSource(appDir: string, stagingDir: string): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(appDir);

  if (workspaceRoot) {
    const pkgJson = JSON.parse(await readFile(join(appDir, "package.json"), "utf-8")) as { name: string };
    await execFileAsync("pnpm", ["--filter", pkgJson.name, "deploy", "--prod", "--legacy", stagingDir], {
      cwd: workspaceRoot,
    });
    return;
  }

  await cp(appDir, stagingDir, {
    recursive: true,
    filter: (src) => !src.includes(join(appDir, "node_modules")),
  });
  try {
    await execFileAsync("pnpm", ["install", "--prod"], { cwd: stagingDir });
  } catch {
    await execFileAsync("npm", ["install", "--omit=dev"], { cwd: stagingDir });
  }
}

/**
 * Builds the Alpine "OS stand-in" image for a resident app. The shared
 * base.Dockerfile (Chromium/Xvfb/x11vnc/tini) lives in this package, not the
 * app's own directory, so we stage a temp build context that combines the
 * app's source with this package's docker/ assets before handing it to the
 * Docker daemon as a tarball.
 */
export async function buildImage(options: BuildImageOptions): Promise<void> {
  const docker = options.docker ?? new Docker();
  const stagingDir = await mkdtemp(join(tmpdir(), "berth-build-"));

  try {
    if (options.target === "production") {
      // Multi-app builds stage each app (primary + companions) into its own
      // apps/<name>/ subdirectory instead of flattening one app's source
      // into the staging root — `entrypoint.sh`'s multi-app branch expects
      // each app under /app/apps/<name>. Dev builds never need this: source
      // arrives via a bind mount at container start (this staged copy is
      // never COPY'd into the dev Dockerfile stage at all), so companions is
      // simply ignored there.
      if (options.companions && options.companions.length > 0) {
        if (!options.appName) throw new Error("buildImage: appName is required when companions is non-empty");
        await stageProductionSource(options.appDir, join(stagingDir, "apps", options.appName));
        for (const companion of options.companions) {
          await stageProductionSource(companion.appDir, join(stagingDir, "apps", companion.name));
        }
      } else {
        await stageProductionSource(options.appDir, stagingDir);
      }
    } else {
      await cp(options.appDir, stagingDir, {
        recursive: true,
        filter: (src) => !src.includes(join(options.appDir, "node_modules")),
      });
    }

    await cp(DOCKER_ASSETS_DIR, join(stagingDir, "docker"), { recursive: true });
    await cp(CONTEXT_BUS_DAEMON_DIR, join(stagingDir, "context-bus-daemon"), {
      recursive: true,
      // target/ is Cargo's build output — large, and rebuilt fresh inside
      // the Docker builder stage anyway, so there's no reason to ship it.
      filter: (src) => !src.includes(join(CONTEXT_BUS_DAEMON_DIR, "target")),
    });
    await cp(AGENT_INIT_DIR, join(stagingDir, "agent-init"), {
      recursive: true,
      filter: (src) => !src.includes(join(AGENT_INIT_DIR, "target")),
    });
    await cp(SEMANTIC_FS_DAEMON_DIR, join(stagingDir, "semantic-fs-daemon"), { recursive: true });

    const dockerfileContents = await readFile(join(DOCKER_ASSETS_DIR, "base.Dockerfile"), "utf-8");
    await writeFile(join(stagingDir, "Dockerfile"), dockerfileContents);

    const tarStream = tarFs.pack(stagingDir);
    const buildStream = await docker.buildImage(tarStream, {
      t: options.tag,
      target: options.target,
    });

    await new Promise<void>((resolve, reject) => {
      // A failed RUN step doesn't always surface through followProgress's
      // own completion callback as `err` — the daemon can report it as a
      // per-event `error` field mid-stream instead, with the stream then
      // ending "successfully" from followProgress's point of view. Track
      // any such event ourselves so a broken build never gets reported as
      // having produced a usable image.
      let buildError: string | undefined;
      docker.modem.followProgress(
        buildStream,
        (err: Error | null) => {
          if (err) reject(err);
          else if (buildError) reject(new Error(buildError));
          else resolve();
        },
        (event: { stream?: string; error?: string }) => {
          if (event.error) {
            buildError = event.error;
            console.error(`[berth:build] ${event.error}`);
          } else if (event.stream) {
            process.stderr.write(`[berth:build] ${event.stream}`);
          }
        },
      );
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
