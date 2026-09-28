import Docker from "dockerode";
import tarFs from "tar-fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, cp, rm, readFile, writeFile, mkdir, chmod, readdir, readlink, realpath } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "@berthos/manifest-schema";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
/** packages/docker-orchestrator/docker — shipped alongside dist/ via the package's "files" field. */
const DOCKER_ASSETS_DIR = join(__dirname, "..", "docker");
/**
 * Where a sandbox daemon's source is, for the builder stages in
 * base.Dockerfile to compile. In this repository it's the sibling package
 * (packages/<daemon>); a published @berthos/docker-orchestrator carries a copy
 * under daemons/ instead (scripts/bundle-daemons.mjs), since npm installs no
 * sibling. The checkout wins when both exist, so local edits to a daemon are
 * what gets built.
 */
export function daemonSourceDir(daemon: string, pkgRoot = join(__dirname, "..")): string {
  const sibling = join(pkgRoot, "..", daemon);
  return existsSync(join(sibling, daemon === "semantic-fs-daemon" ? "go.mod" : "Cargo.toml"))
    ? sibling
    : join(pkgRoot, "daemons", daemon);
}

const CONTEXT_BUS_DAEMON_DIR = daemonSourceDir("context-bus-daemon");
const AGENT_INIT_DIR = daemonSourceDir("agent-init");
const SEMANTIC_FS_DAEMON_DIR = daemonSourceDir("semantic-fs-daemon");
const MESH_DAEMON_DIR = daemonSourceDir("mesh-daemon");

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
   *
   * Dev builds don't stage companion *source* (it arrives via the bind
   * mount) but do read this list, because each companion's `on_install` runs
   * as a build layer there too — see stageDevOnInstallContext().
   */
  companions?: { name: string; appDir: string }[];
  /** The primary app's own name — only needed when `companions` is non-empty, or `forceCompanionLayout` is set. */
  appName?: string;
  /**
   * Stages the primary under `apps/<appName>/` even with zero real
   * companions — used by `berth os up` so a lone app still gets
   * entrypoint.sh's multi-app branch (a per-app RPC socket a separate host
   * process can reconnect to via invokeAppExport, rather than the
   * single-app stdio-only path, which only the process that started the
   * container can attach to). Omitted, a `companions`-less build keeps
   * today's flattened single-app layout exactly.
   */
  forceCompanionLayout?: boolean;
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
 * The pnpm workspace `appDir` is a member of, if any. A pnpm-workspace.yaml in
 * the app's own directory doesn't count: that makes the app its own root, not a
 * member, and `berth init` writes exactly that file into every project it
 * scaffolds (to pre-approve protobufjs's install script). Treating it as a
 * workspace sent every scaffolded app down `pnpm --filter <app> deploy`, which
 * fails for a standalone project, so `berth test` failed on a fresh project.
 */
export function workspaceRootAbove(appDir: string): string | undefined {
  const parent = dirname(appDir);
  return parent === appDir ? undefined : findWorkspaceRoot(parent);
}

/**
 * What never belongs in a build context, whichever of the three copies below
 * is doing the copying.
 *
 * `node_modules` is the obvious one: it's either staged properly by
 * `pnpm deploy` or supplied by a bind mount.
 *
 * `.berth` is the one that bites. It holds per-boot generated state — the
 * compiled capability policy — so copying a previous run's copy into an image
 * is wrong on its own terms. It also *fails*: since apps run as their own uid,
 * `entrypoint.sh` leaves `capability-policy.json` mode 0640 owned by
 * `root:<app>`, and when the app directory is a bind mount that ownership is
 * real on the host. A later host-side build then can't read it, and the whole
 * build dies with `EACCES ... copyfile .berth/capability-policy.json`. Found
 * on Linux CI only: Docker Desktop virtualizes bind-mount ownership, so on a
 * Mac the file comes back readable and nothing looks wrong.
 *
 * Anything the build genuinely needs under `.berth` (the generated
 * `on-install.sh`) is written into the staging directory directly, after this
 * filter has already excluded the source copy.
 */
function excludedFromBuildContext(appDir: string, src: string): boolean {
  return src.includes(join(appDir, "node_modules")) || src.includes(join(appDir, ".berth"));
}

/**
 * Runs `pnpm deploy --legacy` for a workspace member without leaving the
 * workspace's pnpm-lock.yaml modified.
 *
 * A deploy can rewrite the lockfile (workspace links become injected `file:`
 * dependencies), so image builds from a clone used to leave the tracked file
 * changed. The first attempt is `--frozen-lockfile`, where pnpm never writes
 * the lockfile at all: nothing to put back, and nothing to race with. Only
 * when that fails (a lockfile the deploy has to change) does it deploy
 * normally, under withLockfileRestored().
 */
async function deployWorkspaceMember(workspaceRoot: string, name: string, stagingDir: string): Promise<void> {
  const deploy = (extra: string[]) =>
    execFileAsync("pnpm", ["--filter", name, "deploy", "--prod", "--legacy", ...extra, stagingDir], { cwd: workspaceRoot });
  try {
    await deploy(["--frozen-lockfile"]);
    return;
  } catch {
    await rm(stagingDir, { recursive: true, force: true });
  }
  await withLockfileRestored(workspaceRoot, () => deploy([]));
}

/** One lockfile-rewriting deploy at a time per workspace, so no deploy snapshots another's rewrite as "before". */
const lockfileDeploys = new Map<string, Promise<unknown>>();

/**
 * Puts the workspace lockfile back after `run` changes it, without undoing
 * anyone else's edit.
 *
 * - The original goes back the moment the deploy exits, and only if the
 *   file changed, by rename, so nothing ever reads a half-written lockfile.
 * - Deploys in this process are serialized per workspace. Two overlapping
 *   ones otherwise saw each other's rewrite as the original, and the later
 *   restore left the lockfile modified.
 * - SIGINT/SIGTERM mid-deploy restores it too, synchronously, before the
 *   signal takes its usual course. An edit made *during* the deploy can't
 *   be told apart from the deploy's own and is replaced; that window is the
 *   deploy itself, and the frozen-lockfile attempt in
 *   deployWorkspaceMember() means it is only open when the lockfile had to
 *   change anyway.
 */
export async function withLockfileRestored<T>(workspaceRoot: string, run: () => Promise<T>): Promise<T> {
  const previous = lockfileDeploys.get(workspaceRoot) ?? Promise.resolve();
  const mine = previous.catch(() => {}).then(() => restoringLockfile(workspaceRoot, run));
  lockfileDeploys.set(workspaceRoot, mine);
  try {
    return await mine;
  } finally {
    if (lockfileDeploys.get(workspaceRoot) === mine) lockfileDeploys.delete(workspaceRoot);
  }
}

async function restoringLockfile<T>(workspaceRoot: string, run: () => Promise<T>): Promise<T> {
  const lockfile = join(workspaceRoot, "pnpm-lock.yaml");
  if (!existsSync(lockfile)) return run();
  const before = readFileSync(lockfile);
  const current = () => {
    try {
      return readFileSync(lockfile);
    } catch {
      return undefined;
    }
  };
  const putBack = () => {
    const temp = `${lockfile}.berth-restore-${process.pid}`;
    writeFileSync(temp, before);
    renameSync(temp, lockfile);
  };

  const signals = ["SIGINT", "SIGTERM"] as const;
  const onSignal = (signal: NodeJS.Signals) => {
    const after = current();
    if (!after || !after.equals(before)) putBack();
    // Only stand in for the default handler when nobody else is listening;
    // otherwise whoever registered first decides what the signal means.
    const alone = process.listenerCount(signal) === 1;
    removeHandlers();
    if (alone) process.kill(process.pid, signal);
  };
  const removeHandlers = () => {
    for (const signal of signals) process.off(signal, onSignal);
  };
  for (const signal of signals) process.on(signal, onSignal);

  try {
    return await run();
  } finally {
    removeHandlers();
    const after = current();
    if (!after || !after.equals(before)) putBack();
  }
}

/**
 * Makes a deployed tree identical from one build to the next, and correct
 * inside the image. `pnpm deploy` writes its own (random, temporary) target
 * path into the `.bin` shims' NODE_PATH and into `.modules.yaml`, so the
 * staged app never matched the previous build's and its `COPY` layer missed
 * the build cache every time: a new ~160 MB layer per boot of an unchanged
 * app. Those paths don't exist inside the container either.
 *
 *  - the target path in `.bin` shims becomes the app's path in the image;
 *  - `.modules.yaml` and `.pnpm-workspace-state-v1.json` (pnpm's install
 *    bookkeeping, unread at runtime) go. Both carry a fresh timestamp on
 *    every install, and `.modules.yaml` names the builder's store too, which
 *    is what made a `pnpm install` run from `on_install` in /app refuse to
 *    proceed without a TTY (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY);
 *    without it pnpm simply reinstalls;
 *  - symlinks that resolve outside the staged tree go, including ones that
 *    only get out through another link. They were relative links back into
 *    the builder's checkout (the app's own workspace entry, a pnpm
 *    override's target), dangling in the image and naming the builder's
 *    home directory.
 */
export async function makeDeployReproducible(stagingDir: string, containerAppRoot: string): Promise<void> {
  const root = await realpath(stagingDir);
  // Longest first: the real path (/private/tmp/…) contains the one it was
  // given (/tmp/…) on macOS, and replacing the shorter one first leaves
  // "/private" behind.
  const spellings = [...new Set([stagingDir, root])].sort((x, y) => y.length - x.length);
  const escaping: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Compared as real paths on both sides: a link can stay inside the
        // tree by name and still leave it through another link, and a
        // dangling one (no real path) is judged by where it points. Removed
        // only after the walk, so no link's verdict depends on whether a
        // link it goes through was already removed.
        const named = resolvePath(dirname(path), await readlink(path));
        const target = await realpath(named).catch(() => named);
        if (target !== root && !target.startsWith(root + sep)) escaping.push(path);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if ((entry.name === ".modules.yaml" || entry.name === ".pnpm-workspace-state-v1.json") && dir.endsWith("node_modules")) {
        await rm(path);
        continue;
      }
      if (basename(dir) === ".bin") {
        const text = await readFile(path, "utf-8");
        let rewritten = text;
        for (const spelling of spellings) rewritten = rewritten.split(spelling).join(containerAppRoot);
        if (rewritten !== text) await writeFile(path, rewritten);
      }
    }
  };
  await walk(root);
  for (const path of escaping) await rm(path);
}

