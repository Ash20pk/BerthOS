import { Command, Args, Flags } from "@oclif/core";
import Docker from "dockerode";
import { invokeAppExport } from "@berth/docker-orchestrator";

export default class Rpc extends Command {
  static override description =
    "Call a resident app's RPC export directly — the documented host-side entry point for reaching a specific app in a multi-app-per-sandbox container";
  static override args = {
    appName: Args.string({ required: true, description: "the app's name (as declared in its berth.yml)" }),
  };
  static override flags = {
    container: Flags.string({ description: "container name to reach (defaults to berth-dev-<appName>)" }),
    export: Flags.string({ required: true, description: "export name to call" }),
    input: Flags.string({ description: "JSON input for the export" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Rpc);
    const docker = new Docker();
    const containerName = flags.container ?? `berth-dev-${args.appName}`;
    const container = docker.getContainer(containerName);

    let input: unknown;
    if (flags.input) {
      try {
        input = JSON.parse(flags.input);
      } catch (err) {
        this.error(`--input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const response = await invokeAppExport(container, args.appName, {
      id: String(Date.now()),
      export: flags.export,
      input,
    });

    if (response.error) this.error(response.error);
    this.log(JSON.stringify(response.result, null, 2));
  }
}
