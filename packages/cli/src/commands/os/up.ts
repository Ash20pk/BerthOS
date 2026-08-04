import { Args, Command, Flags } from "@oclif/core";
import { resolve } from "node:path";
import Docker from "dockerode";
import { startContainer, writeOsState, readOsState } from "@berth/docker-orchestrator";
import { buildOsImage } from "../../util/build.js";
import {
  loadOsConfigFile,
  resolveOsApps,
  assertAtMostOneBrowserApp,
  assertAtMostOneTerminalApp,
  assertAtMostOneMeshApp,
  assertAtMostOneEgressBrokerApp,
} from "../../util/os-config.js";
import { isContainerRunning, removeStaleContainer } from "../../util/os-docker.js";

export default class OsUp extends Command {
  static override description =
    "Boot a long-lived Berth OS (one or more resident apps) that agent code can connect to instantly instead of paying build+boot cost on every run — see docs/berth-os-reference.md";

  static override args = {
    name: Args.string({ description: "name for this OS instance — used by `berth os down`/`status` and Computer.connect()/createAgent({ connect })" }),
  };

  static override flags = {
    apps: Flags.string({ description: "comma-separated resident app directories to load (paths relative to cwd)" }),
    config: Flags.string({ description: "path to an OS config file (name + apps: [...] + network?) instead of --apps" }),
    network: Flags.string({ description: "join a Docker network (see Crew.networked())" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(OsUp);

    if (!flags.apps && !flags.config) {
      this.error("pass --apps=<dir1>,<dir2> or --config=<path> — see `berth os up --help`");
    }
    if (flags.apps && flags.config) {
      this.error("pass either --apps or --config, not both");
    }

    let appDirs: string[];
    let configName: string | undefined;
    let network = flags.network;

    if (flags.config) {
      const cfg = await loadOsConfigFile(flags.config);
      appDirs = cfg.appDirs;
      configName = cfg.name;
      network = network ?? cfg.network;
    } else {
      appDirs = flags
        .apps!.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => resolve(p));
    }

    const apps = await resolveOsApps(appDirs);
    assertAtMostOneBrowserApp(apps);
    assertAtMostOneTerminalApp(apps);
    assertAtMostOneMeshApp(apps);
    assertAtMostOneEgressBrokerApp(apps);

    const name = args.name ?? configName ?? apps[0]!.name;

    const docker = new Docker();

    const existing = await readOsState(name);
    if (existing) {
      if (await isContainerRunning(docker, existing.containerName)) {
        this.log(`"${name}" is already up (container ${existing.containerName}). Run \`berth os down ${name}\` first to rebuild it.`);
        return;
      }
      // Not running, but still holding the name (crashed, OOM-killed, or
      // stopped outside `berth os down`) — clear it so createContainer()
      // below doesn't fail with a raw "name already in use" 409.
      if (await removeStaleContainer(docker, existing.containerName)) {
        this.warn(`"${name}" had a stopped container (${existing.containerName}) left over from a previous run — removed it before rebuilding.`);
      }
    }

    const [primary, ...companions] = apps;
    this.log(`Building OS image for "${name}" (${apps.map((a) => a.name).join(", ")})...`);
    const image = await buildOsImage(name, primary!, companions);

    const containerName = `berth-os-${name}`;
    this.log(`Starting container ${containerName}...`);
    await startContainer({
      image,
      name: containerName,
      manifest: primary!.manifest,
      workingDir: `/app/apps/${primary!.name}`,
      apps: apps.map((a) => ({ name: a.name, workingDir: `/app/apps/${a.name}`, manifest: a.manifest })),
      network,
      docker,
    });

    await writeOsState({
      name,
      containerName,
      image,
      apps: apps.map((a) => ({ name: a.name, appDir: a.appDir })),
      network,
      startedAt: new Date().toISOString(),
    });

    this.log(`"${name}" is up.`);
    this.log(`Connect from agent code: createAgent({ connect: "${name}", llm }) or Computer.connect({ name: "${name}" }).`);
    this.log(`Run \`berth os down ${name}\` when you're done with it.`);
  }
}
