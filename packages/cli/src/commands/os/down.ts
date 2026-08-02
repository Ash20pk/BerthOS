import { Args, Command } from "@oclif/core";
import Docker from "dockerode";
import { readOsState, removeOsState, stopContainer } from "@berth/docker-orchestrator";

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
    await docker
      .getImage(state.image)
      .remove()
      .catch(() => {
        /* already reclaimed, or never fully built — fine either way */
      });

    await removeOsState(args.name);
    this.log(`"${args.name}" is down.`);
  }
}