/**
 * Materializes a real (non-symlinked-outside) node_modules for the
 * production image. A dev image relies on a bind mount plus the host's own
 * pnpm-managed node_modules, so it never needs this — but a production image
 * has no bind mount, so anything resolved via a pnpm workspace's relative
 * symlinks (e.g. `@berthos/sdk -> ../../../../packages/sdk`) would dangle once
 * copied in isolation. `pnpm deploy --legacy` is pnpm's own mechanism for
 * producing a fully self-contained package directory from a workspace
 * member — every dependency copied for real, nothing outside the target
 * directory. Standalone (non-workspace) apps — every `berth init` project —
 * just get a normal prod install.
 *
 * Both paths end in makeDeployReproducible(). A standalone app needs it as
 * much as a workspace member: `pnpm install` in the (random, temporary)
 * staging directory writes that path into the `.bin` shims too, and a fresh
 * `prunedAt` timestamp into `.modules.yaml`, so without it every boot of an
 * unchanged `berth init` project missed the `COPY . /app` cache and left
 * another ~160 MB layer behind.
 */
export async function stageProductionSource(appDir: string, stagingDir: string, containerAppRoot: string): Promise<void> {
  const workspaceRoot = workspaceRootAbove(appDir);

  if (workspaceRoot) {
    const pkgJson = JSON.parse(await readFile(join(appDir, "package.json"), "utf-8")) as { name: string };
    await deployWorkspaceMember(workspaceRoot, pkgJson.name, stagingDir);
    await makeDeployReproducible(stagingDir, containerAppRoot);
    return;
  }

  await cp(appDir, stagingDir, {
    recursive: true,
    filter: (src) => !excludedFromBuildContext(appDir, src),
  });
  try {
    await execFileAsync("pnpm", ["install", "--prod"], { cwd: stagingDir });
  } catch {
    await execFileAsync("npm", ["install", "--omit=dev"], { cwd: stagingDir });
  }
  await makeDeployReproducible(stagingDir, containerAppRoot);
}

