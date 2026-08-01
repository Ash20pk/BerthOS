import { Command, Args, Flags } from "@oclif/core";
import Docker from "dockerode";
import { streamLogs } from "@berth/docker-orchestrator";
import { resolveFleet } from "../util/fleet.js";
import { resolveInstanceId } from "../util/resolve-instance.js";

export default class Logs extends Command {
  static override description =
    "Stream logs from a resident app's already-running sandbox — re-attaches to an existing local dev container, or (with --fleet) a remote/fleet instance, rather than requiring a fresh deploy";
  static override args = {
    appName: Args.string({ required: true, description: "the app's name (as declared in its berth.yml)" }),
  };
  static override flags = {
    container: Flags.string({ description: "container name to reach (defaults to berth-dev-<appName>); local mode only" }),
    fleet: Flags.string({ description: "re-attach to a remote instance on this fleet alias instead of a local dev container" }),
    instance: Flags.string({ description: "specific instance id to attach to (with --fleet) — skips the appName lookup in the fleet's local state" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Logs);

    if (flags.fleet) {
      await this.runRemote(args.appName, flags.fleet, flags.instance);
      return;
    }

    const docker = new Docker();
    const containerName = flags.container ?? `berth-dev-${args.appName}`;
    const container = docker.getContainer(containerName);

    try {
      await container.inspect();
    } catch {
      this.error(
        `no running container named "${containerName}" — is "berth dev" running for this app? (pass --container if it's under a different name)`,
      );
    }

    for await (const chunk of streamLogs(container)) {
      process.stdout.write(chunk);
    }
  }

  private async runRemote(appName: string, fleetName: string, instanceId?: string): Promise<void> {
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
    if (adapter.name === "daytona") {
      this.warn("daytona has no log-streaming API in the installed SDK version — this will connect but print nothing.");
    }

    const handle = await adapter.connect(id);
    for await (const line of handle.streamLogs()) {
      process.stdout.write(`${line}\n`);
    }
  }
}
