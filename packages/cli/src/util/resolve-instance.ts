import { readFleetState } from "./fleet-state.js";

/**
 * Turns a `berth logs --fleet <name> <appName>` invocation into a concrete
 * instance id: an explicit `--instance` wins outright, otherwise the most
 * recently started recorded instance for that app on that fleet. Extracted
 * from logs.ts so it's testable against real tmp fleet-state files, the same
 * way util/fleet.ts's resolveFleet() is.
 */
export async function resolveInstanceId(
  fleetName: string,
  appName: string,
  instanceId?: string,
  fleetsDir?: string,
): Promise<string> {
  if (instanceId) return instanceId;

  const state = await readFleetState(fleetName, fleetsDir);
  const matches = state.instances.filter((instance) => instance.appName === appName);
  if (matches.length === 0) {
    throw new Error(
      `no recorded instance for "${appName}" on fleet "${fleetName}" — pass --instance <id> directly, or check "berth fleet status ${fleetName}"`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id).join(", ");
    // Not an error: --count > 1 makes multiple instances of one app on one
    // fleet the realistic case. Pick the most recent, but say so rather than
    // silently guessing among them.
    process.stderr.write(
      `note: ${matches.length} instances of "${appName}" recorded on fleet "${fleetName}" (${ids}) — attaching to the most recently started one. Pass --instance <id> to pick a specific one.\n`,
    );
  }
  return matches[matches.length - 1]!.id;
}
