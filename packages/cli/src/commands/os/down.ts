import { Args, Command } from "@oclif/core";
import Docker from "dockerode";
import { readOsState, removeImageKeepingCache, removeOsState, stopContainer } from "@berthos/docker-orchestrator";

export default class OsDown extends Command {
  static override description = "Tear down a Berth OS instance started with `berth os up`";

  static override args = {
    name: Args.string({ required: true, description: "name passed to `berth os up`" }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(OsDown);

    const state = await readOsState(args.name);
    if (!state) {
      this.error(`no OS instance named "${args.name}" — nothing to tear down (see \`berth os status\`)`);
    }

    const docker = new Docker();
    const container = docker.getContainer(state.containerName);
    try {
      await stopContainer(container);
    } catch (err) {
      this.warn(`could not stop container ${state.containerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Keeps the parent layers, which are the build cache for the next
    // `berth os up` (see removeImageKeepingCache).
    await removeImageKeepingCache(docker, state.image);

    await removeOsState(args.name);
    this.log(`"${args.name}" is down.`);
  }
}
