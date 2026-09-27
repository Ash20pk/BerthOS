import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where a scaffolded project's `@berthos/sdk` dependency should point. */
export interface SdkDependency {
  /** The value to write into the project's package.json. */
  spec: string;
  /** The vendored tarball to copy into `vendor/`, when there is one. */
  tarballPath?: string;
}

/**
 * Picks the `@berthos/sdk` dependency for a project `berth init` scaffolds,
 * given the root of the SDK package the CLI itself resolved.
 *
 * Inside this repo the SDK build leaves a self-contained bundle at
 * `dist-external/berth-sdk.tgz`, and the project vendors it: the templates'
 * own version range doesn't resolve outside the workspace. A CLI installed
 * from npm has no such bundle (the published SDK doesn't ship it), but the
 * SDK it depends on is on the registry at the CLI's own version, so the
 * project depends on that. Either way the result installs; the templates'
 * placeholder range is never left in place.
 */
export function sdkDependency(sdkPkgRoot: string): SdkDependency {
  const tarballPath = join(sdkPkgRoot, "dist-external", "berth-sdk.tgz");
  if (existsSync(tarballPath)) return { spec: "file:./vendor/berth-sdk.tgz", tarballPath };

  const { version } = JSON.parse(readFileSync(join(sdkPkgRoot, "package.json"), "utf-8")) as { version?: string };
  if (!version) throw new Error(`@berthos/sdk at ${sdkPkgRoot} has no version in its package.json`);
  return { spec: `^${version}` };
}
