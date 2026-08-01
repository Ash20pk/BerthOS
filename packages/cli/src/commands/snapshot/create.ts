import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { createSnapshot } from "@berth/docker-orchestrator";
import { loadManifestOrExit } from "../../util/manifest.js";

export default class SnapshotCreate extends Command {
  static override description =
    "Snapshot a running resident app's sandbox — its filesystem/packages (a real Docker image commit) and its semantic-fs context-data — so `berth snapshot restore` can bring it back later";
  static override flags = {
    container: Flags.string({ description: "container name to snapshot (defaults to berth-dev-<appName>)" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotCreate);
    const manifest = await loadManifestOrExit(process.cwd());
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
}