/** Wraps a string so a shell reads it as one literal argument, single quotes included. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes an app's `on_install` commands into `<stagedAppRoot>/.berth/on-install.sh`,
 * which base.Dockerfile RUNs as a build layer. Returns false (writing nothing)
 * for an app that declares none.
 *
 * `on_install` used to run at
 * container boot, from `run-lifecycle.ts`, as uid 0 with CAP_SYS_ADMIN,
 * /dev/fuse, and no Landlock domain — before `agent-init` had applied one,
 * by construction, since the policy is generated in the same script. Any
 * `berth.yml` (from the registry, from a PR, or rewritten through `berth
 * dev`'s bind mount) was therefore arbitrary root code execution inside the
 * sandbox it was supposed to be constrained by.
 *
 * At build time the same commands run under the builder's isolation, in a
 * layer, against a staged copy — which is where `pip install -r
 * requirements.txt` belonged anyway, and which is why removing the boot-time
 * path costs the documented use case nothing.
 *
 * The commands go into a *file* rather than being interpolated into a
 * `RUN` directive. That's deliberate: a command containing a newline would
 * otherwise end the RUN and let the rest of the string be parsed as further
 * Dockerfile directives (`FROM`, `COPY --from`, ...). A generated script has
 * no such escaping surface — the file is data, and the Dockerfile's single
 * RUN line is fixed.
 */
