import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeployAdapter } from "@berthos/adapter-core";

interface FleetAlias {
  adapter: "e2b" | "daytona" | "k8s";
  env?: Record<string, string>;
  /** How many instances `berth deploy --fleet=<alias>` starts by default. Overridable per-invocation via --count. Defaults to 1. */
  count?: number;
  /** Default region/zone for this alias — see DeployTarget.region for what each adapter does with it. Overridable per-invocation via --region. */
  region?: string;
}

type FleetConfig = Record<string, FleetAlias>;

const DEFAULT_BERTHRC_PATH = join(homedir(), ".berthrc");

/**
 * `~/.berthrc`'s `env` is where a fleet alias's provider API keys actually
 * live (`berth deploy --fleet=prod` passes them straight to the adapter), so a
 * group- or world-readable one hands every local account the credentials for
 * every remote sandbox this machine can start.
 *
 * Warns rather than chmod-ing or refusing. This is the developer's own file,
 * not one Berth created: silently rewriting its mode is a surprise in the
 * other direction, and refusing to read it would break every existing
 * `--fleet` invocation on an upgrade. The warning names the fix and only
 * fires when there is actually something sensitive in the file — an alias
 * file with no `env` at all is just a name-to-adapter map.
 */
async function warnIfConfigIsReadableByOthers(configPath: string, config: FleetConfig): Promise<void> {
  const carriesCredentials = Object.values(config).some((alias) => alias.env && Object.keys(alias.env).length > 0);
  if (!carriesCredentials) return;
  try {
    const info = await stat(configPath);
    if ((info.mode & 0o077) === 0) return;
  } catch {
    return;
  }
  console.warn(
    `[berth] WARNING: ${configPath} is readable by other users on this machine (mode is not 0600) and its fleet aliases carry environment values — ` +
      `for most people that means provider API keys. Fix it with: chmod 600 ${configPath}`,
  );
}

/** `~/.berthrc` maps fleet aliases (e.g. "prod") to a concrete adapter + env, so `--fleet=prod` doesn't have to be a literal adapter name. */
async function loadFleetConfig(configPath: string): Promise<FleetConfig> {
  let config: FleetConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf-8")) as FleetConfig;
  } catch {
    // No file, or one this CLI can't parse — resolveFleet() reports the
    // unknown-alias error, which is the actionable message either way.
    return {};
  }
  // Outside the try on purpose: a permission warning must never be able to
  // turn a readable config into an empty one.
  await warnIfConfigIsReadableByOthers(configPath, config);
  return config;
}

/**
 * Loads exactly the one adapter that was asked for.
 *
 * These were static imports, which made all three provider SDKs — and their
 * transitive trees — a runtime dependency of every `berth` invocation,
 * including `berth doctor` on a machine that will never deploy anywhere. They
 * are also the packages most likely to be absent: each is an optional peer, so
 * a CLI installed for local sandboxing does not carry three cloud SDKs.
 *
 * `--fleet=e2b` must not fail because the Kubernetes client is missing, which
 * is exactly what one `import` per adapter at module scope would do.
 */
async function instantiate(adapterName: "e2b" | "daytona" | "k8s"): Promise<DeployAdapter> {
  try {
    if (adapterName === "e2b") return (await import("@berthos/adapter-e2b")).createE2bAdapter();
    if (adapterName === "daytona") return (await import("@berthos/adapter-daytona")).createDaytonaAdapter();
    return (await import("@berthos/adapter-k8s")).createK8sAdapter();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        `deploying to "${adapterName}" needs its adapter, which is not installed.\n\n` +
          `  npm install @berthos/adapter-${adapterName}\n\n` +
          `@berthos/cli ships without the cloud adapters: each pulls in a provider SDK, and a CLI ` +
          `used for local sandboxing needs none of them. Install only the one you deploy to.`,
      );
    }
    throw err;
  }
}

/** `configPath` defaults to ~/.berthrc — overridable so tests don't touch the real one. */
export async function resolveFleet(
  fleetName: string,
  configPath = DEFAULT_BERTHRC_PATH,
): Promise<{ adapter: DeployAdapter; env?: Record<string, string>; count: number; region?: string }> {
  if (fleetName === "e2b" || fleetName === "daytona" || fleetName === "k8s") {
    return { adapter: await instantiate(fleetName), count: 1 };
  }

  const config = await loadFleetConfig(configPath);
  const alias = config[fleetName];
  if (!alias) {
    throw new Error(
      `unknown fleet "${fleetName}" — expected "e2b", "daytona", "k8s", or an alias defined in ~/.berthrc (e.g. {"prod": {"adapter": "e2b"}})`,
    );
  }
  return { adapter: await instantiate(alias.adapter), env: alias.env, count: alias.count ?? 1, region: alias.region };
}
