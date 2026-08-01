import { buildImage } from "@berth/docker-orchestrator";
import type { BerthManifest } from "@berth/manifest-schema";
import type { AppSpec } from "./multi-app.js";

export function devImageTag(manifest: BerthManifest): string {
  return `berth/${manifest.name}:dev`;
}

export function productionImageTag(manifest: BerthManifest): string {
  return `berth/${manifest.name}:${manifest.version}`;
}

export async function buildDevImage(appDir: string, manifest: BerthManifest): Promise<string> {
  const tag = devImageTag(manifest);
  await buildImage({ appDir, tag, target: "dev" });
  return tag;
}

/**
 * Used by `berth test`, `berth publish`, and `berth deploy` — one build path
 * so tests run against what will actually ship. `companions` (from
 * `--apps`) are staged into their own `apps/<name>/` subdirectories — see
 * `@berth/docker-orchestrator`'s `buildImage()`.
 */
export async function buildProductionImage(appDir: string, manifest: BerthManifest, companions: AppSpec[] = []): Promise<string> {
  const tag = productionImageTag(manifest);
  await buildImage({
    appDir,
    tag,
    target: "production",
    ...(companions.length > 0
      ? { appName: manifest.name, companions: companions.map((c) => ({ name: c.name, appDir: c.appDir })) }
      : {}),
  });
  return tag;
}
