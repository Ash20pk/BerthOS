import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { createSnapshot } from "@berth/docker-orchestrator";
import { loadManifestOrExit } from "../../util/manifest.js";
import { resolveFleet } from "../../util/fleet.js";
import { resolveInstanceId } from "../../util/resolve-instance.js";

export default class SnapshotCreate extends Command {
  static override description =
    "Snapshot a running resident app's sandbox — its filesystem/packages (a real Docker image commit) and its semantic-fs context-data — so `berth snapshot restore` can bring it back later. With --fleet, pauses (E2B) or snapshots (Daytona) a remote instance instead of a local Docker container";
  static override flags = {
    container: Flags.string({ description: "container name to snapshot (defaults to berth-dev-<appName>); local mode only" }),
    fleet: Flags.string({ description: "snapshot/pause a remote instance on this fleet alias instead of a local dev container" }),
    instance: Flags.string({ description: "specific instance id (with --fleet) — skips the appName lookup in the fleet's local state" }),
    name: Flags.string({ description: "name for the remote snapshot (with --fleet, on a provider that snapshots rather than pauses); defaults to <appName>-<timestamp>" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotCreate);
    const manifest = await loadManifestOrExit(process.cwd());

    if (flags.fleet) {
      await this.runRemote(manifest.name, flags.fleet, flags.instance, flags.name);
      return;
    }

    const docker = new Docker();
    const containerName = flags.container ?? `berth-dev-${manifest.name}`;
    const container = docker.getContainer(containerName);

    let env: Record<string, string> = {};
    try {
      const inspect = await container.inspect();
      // Captures the container's real inherited env — including whatever
      // berth dev/deploy actually started it with (e.g. BERTH_GRANTS_SERVER_URL)
      // — not just what's in this process's own environment.
      for (const entry of inspect.Config.Env ?? []) {
        const eq = entry.indexOf("=");
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
    } catch {
      this.error(
        `no running container named "${containerName}" — is "berth dev" running for this app? (pass --container if it's under a different name)`,
      );
    }

    this.log(`Snapshotting "${manifest.name}" (this commits a real image layer + archives its context-data)...`);
    const { id, dir } = await createSnapshot({ container, appName: manifest.name, manifest, env, docker });

    this.log(`Snapshot ${id} created at ${dir}`);
    this.log(`Restore it with: berth snapshot restore ${id}`);
  }

  private async runRemote(appName: string, fleetName: string, instanceId: string | undefined, snapshotName: string | undefined): Promise<void> {
    let id: string;
    try {
      id = await resolveInstanceId(fleetName, appName, instanceId);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }

    const { adapter } = await resolveFleet(fleetName);
    if (!adapter.connect) {
      this.error(`${adapter.name} adapter doesn't support reconnecting to an existing instance by id`);
    }
    const handle = await adapter.connect(id);

    // Two structurally different providers, two structurally different
    // primitives — pause() (E2B: this exact instance, paused in place, same
    // id, resume()-able) and snapshot() (Daytona: a new reusable template,
    // this instance keeps running unchanged) aren't interchangeable, so this
    // picks whichever one the adapter actually supports rather than forcing
    // both into one fake unified operation.
    if (adapter.pause) {
      await adapter.pause(handle);
      this.log(`Paused instance "${id}" on fleet "${fleetName}".`);
      this.log(`Resume it with: berth snapshot restore ${id} --fleet ${fleetName}`);
      return;
    }
    if (adapter.snapshot) {
      const name = snapshotName ?? `${appName}-${Date.now()}`;
      await adapter.snapshot(handle, name);
      this.log(`Snapshot "${name}" created on fleet "${fleetName}" from instance "${id}" (still running, unaffected).`);
      return;
    }
    this.error(`${adapter.name} adapter doesn't support pause() or snapshot() — no remote snapshot primitive available`);
  }
}