async function stageOnInstallScript(appDir: string, stagedAppRoot: string): Promise<boolean> {
  const manifest = await loadManifest(join(appDir, "berth.yml"));
  if (manifest.on_install.length === 0) return false;

  const script = [
    "#!/usr/bin/env bash",
    "# Generated by @berthos/docker-orchestrator's buildImage() from berth.yml's",
    "# on_install list. Do not edit — it is rewritten on every build, and it",
    "# runs as a Docker build layer, never at container boot.",
    "set -euo pipefail",
    "",
    ...manifest.on_install.flatMap((command) => [
      `printf '[berth:on_install] %s\\n' ${shellQuote(command)} >&2`,
      command,
    ]),
    "",
  ].join("\n");

  const scriptPath = join(stagedAppRoot, ".berth", "on-install.sh");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  return true;
}

/**
 * The dev target's equivalent of the production staging above, and the reason
 * `on_install` could move to build time for *both* targets rather than only
 * the one with a `COPY . /app`.
 *
 * A dev image has no source in it at all — `berth dev` supplies it via a bind
 * mount at container start, which is why base.Dockerfile's dev stage never
 * copies any. But the build *context* still has the app's source (staged a
 * few lines above), so `on_install` can run against a staged copy at build
 * time and leave its effects — site-packages, apk-installed binaries, a
 * compiled asset — in the image, exactly where the bind mount doesn't reach.
 * The copy lands under `on-install/apps/<name>/` so one runner script handles
 * both targets: `apps/<name>/` is the layout production already uses.
 *
 * The context directory is created for *both* targets, by
 * ensureOnInstallContext() below, and populated only here. Docker's classic
 * builder walks every stage in the file rather than only the target's own
 * chain, so `COPY on-install` in the dev stage is resolved — and fails the
 * build with "file not found in build context" — even for a `target:
 * "production"` build that never runs that layer. Confirmed the direct way,
 * by a production build failing at exactly that step.
 *

 * Two consequences worth stating, both of which are improvements:
 *
 *  - An `on_install` change now needs a rebuild, not just the container
 *    restart chokidar does on a `berth.yml` save. That's a real DX cost and
 *    it's documented in docs/manifest-reference.md.
 *  - It severs half of the writable-workspace exploit chain. An app that
 *    rewrites its own `berth.yml` through the bind mount and waits for
 *    watch.ts to restart the container no longer gets its `on_install`
 *    payload executed as root, because nothing executes `on_install` at boot
 *    any more. The bind mount is still too wide; the payload path is gone.
 */
