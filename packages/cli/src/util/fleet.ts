import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeployAdapter } from "@berth/adapter-core";
import { createE2bAdapter } from "@berth/adapter-e2b";
import { createDaytonaAdapter } from "@berth/adapter-daytona";

interface FleetAlias {
  adapter: "e2b" | "daytona";
  env?: Record<string, string>;
}

type FleetConfig = Record<string, FleetAlias>;

/** `~/.berthrc` maps fleet aliases (e.g. "prod") to a concrete adapter + env, so `--fleet=prod` doesn't have to be a literal adapter name. */
async function loadFleetConfig(): Promise<FleetConfig> {
  try {
    const raw = await readFile(join(homedir(), ".berthrc"), "utf-8");
    return JSON.parse(raw) as FleetConfig;
  } catch {
    return {};
  }
}

function instantiate(adapterName: "e2b" | "daytona"): DeployAdapter {
  return adapterName === "e2b" ? createE2bAdapter() : createDaytonaAdapter();
}

export async function resolveFleet(fleetName: string): Promise<{ adapter: DeployAdapter; env?: Record<string, string> }> {
  if (fleetName === "e2b" || fleetName === "daytona") {
    return { adapter: instantiate(fleetName) };
  }

  const config = await loadFleetConfig();
  const alias = config[fleetName];
  if (!alias) {
    throw new Error(
      `unknown fleet "${fleetName}" — expected "e2b", "daytona", or an alias defined in ~/.berthrc (e.g. {"prod": {"adapter": "e2b"}})`,
    );
  }
  return { adapter: instantiate(alias.adapter), env: alias.env };
}
