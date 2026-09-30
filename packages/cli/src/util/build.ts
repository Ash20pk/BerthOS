import { buildImage, checkoutTag } from "@berthos/docker-orchestrator";
import type { BerthManifest } from "@berthos/manifest-schema";
import type { AppSpec } from "./multi-app.js";
import type { OsAppSpec } from "./os-config.js";

/**
 * `berth/<name>:dev-<hash8>`, the hash being the app directory's
 * (checkoutTag()): `berth dev` in two checkouts of an app with the same name
 * would otherwise keep moving one tag between their two images, and each
 * start its container from whichever was built last.
 */
export function devImageTag(manifest: BerthManifest, appDir: string): string {
  return checkoutTag(`berth/${manifest.name}:dev`, appDir);
}

/** The name `berth publish` and `berth deploy` ship the image under. */
export function productionImageTag(manifest: BerthManifest): string {
  return `berth/${manifest.name}:${manifest.version}`;
}

/**
 * The same production build, tagged for `berth test` in this checkout only
 * (`berth/<name>:<version>-<hash8>`): it never leaves the machine, and two
 * checkouts testing the same app and version at once would otherwise each
 * run the other's image.
 */
export function testImageTag(manifest: BerthManifest, appDir: string): string {
  return checkoutTag(productionImageTag(manifest), appDir);
}

/**
 * `companions` matters here for exactly one reason, and only since
 * A dev image still has no companion *source* in it (that
 * arrives via the bind mount), but each companion's `on_install` now runs as
 * a build layer, so its manifest and files have to reach the build context.
 * Omitting them would silently skip a companion's setup step in `berth dev`
 * while it still ran in production.
 */
export async function buildDevImage(appDir: string, manifest: BerthManifest, companions: AppSpec[] = [], signal?: AbortSignal): Promise<string> {
  const tag = devImageTag(manifest, appDir);
  await buildImage({
    appDir,
    tag,
    target: "dev",
    appName: manifest.name,
    ...(companions.length > 0 ? { companions: companions.map((c) => ({ name: c.name, appDir: c.appDir })) } : {}),
    ...(signal ? { signal } : {}),
  });
  return tag;
}

/**
 * Used by `berth test`, `berth publish`, and `berth deploy` — one build path
 * so tests run against what will actually ship. `companions` (from
 * `--apps`) are staged into their own `apps/<name>/` subdirectories — see
 * `@berthos/docker-orchestrator`'s `buildImage()`.
 */
export async function buildProductionImage(
  appDir: string,
  manifest: BerthManifest,
  companions: AppSpec[] = [],
  tag: string = productionImageTag(manifest),
): Promise<string> {
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

export function osImageTag(name: string): string {
  return `berth-os/${name}:latest`;
}

/**
 * Used by `berth os up`. Unlike buildProductionImage(), this always stages
 * the companion apps/<name>/ layout — even for exactly one app
 * (forceCompanionLayout) — so the container always gets entrypoint.sh's
 * multi-app branch and thus a per-app RPC socket a later `Computer.connect()`
 * can reach, regardless of how many apps are loaded. See
 * docs/berth-os-reference.md.
 */
export async function buildOsImage(name: string, primary: OsAppSpec, companions: OsAppSpec[]): Promise<string> {
  const tag = osImageTag(name);
  await buildImage({
    appDir: primary.appDir,
    tag,
    target: "production",
    appName: primary.name,
    companions: companions.map((c) => ({ name: c.name, appDir: c.appDir })),
    forceCompanionLayout: true,
  });
  return tag;
}
