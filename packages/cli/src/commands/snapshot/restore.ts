import { Command, Args, Flags } from "@oclif/core";
import Docker from "dockerode";
import { restoreSnapshot, startContainer, snapshotDirFor } from "@berth/docker-orchestrator";
import { loadManifestOrExit } from "../../util/manifest.js";

export default class SnapshotRestore extends Command {
  static override description =
    "Restore a snapshot into a fresh sandbox — loads the committed image back into Docker and pre-populates the new container's semantic-fs context-data from the archived one before it boots";
  static override args = {
    id: Args.string({ required: true, description: "snapshot id, as printed by `berth snapshot create`" }),
  };
  static override flags = {
    name: Flags.string({ description: "name for the restored container (defaults to berth-restored-<appName>-<id>)" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotRestore);
    const manifest = await loadManifestOrExit(process.cwd());
    const docker = new Docker();

    const dir = snapshotDirFor(manifest.name, args.id);
    this.log(`Loading snapshot ${args.id} from ${dir}...`);
    const restored = await restoreSnapshot(dir, docker);

    const containerName = flags.name ?? `berth-restored-${manifest.name}-${args.id}`;
    this.log(`Starting a fresh sandbox from the restored image (${restored.metadata.imageTag})...`);
    const running = await startContainer({
      image: restored.metadata.imageTag,
      name: containerName,
      manifest: restored.manifest,
      workingDir: "/app",
      extraBinds: [`${restored.contextDataHostDir}:${restored.metadata.contextDataPath}`],
      env: restored.env,
      docker,
    });

    this.log(`Restored container "${containerName}" started (id ${running.container.id.slice(0, 12)}).`);
    this.log(`Note: BERTH_TOKEN_SECRET is regenerated fresh on this boot, by design — see docs/computer-snapshots-reference.md.`);
  }
}
