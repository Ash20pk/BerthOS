import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Nothing persisted a started DeployHandle's id anywhere before this —
 * `berth deploy` printed it once and moved on. This is what makes a later
 * `berth fleet status` possible at all: a small local record of what this
 * CLI has started against each fleet alias, keyed by fleet name (not by app,
 * since one fleet alias can host more than one app's instances over time).
 */
export interface FleetInstanceRecord {
  id: string;
  appName: string;
  startedAt: string;
  /**
   * Ports `berth fleet status` should try adapter.previewUrl() against for
   * this instance — computed once at `berth deploy` time from the deployed
   * app's own `expose.preview` opt-in and declared browser:* or terminal:*
   * capabilities (fleet-state has no other way to know this later, since
   * it doesn't store the deployed app's manifest). Absent/empty means
   * preview wasn't opted into, or the adapter/instance predates this field.
   */
  previewPorts?: number[];
}

export interface FleetStateFile {
  fleet: string;
  instances: FleetInstanceRecord[];
}

const DEFAULT_FLEETS_DIR = join(homedir(), ".berth", "fleets");

function stateFilePath(fleetName: string, fleetsDir: string): string {
  return join(fleetsDir, `${fleetName}.json`);
}

/** `fleetsDir` defaults to ~/.berth/fleets — overridable so tests don't touch the real one. */
export async function readFleetState(fleetName: string, fleetsDir = DEFAULT_FLEETS_DIR): Promise<FleetStateFile> {
  try {
    const raw = await readFile(stateFilePath(fleetName, fleetsDir), "utf-8");
    return JSON.parse(raw) as FleetStateFile;
  } catch {
    return { fleet: fleetName, instances: [] };
  }
}

export async function appendFleetInstances(
  fleetName: string,
  instances: FleetInstanceRecord[],
  fleetsDir = DEFAULT_FLEETS_DIR,
): Promise<void> {
  const state = await readFleetState(fleetName, fleetsDir);
  state.instances.push(...instances);
  await mkdir(fleetsDir, { recursive: true });
  await writeFile(stateFilePath(fleetName, fleetsDir), JSON.stringify(state, null, 2));
}

/**
 * Drops the given ids from a fleet's recorded instances — the missing half
 * of appendFleetInstances(), needed once something (e.g. `berth fleet
 * scale`) actually tears an instance down rather than only ever starting
 * new ones. A no-op for an id that isn't recorded (already gone, or never
 * was), rather than an error — the caller's own teardown() call is the
 * thing that's supposed to fail loudly if the instance itself is unreachable.
 */
export async function removeFleetInstances(fleetName: string, ids: string[], fleetsDir = DEFAULT_FLEETS_DIR): Promise<void> {
  const state = await readFleetState(fleetName, fleetsDir);
  const idSet = new Set(ids);
  state.instances = state.instances.filter((instance) => !idSet.has(instance.id));
  await mkdir(fleetsDir, { recursive: true });
  await writeFile(stateFilePath(fleetName, fleetsDir), JSON.stringify(state, null, 2));
}
