import { join } from "node:path";
import { loadManifest, type BerthManifest } from "@berth/manifest-schema";

export interface ComputerAppSpec {
  name: string;
  /** Absolute host path to the app's directory (must contain berth.yml). */
  appDir: string;
  manifest: BerthManifest;
}

/**
 * Loads and validates one berth.yml per directory. Unlike @berth/cli's
 * resolveApps(), this doesn't require the apps to be siblings in one pnpm
 * workspace (production image staging works for arbitrary standalone
 * directories) and throws plain Errors instead of calling process.exit() —
 * this is a library used by a long-running agent process, not a one-shot CLI
 * command.
 */
export async function resolveComputerApps(appDirs: string[]): Promise<ComputerAppSpec[]> {
  if (appDirs.length === 0) {
    throw new Error("Computer.boot() needs at least one app directory");
  }

  const apps: ComputerAppSpec[] = [];
  const seenNames = new Set<string>();

  for (const appDir of appDirs) {
    const manifest = await loadManifest(join(appDir, "berth.yml"));
    if (seenNames.has(manifest.name)) {
      throw new Error(`duplicate app name "${manifest.name}" — every app in a Computer must have a unique name`);
    }
    seenNames.add(manifest.name);
    apps.push({ name: manifest.name, appDir, manifest });
  }

  return apps;
}
