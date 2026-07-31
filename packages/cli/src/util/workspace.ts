import { existsSync } from "node:fs";
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
  bindMount: { hostPath: string; containerPath: string };
  workingDir: string;
}

/** Standalone apps bind-mount themselves at /app; workspace members bind-mount the whole workspace root. */
export function resolveDevBindMount(appDir: string): DevBindMount {
  const workspaceRoot = findWorkspaceRoot(appDir);
  if (!workspaceRoot) {
    return { bindMount: { hostPath: appDir, containerPath: "/app" }, workingDir: "/app" };
  }
  const relativePath = relative(workspaceRoot, appDir);
  return {
    bindMount: { hostPath: workspaceRoot, containerPath: "/workspace" },
    workingDir: join("/workspace", relativePath),
  };
}
