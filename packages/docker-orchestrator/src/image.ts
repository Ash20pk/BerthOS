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

export type BuildTarget = "dev" | "production";

export interface BuildImageOptions {
  /** Directory containing the resident app's berth.yml, package.json, and source. */
  appDir: string;
  /** Image tag, e.g. "berth/github-assistant:dev" or "berth/github-assistant:1.0.0". */
  tag: string;
  target: BuildTarget;
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
      await stageProductionSource(options.appDir, stagingDir);
    } else {
      await cp(options.appDir, stagingDir, {
        recursive: true,
        filter: (src) => !src.includes(join(options.appDir, "node_modules")),
      });
    }

    await cp(DOCKER_ASSETS_DIR, join(stagingDir, "docker"), { recursive: true });

    const dockerfileContents = await readFile(join(DOCKER_ASSETS_DIR, "base.Dockerfile"), "utf-8");
    await writeFile(join(stagingDir, "Dockerfile"), dockerfileContents);

    const tarStream = tarFs.pack(stagingDir);
    const buildStream = await docker.buildImage(tarStream, {
      t: options.tag,
      target: options.target,
    });

    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        buildStream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: { stream?: string; error?: string }) => {
          if (event.error) console.error(`[berth:build] ${event.error}`);
          else if (event.stream) process.stderr.write(`[berth:build] ${event.stream}`);
        },
      );
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