async function ensureOnInstallContext(stagingDir: string): Promise<string> {
  const contextDir = join(stagingDir, "on-install");
  await mkdir(contextDir, { recursive: true });
  // tar-fs preserves empty directories, but a marker file makes the intent
  // legible to anyone who unpacks a build context wondering what this is.
  await writeFile(join(contextDir, ".keep"), "on_install build context — see image.ts's stageDevOnInstallContext()\n");
  return contextDir;
}

async function stageDevOnInstallContext(options: BuildImageOptions, stagingDir: string): Promise<void> {
  const contextDir = await ensureOnInstallContext(stagingDir);

  const primaryName = options.appName ?? (await loadManifest(join(options.appDir, "berth.yml"))).name;
  const apps = [{ name: primaryName, appDir: options.appDir }, ...(options.companions ?? [])];

  for (const app of apps) {
    const stagedAppRoot = join(contextDir, "apps", app.name);
    // Written first: it's the cheap check for "does this app declare any
    // on_install at all", and there's no reason to copy a whole app's source
    // for one that doesn't.
    await mkdir(stagedAppRoot, { recursive: true });
    if (!(await stageOnInstallScript(app.appDir, stagedAppRoot))) {
      await rm(stagedAppRoot, { recursive: true, force: true });
      continue;
    }
    await cp(app.appDir, stagedAppRoot, {
      recursive: true,
      force: false,
      filter: (src) => !excludedFromBuildContext(app.appDir, src),
    });
  }
}

/**
 * Removes a built image's tag without pruning its parent layers.
 *
 * A plain `docker rmi` also deletes every untagged parent the image had, and
 * with the classic builder those parents are the build cache. Removing a
 * Computer's image on stop() therefore threw away the cached base layers, so
 * the next boot re-ran the base image's `apk add` (Chromium, Python, tmux…):
 * every boot of an unchanged app took over a minute, failed whenever the
 * Alpine mirror did, and left the multi-stage builder images behind as new
 * dangling images each time. Keeping the parents costs nothing extra: the
 * next build of the same apps reuses them instead of recreating them.
 */
export async function removeImageKeepingCache(docker: Docker, tag: string): Promise<void> {
  await docker
    .getImage(tag)
    .remove({ noprune: true })
    .catch(() => {
      /* already gone, or never fully built */
    });
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
      if ((options.companions && options.companions.length > 0) || options.forceCompanionLayout) {
        if (!options.appName) throw new Error("buildImage: appName is required when companions is non-empty or forceCompanionLayout is set");
        await stageProductionSource(options.appDir, join(stagingDir, "apps", options.appName), `/app/apps/${options.appName}`);
        await stageOnInstallScript(options.appDir, join(stagingDir, "apps", options.appName));
        for (const companion of options.companions ?? []) {
          await stageProductionSource(companion.appDir, join(stagingDir, "apps", companion.name), `/app/apps/${companion.name}`);
          await stageOnInstallScript(companion.appDir, join(stagingDir, "apps", companion.name));
        }
      } else {
        await stageProductionSource(options.appDir, stagingDir, "/app");
        await stageOnInstallScript(options.appDir, stagingDir);
      }
      // Empty, but present: see ensureOnInstallContext()'s note on the
      // classic builder resolving COPY paths in stages it never runs.
      await ensureOnInstallContext(stagingDir);
    } else {
      await cp(options.appDir, stagingDir, {
        recursive: true,
        filter: (src) => !excludedFromBuildContext(options.appDir, src),
      });
      await stageDevOnInstallContext(options, stagingDir);
    }

    await cp(DOCKER_ASSETS_DIR, join(stagingDir, "docker"), { recursive: true });
    for (const dir of [CONTEXT_BUS_DAEMON_DIR, AGENT_INIT_DIR, SEMANTIC_FS_DAEMON_DIR, MESH_DAEMON_DIR]) {
      if (!existsSync(dir)) {
        throw new Error(
          `daemon source not found at ${dir}: this @berthos/docker-orchestrator has neither the repository's packages/ nor a bundled daemons/ copy (run its build, which bundles them)`,
        );
      }
    }
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
    await cp(MESH_DAEMON_DIR, join(stagingDir, "mesh-daemon"), {
      recursive: true,
      filter: (src) => !src.includes(join(MESH_DAEMON_DIR, "target")),
    });

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
