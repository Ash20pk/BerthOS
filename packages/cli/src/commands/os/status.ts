import { Args, Command } from "@oclif/core";
import Docker from "dockerode";
import { readOsState, listOsNames } from "@berth/docker-orchestrator";
import { isContainerRunning } from "../../util/os-docker.js";

export default class OsStatus extends Command {
  static override description = "List Berth OS instances started with `berth os up` and whether they're still running";

  static override args = {
    name: Args.string({ description: "show just this one (omit to list every recorded instance)" }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(OsStatus);
    const docker = new Docker();

    const names = args.name ? [args.name] : await listOsNames();
    if (names.length === 0) {
      this.log("No `berth os` instances recorded. Run `berth os up` first.");
      return;
    }

    for (const name of names) {
      const state = await readOsState(name);
      if (!state) {
        this.log(`${name}: no record`);
        continue;
      }
      const running = await isContainerRunning(docker, state.containerName);
      const httpRpcSuffix = state.httpRpc ? `, http-rpc: ${state.httpRpc.url}` : "";
      this.log(
        `${name}: ${running ? "running" : "stopped"} (container ${state.containerName}, apps: ${state.apps.map((a) => a.name).join(", ")}${httpRpcSuffix})`,
      );
    }
  }
}
