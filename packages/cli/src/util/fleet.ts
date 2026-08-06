import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeployAdapter } from "@berth/adapter-core";
import { createE2bAdapter } from "@berth/adapter-e2b";
import { createDaytonaAdapter } from "@berth/adapter-daytona";
import { createK8sAdapter } from "@berth/adapter-k8s";

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

/** `~/.berthrc` maps fleet aliases (e.g. "prod") to a concrete adapter + env, so `--fleet=prod` doesn't have to be a literal adapter name. */
async function loadFleetConfig(configPath: string): Promise<FleetConfig> {
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as FleetConfig;
  } catch {
    return {};
  }
}

function instantiate(adapterName: "e2b" | "daytona" | "k8s"): DeployAdapter {
  if (adapterName === "e2b") return createE2bAdapter();
  if (adapterName === "daytona") return createDaytonaAdapter();
  return createK8sAdapter();
}

/** `configPath` defaults to ~/.berthrc — overridable so tests don't touch the real one. */
export async function resolveFleet(
  fleetName: string,
  configPath = DEFAULT_BERTHRC_PATH,
): Promise<{ adapter: DeployAdapter; env?: Record<string, string>; count: number; region?: string }> {
  if (fleetName === "e2b" || fleetName === "daytona" || fleetName === "k8s") {
    return { adapter: instantiate(fleetName), count: 1 };
  }

  const config = await loadFleetConfig(configPath);
  const alias = config[fleetName];
  if (!alias) {
    throw new Error(
      `unknown fleet "${fleetName}" — expected "e2b", "daytona", "k8s", or an alias defined in ~/.berthrc (e.g. {"prod": {"adapter": "e2b"}})`,
    );
  }
  return { adapter: instantiate(alias.adapter), env: alias.env, count: alias.count ?? 1, region: alias.region };
}
