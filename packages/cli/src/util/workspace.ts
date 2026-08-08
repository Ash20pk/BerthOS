import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * Walks up from `startDir` looking for pnpm-workspace.yaml. If the app being
 * developed is a workspace member, `berth dev` must bind-mount the whole
 * workspace root (not just the app's own directory) — pnpm's node_modules
 * uses relative symlinks (e.g. `@berth/sdk -> ../../../../packages/sdk`)
 * that point outside the app's directory tree, and those symlinks dangle
 * unless sibling package directories are present at the same relative path
 * inside the container.
 */
export function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface DevBindMount {
  bindMount: { hostPath: string; containerPath: string; readOnly?: boolean };
  /** Extra `host:container[:ro]` binds carving writable holes in the read-only mount above. */
  extraBinds: string[];
  workingDir: string;
  /**
   * Where apps should read and write their own data — handed to the container
   * as BERTH_WORKSPACE_ROOT, which every first-party app already consults
   * before falling back to `/workspace`.
   */
  workspaceRoot: string;
}

/** Directory (relative to the mount root) holding everything `berth dev` needs to be writable. */
const DEV_STATE_DIR = ".berth";
/** Shared, writable, and the same path for every app in the container — see resolveDevBindMount(). */
const DEV_WORKSPACE_DIR = `${DEV_STATE_DIR}/dev-workspace`;

export interface DevMountApp {
  /** Absolute host path of the app's own directory. */
  appDir: string;
  /** Path of that directory relative to the mount root, e.g. "apps/code-editor". Empty for a standalone app. */
  relPath: string;
}

/**
 * The mount layout for `berth dev`, and the whole of REMEDIATION.md 1.6.
 *
 * It used to be one line: bind the pnpm workspace root at `/workspace`,
 * read-write. Apps declaring `filesystem:write:/workspace` — which is four of
 * the first-party ones — therefore had kernel-granted write access to the
 * developer's entire repository. Writing `/workspace/.git/hooks/pre-commit`
 * or any `package.json`'s `scripts` is host-side code execution on the next
 * commit or build; rewriting the app's own `berth.yml` and waiting for the
 * file watcher to restart the container recompiled the attacker's own
 * capability list into the enforced policy.
 *
 * The mount is still the whole workspace root, because it has to be: pnpm's
 * `node_modules` symlinks point at sibling package directories by relative
 * path, and they dangle if those directories aren't present. But nothing in
 * that tree needs to be *writable* for module resolution, for reading source,
 * or for reading a manifest. So the root is mounted read-only and the two
 * things that genuinely need writing are mounted back over it:
 *
 *   /workspace                      workspace root, READ-ONLY
 *   /workspace/<app>/.berth         per-app named volume — the generated
 *                                   capability policy lives here
 *   /workspace/.berth/dev-workspace host directory — shared app data,
 *                                   pointed at by BERTH_WORKSPACE_ROOT
 *
 * Read-only here is a *kernel VFS* property (`EROFS`), not a Landlock rule,
 * so unlike most of what this repo enforces it holds identically on a host
 * without Landlock — including Docker Desktop, where `agent-init` fails open.
 *
 * Three consequences worth knowing:
 *
 *  - `berth.yml` is now read-only inside the container, which is what closes
 *    the rewrite-and-restart escalation. It's read through the *directory*
 *    mount rather than a file-level bind, so an editor that replaces the file
 *    by rename (most of them) still works on the host side.
 *  - App data no longer lands at the root of your repository. `notes.json`,
 *    anything `code-interpreter` writes, and everything `apps/filesystem`
 *    lists now live under `.berth/dev-workspace/`, which is already
 *    gitignored. That directory is a real host directory rather than a named
 *    volume specifically so it stays inspectable.
 *  - Every mountpoint has to exist on the host before the container starts.
 *    Docker cannot create one inside a read-only bind — the nested mount
 *    fails with `read-only file system` at container init, which is why this
 *    function has side effects at all.
 */
export function resolveDevBindMount(appDir: string, companions: DevMountApp[] = []): DevBindMount {
  const workspaceRoot = findWorkspaceRoot(appDir);
  const mountRoot = workspaceRoot ?? appDir;
  const containerRoot = workspaceRoot ? "/workspace" : "/app";
  const primary: DevMountApp = { appDir, relPath: workspaceRoot ? relative(workspaceRoot, appDir) : "" };
  const apps: DevMountApp[] = [primary, ...companions];

  const extraBinds: string[] = [];

  // Shared across every app in the container: a companion writing a file the
  // primary then reads is the point of multi-app mode, so this deliberately
  // isn't per-app. It sits under the mount root rather than beside it so that
  // an app's declared `filesystem:write:/workspace` still covers it — a path
  // outside the declared scope would be denied by Landlock instead.
  const devWorkspaceHostPath = join(mountRoot, DEV_WORKSPACE_DIR);
  mkdirSync(devWorkspaceHostPath, { recursive: true });
  extraBinds.push(`${devWorkspaceHostPath}:${containerRoot}/${DEV_WORKSPACE_DIR}`);

  for (const app of apps) {
    // Created on the host purely as a mountpoint for the named volume that
    // dev.ts binds here; its contents come from the volume, not from disk.
    mkdirSync(join(app.appDir, DEV_STATE_DIR), { recursive: true });
  }

  return {
    bindMount: { hostPath: mountRoot, containerPath: containerRoot, readOnly: true },
    extraBinds,
    workingDir: primary.relPath ? join(containerRoot, primary.relPath) : containerRoot,
    workspaceRoot: `${containerRoot}/${DEV_WORKSPACE_DIR}`,
  };
}

/** Container path of one app's `.berth` state directory, for dev.ts's per-app volume binds. */
export function devStatePath(containerRoot: string, relPath: string): string {
  return relPath ? join(containerRoot, relPath, DEV_STATE_DIR) : `${containerRoot}/${DEV_STATE_DIR}`;
}
