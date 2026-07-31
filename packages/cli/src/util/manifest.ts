import { join } from "node:path";
import { loadManifest, ManifestValidationError, type BerthManifest } from "@berth/manifest-schema";

/** Loads berth.yml from cwd (or a given dir) and prints readable errors instead of a raw stack trace. */
export async function loadManifestOrExit(dir = process.cwd()): Promise<BerthManifest> {
  const path = join(dir, "berth.yml");
  try {
    return await loadManifest(path);
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
