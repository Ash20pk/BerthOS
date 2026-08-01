import { Command } from "@oclif/core";
import { listSnapshots } from "@berth/docker-orchestrator";
import { loadManifestOrExit } from "../../util/manifest.js";

export default class SnapshotList extends Command {
  static override description = "List snapshots recorded locally for this app";

  async run(): Promise<void> {
    const manifest = await loadManifestOrExit(process.cwd());
    const snapshots = await listSnapshots(manifest.name);

    if (snapshots.length === 0) {
      this.log(`No snapshots recorded for "${manifest.name}".`);
      return;
    }

    this.log(`Snapshots for "${manifest.name}":`);
    for (const snapshot of snapshots) {
      this.log(`  ${snapshot.id}  created ${snapshot.createdAt}  image ${snapshot.imageTag}`);
    }
  }
}
