import { join, relative } from "node:path";
import { loadManifest, ManifestValidationError, type BerthManifest } from "@berth/manifest-schema";
import { findWorkspaceRoot } from "./workspace.js";

export interface AppSpec {
  name: string;
  /** Absolute host path. */
  appDir: string;
  /** Path relative to the pnpm workspace root, e.g. "apps/code-editor". */
  relPath: string;
  manifest: BerthManifest;
}

/**
 * Resolves the primary app plus any `--apps=<relPath1>,<relPath2>,...>`
 * companions into a single ordered list (primary always first). Companion
 * paths are workspace-relative, not a new config file — reuses
 * `loadManifest()` unchanged and avoids inventing a second manifest format
 * alongside `berth.yml`.
 *
 * Requires the primary app to be a pnpm workspace member when `--apps` is
 * given: dev's bind-mount already has to cover the whole workspace root for
 * a workspace member (pnpm's relative symlinks point outside a single app's
 * directory — see resolveDevBindMount), which is also exactly what lets a
 * companion app's directory be visible inside the same container at all.
 */
export async function resolveApps(primaryAppDir: string, appsFlag: string | undefined, primaryManifest: BerthManifest): Promise<AppSpec[]> {
  const primary: AppSpec = { name: primaryManifest.name, appDir: primaryAppDir, relPath: ".", manifest: primaryManifest };
  if (!appsFlag) return [primary];

  const workspaceRoot = findWorkspaceRoot(primaryAppDir);
  if (!workspaceRoot) {
    console.error("--apps requires the primary app to be a pnpm workspace member (no pnpm-workspace.yaml found above it).");
    process.exit(1);
  }

  const companions: AppSpec[] = [];
  const seenNames = new Set([primary.name]);
  for (const relPath of appsFlag.split(",").map((s) => s.trim()).filter(Boolean)) {
    const appDir = join(workspaceRoot, relPath);
    let manifest: BerthManifest;
    try {
      manifest = await loadManifest(join(appDir, "berth.yml"));
    } catch (err) {
      if (err instanceof ManifestValidationError) console.error(err.message);
      else console.error(`could not read ${join(appDir, "berth.yml")}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (seenNames.has(manifest.name)) {
      console.error(`duplicate app name "${manifest.name}" among --apps entries`);
      process.exit(1);
    }
    seenNames.add(manifest.name);
    companions.push({ name: manifest.name, appDir, relPath, manifest });
  }

  // The primary's own relPath, now that a workspace root is known — used by
  // image.ts to decide per-app staging subdirectories in multi-app builds.
  primary.relPath = relative(workspaceRoot, primaryAppDir) || ".";
  return [primary, ...companions];
}

function declaresBrowserCapability(manifest: BerthManifest): boolean {
  return manifest.capabilities.some((cap) => cap.startsWith("browser:"));
}

function declaresTerminalCapability(manifest: BerthManifest): boolean {
  return manifest.capabilities.some((cap) => cap.startsWith("terminal:"));
}

function declaresMeshCapability(manifest: BerthManifest): boolean {
  return manifest.capabilities.some((cap) => cap.startsWith("network:peer:"));
}

/**
 * v1 scope: at most one app across the whole set may declare `browser:*` —
 * two simultaneous browser-capable apps would need per-app Xvfb
 * displays/VNC/CDP port allocation, which is real additional work this pass
 * doesn't attempt (the existing fixed BROWSER_PORTS set stays exactly as-is).
 */
export function assertAtMostOneBrowserApp(apps: AppSpec[]): void {
  const browserApps = apps.filter((a) => declaresBrowserCapability(a.manifest));
  if (browserApps.length > 1) {
    console.error(
      `at most one app may declare a browser:* capability when running multiple apps together — found ${browserApps.length}: ${browserApps.map((a) => a.name).join(", ")}`,
    );
    process.exit(1);
  }
}

/**
 * Same reasoning as assertAtMostOneBrowserApp: the terminal port (7681) is a
 * single fixed container port, not allocated per-app, so two terminal:*
 * apps sharing a container would race to bind it.
 */
export function assertAtMostOneTerminalApp(apps: AppSpec[]): void {
  const terminalApps = apps.filter((a) => declaresTerminalCapability(a.manifest));
  if (terminalApps.length > 1) {
    console.error(
      `at most one app may declare a terminal:* capability when running multiple apps together — found ${terminalApps.length}: ${terminalApps.map((a) => a.name).join(", ")}`,
    );
    process.exit(1);
  }
}

/**
 * Same reasoning again: wg0 is a single interface per container (see
 * docs/mesh-reference.md) — entrypoint.sh's multi-app branch picks exactly
 * one app's capability-policy.json to point mesh-daemon at, so two
 * network:peer:* apps sharing a container would be ambiguous about whose
 * declared peer patterns the mesh should actually enforce.
 */
export function assertAtMostOneMeshApp(apps: AppSpec[]): void {
  const meshApps = apps.filter((a) => declaresMeshCapability(a.manifest));
  if (meshApps.length > 1) {
    console.error(
      `at most one app may declare a network:peer:* capability when running multiple apps together — found ${meshApps.length}: ${meshApps.map((a) => a.name).join(", ")}`,
    );
    process.exit(1);
  }
}
