import { Command, Args, Flags } from "@oclif/core";
import Docker from "dockerode";
import { streamLogs } from "@berth/docker-orchestrator";

export default class Logs extends Command {
  static override description =
    "Stream logs from a resident app's already-running local sandbox (started via `berth dev`) — re-attaches to an existing container rather than requiring a fresh deploy";
  static override args = {
    appName: Args.string({ required: true, description: "the app's name (as declared in its berth.yml)" }),
  };
  static override flags = {
    container: Flags.string({ description: "container name to reach (defaults to berth-dev-<appName>)" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Logs);
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
}
