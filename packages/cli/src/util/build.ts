import { buildImage } from "@berth/docker-orchestrator";
import type { BerthManifest } from "@berth/manifest-schema";

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

/** Used by `berth test`, `berth publish`, and `berth deploy` — one build path so tests run against what will actually ship. */
export async function buildProductionImage(appDir: string, manifest: BerthManifest): Promise<string> {
  const tag = productionImageTag(manifest);
  await buildImage({ appDir, tag, target: "production" });
  return tag;
}
