import { Args, Command, Flags } from "@oclif/core";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
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
    "http-rpc": Flags.boolean({
      description:
        "expose @berth/sdk's HTTP RPC bridge on a host port, for a process with no Docker API access (e.g. a Python client via berth_agents.Computer.connect()) to call this OS's exports over plain HTTP+bearer-token instead of docker exec",
    }),
    "http-rpc-app": Flags.string({
      description: "which loaded app should bind the HTTP RPC bridge, when more than one is loaded (defaults to the first)",
    }),
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

    if (flags["http-rpc-app"] && !flags["http-rpc"]) {
      this.error("--http-rpc-app only makes sense with --http-rpc");
    }
    if (flags["http-rpc-app"] && !apps.some((a) => a.name === flags["http-rpc-app"])) {
      this.error(`--http-rpc-app "${flags["http-rpc-app"]}" isn't one of the loaded apps: ${apps.map((a) => a.name).join(", ")}`);
    }

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

    const httpRpcAppName = flags["http-rpc"] ? (flags["http-rpc-app"] ?? apps[0]!.name) : undefined;
    const httpRpcToken = flags["http-rpc"] ? randomBytes(32).toString("hex") : undefined;

    const containerName = `berth-os-${name}`;
    this.log(`Starting container ${containerName}...`);
    const { ports } = await startContainer({
      image,
      name: containerName,
      manifest: primary!.manifest,
      workingDir: `/app/apps/${primary!.name}`,
      apps: apps.map((a) => ({ name: a.name, workingDir: `/app/apps/${a.name}`, manifest: a.manifest })),
      network,
      httpRpc: flags["http-rpc"] ? { authToken: httpRpcToken!, appName: httpRpcAppName } : undefined,
      docker,
    });

    let httpRpc: { url: string; token: string; app?: string } | undefined;
    if (flags["http-rpc"]) {
      if (!ports.httpRpc) {
        this.error("--http-rpc was requested but the container never published a host port for it");
      }
      const url = `http://127.0.0.1:${ports.httpRpc}`;
      await waitForHttpRpcHealthy(url, httpRpcToken!);
      httpRpc = { url, token: httpRpcToken!, app: apps.length > 1 ? httpRpcAppName : undefined };
    }

    await writeOsState({
      name,
      containerName,
      image,
      apps: apps.map((a) => ({ name: a.name, appDir: a.appDir })),
      network,
      startedAt: new Date().toISOString(),
      httpRpc,
    });

    this.log(`"${name}" is up.`);
    this.log(`Connect from agent code: createAgent({ connect: "${name}", llm }) or Computer.connect({ name: "${name}" }).`);
    if (httpRpc) {
      this.log(`HTTP RPC bridge: ${httpRpc.url} (bearer token recorded in ~/.berth/os/${name}.json — see docs/agents-python-reference.md for the Python client).`);
    }
    this.log(`Run \`berth os down ${name}\` when you're done with it.`);
  }
}

/**
 * A published Docker port can accept TCP connections before the resident
 * app inside has actually finished booting far enough to call
 * startHttpRpcServer() — same reasoning as @berth/agents' computer.ts's own
 * checkHttpRpcHealth()/withReadyRetry(), reimplemented here in the CLI
 * rather than importing it, since @berth/cli depending on @berth/agents just
 * for a 15-line retry loop isn't worth the coupling (unlike `berth eval`,
 * which genuinely needs @berth/agents' EvalRunnable machinery).
 */
async function waitForHttpRpcHealthy(url: string, token: string, ceilingMs = 30_000): Promise<void> {
  const start = Date.now();
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${url}/healthz`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return;
    } catch {
      // not up yet — fall through to the retry/ceiling check below
    }
    if (Date.now() - start >= ceilingMs) {
      throw new Error(`HTTP RPC bridge at ${url} never became healthy within ${ceilingMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2000);
  }
}
