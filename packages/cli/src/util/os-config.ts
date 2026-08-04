import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { loadManifest, ManifestValidationError, type BerthManifest } from "@berth/manifest-schema";

export interface OsAppSpec {
  name: string;
  /** Absolute host path. */
  appDir: string;
  manifest: BerthManifest;
}

interface OsConfigFileShape {
  name?: string;
  apps: string[];
  network?: string;
}

export interface ResolvedOsConfig {
  name?: string;
  appDirs: string[];
  network?: string;
}

/**
 * `--config=<path>`: a small YAML file listing which resident apps make up
 * one agent's "OS" — an alternative to `--apps=<dir1>,<dir2>` for anything
 * more than a couple of apps, or anything meant to be checked in and reused.
 * Not a new manifest format — each entry is still just a directory
 * containing its own berth.yml, loaded via the same loadManifest() any other
 * multi-app path uses. See docs/berth-os-reference.md.
 *
 *   name: my-agent
 *   apps:
 *     - apps/filesystem
 *     - apps/notes
 *   network: my-net   # optional
 */
export async function loadOsConfigFile(configPath: string): Promise<ResolvedOsConfig> {
  const absPath = resolve(configPath);
  let raw: string;
  try {
    raw = await readFile(absPath, "utf-8");
  } catch (err) {
    console.error(`could not read ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const parsed = parse(raw) as OsConfigFileShape | null;
  if (!parsed || !Array.isArray(parsed.apps) || parsed.apps.length === 0) {
    console.error(`${absPath}: expected an "apps:" list of at least one resident app directory`);
    process.exit(1);
  }

  const baseDir = dirname(absPath);
  return {
    name: parsed.name,
    appDirs: parsed.apps.map((p) => resolve(baseDir, p)),
    network: parsed.network,
  };
}

/**
 * Loads and validates one berth.yml per directory — the flat, no-primary
 * shape `berth os up` needs (unlike @berth/cli's resolveApps(), which is
 * asymmetric primary+companions tied to running `berth dev` from inside one
 * specific app's directory). Mirrors @berth/agents' resolveComputerApps()
 * (duplicated rather than imported — pulling in @berth/agents here would
 * drag its openai/anthropic SDK dependencies into the CLI for a ~15-line
 * helper), but exits on error like the rest of this CLI instead of throwing.
 */
export async function resolveOsApps(appDirs: string[]): Promise<OsAppSpec[]> {
  const apps: OsAppSpec[] = [];
  const seenNames = new Set<string>();

  for (const appDir of appDirs) {
    const absAppDir = resolve(appDir);
    let manifest: BerthManifest;
    try {
      manifest = await loadManifest(resolve(absAppDir, "berth.yml"));
    } catch (err) {
      if (err instanceof ManifestValidationError) console.error(err.message);
      else console.error(`could not read ${resolve(absAppDir, "berth.yml")}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (seenNames.has(manifest.name)) {
      console.error(`duplicate app name "${manifest.name}" among the apps passed to \`berth os\``);
      process.exit(1);
    }
    seenNames.add(manifest.name);
    apps.push({ name: manifest.name, appDir: absAppDir, manifest });
  }

  return apps;
}

function declaresCapabilityPrefix(manifest: BerthManifest, prefixes: string[]): boolean {
  return manifest.capabilities.some((cap) => prefixes.some((prefix) => cap.startsWith(prefix)));
}

/**
 * Same v1 constraints @berth/cli's multi-app.ts already enforces for `berth
 * dev --apps=`/`berth test --apps=` (one Xvfb/VNC display, one ttyd port, one
 * wg0 interface per container) — reimplemented here against OsAppSpec[]
 * rather than sharing multi-app.ts's AppSpec[] (which carries a workspace-
 * relative `relPath` field `berth os up` has no use for and would have to
 * fake).
 */
function assertAtMostOne(apps: OsAppSpec[], prefixes: string[], label: string): void {
  const matching = apps.filter((a) => declaresCapabilityPrefix(a.manifest, prefixes));
  if (matching.length > 1) {
    console.error(`at most one app may declare a ${label} capability in one \`berth os\` instance — found ${matching.length}: ${matching.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }
}

export function assertAtMostOneBrowserApp(apps: OsAppSpec[]): void {
  assertAtMostOne(apps, ["browser:"], "browser:*");
}

export function assertAtMostOneTerminalApp(apps: OsAppSpec[]): void {
  assertAtMostOne(apps, ["terminal:"], "terminal:*");
}

export function assertAtMostOneMeshApp(apps: OsAppSpec[]): void {
  assertAtMostOne(apps, ["network:peer:"], "network:peer:*");
}

/** browser:navigate:* and network:host:* both trigger the same shared-port egress broker — see multi-app.ts's assertAtMostOneEgressBrokerApp. */
export function assertAtMostOneEgressBrokerApp(apps: OsAppSpec[]): void {
  assertAtMostOne(apps, ["browser:navigate:", "network:host:"], "browser:navigate:*/network:host:*");
}
