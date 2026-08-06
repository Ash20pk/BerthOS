import { Command, Args, Flags } from "@oclif/core";
import Docker from "dockerode";
import { restoreSnapshot, startContainer, snapshotDirFor } from "@berth/docker-orchestrator";
import { loadManifestOrExit } from "../../util/manifest.js";
import { resolveFleet } from "../../util/fleet.js";

export default class SnapshotRestore extends Command {
  static override description =
    "Restore a snapshot into a fresh sandbox — loads the committed image back into Docker and pre-populates the new container's semantic-fs context-data from the archived one before it boots. With --fleet, resumes a paused remote instance instead (E2B only — see gaps.md gap #29)";
  static override args = {
    id: Args.string({ required: true, description: "snapshot id (local mode) or instance id (with --fleet), as printed by `berth snapshot create`" }),
  };
  static override flags = {
    name: Flags.string({ description: "name for the restored container (defaults to berth-restored-<appName>-<id>); local mode only" }),
    fleet: Flags.string({ description: "resume a paused remote instance on this fleet alias instead of restoring a local Docker snapshot" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotRestore);

    if (flags.fleet) {
      await this.runRemote(args.id, flags.fleet);
      return;
    }

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
      extraBinds: [
        `${restored.contextDataHostDir}:${restored.metadata.contextDataPath}`,
        `${restored.contextIndexDbHostFile}:${restored.metadata.contextIndexDbPath}`,
      ],
      env: restored.env,
      docker,
    });

    this.log(`Restored container "${containerName}" started (id ${running.container.id.slice(0, 12)}).`);
    this.log(`Note: BERTH_TOKEN_SECRET is regenerated fresh on this boot, by design — see docs/computer-snapshots-reference.md.`);
  }

  private async runRemote(instanceId: string, fleetName: string): Promise<void> {
    const { adapter } = await resolveFleet(fleetName);
    if (!adapter.resume) {
      this.error(`${adapter.name} adapter doesn't support resume() — no pause/resume primitive available (see gaps.md gap #29)`);
    }
    this.log(`Resuming instance "${instanceId}" on fleet "${fleetName}"...`);
    const handle = await adapter.resume(instanceId);
    this.log(`Resumed "${handle.id}" — status: ${await handle.status()}.`);
  }
}
