import { Command, Args, Flags } from "@oclif/core";
import Docker from "dockerode";
import { invokeAppExport } from "@berthos/docker-orchestrator";
import { resolveSandbox } from "../vm/config.js";
import { devSandboxName } from "../vm/paths.js";
import { VmSandbox } from "../vm/sandbox.js";

export default class Rpc extends Command {
  static override description =
    "Call a resident app's RPC export directly — the documented host-side entry point for reaching a specific app in a multi-app-per-sandbox container";
  static override args = {
    appName: Args.string({ required: true, description: "the app's name (as declared in its berth.yml)" }),
  };
  static override flags = {
    container: Flags.string({ description: "container (or microVM sandbox) name to reach (defaults to berth-dev-<appName>)" }),
    runtime: Flags.string({
      description: "where the sandbox runs: docker (default) or vm (defaults to BERTH_SANDBOX, then \"sandbox\" in ~/.berth/config.json)",
      options: ["docker", "vm"],
    }),
    export: Flags.string({ required: true, description: "export name to call" }),
    input: Flags.string({ description: "JSON input for the export" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Rpc);
    let input: unknown;
    if (flags.input) {
      try {
        input = JSON.parse(flags.input);
      } catch (err) {
        this.error(`--input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let sandbox;
    try {
      sandbox = resolveSandbox(flags.runtime);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }
    if (sandbox === "vm") return this.callVm(flags.container ?? devSandboxName(args.appName), args.appName, flags.export, input);

    const docker = new Docker();
    const containerName = flags.container ?? `berth-dev-${args.appName}`;
    const container = docker.getContainer(containerName);
    const response = await invokeAppExport(container, args.appName, {
      id: String(Date.now()),
      export: flags.export,
      input,
    });

    if (response.error) this.error(response.error);
    this.log(JSON.stringify(response.result, null, 2));
  }

  /** The VM's rpc-<i>.sock for the named app; any app in the sandbox, companions included. */
  private async callVm(name: string, appName: string, exportName: string, input: unknown): Promise<void> {
    const vm = await VmSandbox.find(name, { onStale: (why) => this.warn(`"${name}" was stale (${why}); cleaned up its run dir`) }).catch((err: Error) => this.error(err.message));
    if (!vm) this.error(`no running microVM sandbox named "${name}" — start it with \`berth dev --runtime vm\` in the app's directory, or pass --container`);
    const index = vm.appIndex(appName);
    if (index === undefined) {
      vm.detach();
      this.error(`"${name}" runs ${vm.record.apps.map((a) => a.name).join(", ")}, not "${appName}"`);
    }
    try {
      const rpc = await vm.rpc(index);
      const response = await rpc.call({ id: String(Date.now()), export: exportName, input });
      if (response.error) this.error(response.error);
      this.log(JSON.stringify(response.result, null, 2));
    } finally {
      vm.detach();
    }
  }
}
