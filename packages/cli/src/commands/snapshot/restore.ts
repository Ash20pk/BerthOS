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

    // A snapshot carries no credentials by construction (REMEDIATION.md 5.5),
    // which means a restored sandbox boots without whatever the original had.
    // Said here rather than left for the app to fail on: "the agent can't
    // reach the model provider" is a much harder thing to diagnose from
    // inside the container than from this line.
    if (restored.redactedEnvNames.length > 0) {
      this.warn(
        `this snapshot deliberately did not capture ${restored.redactedEnvNames.length} credential-valued environment ` +
          `variable(s): ${restored.redactedEnvNames.join(", ")}. The restored sandbox boots without them — set them in ` +
          `the environment of whatever drives it (see docs/secrets-reference.md).`,
      );
    }

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
