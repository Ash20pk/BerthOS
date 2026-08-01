import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { restartContainer, startContainer, stopContainer, streamLogs, watchApp } from "@berth/docker-orchestrator";
import { loadManifestOrExit } from "../util/manifest.js";
import { buildDevImage, devImageTag } from "../util/build.js";
import { resolveDevBindMount } from "../util/workspace.js";
import { resolveApps, assertAtMostOneBrowserApp, assertAtMostOneTerminalApp } from "../util/multi-app.js";

export default class Dev extends Command {
  static override description = "Boot the resident app in a local Agent OS instance, with hot reload";
  static override flags = {
    apps: Flags.string({ description: "comma-separated workspace-relative paths of companion resident apps to run alongside this one" }),
    "grants-server": Flags.string({
      description: "berth-grants server URL to consult for human-approved capability grants, e.g. http://localhost:4874",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Dev);
    const appDir = process.cwd();
    const manifest = await loadManifestOrExit(appDir);
    const docker = new Docker();

    const apps = await resolveApps(appDir, flags.apps, manifest);
    assertAtMostOneBrowserApp(apps);
    assertAtMostOneTerminalApp(apps);
    if (apps.length > 1) this.log(`Running with companion apps: ${apps.slice(1).map((a) => a.name).join(", ")}`);

    this.log(`Building dev image for "${manifest.name}"...`);
    await buildDevImage(appDir, manifest);

    const volumeName = `berth-${manifest.name}-install-marker`;
    await docker.createVolume({ Name: volumeName }).catch(() => {
      /* already exists */
    });

    const { bindMount, workingDir } = resolveDevBindMount(appDir);

    const running = await startContainer({
      image: devImageTag(manifest),
      name: `berth-dev-${manifest.name}`,
      manifest,
      bindMount,
      workingDir,
      installMarkerVolume: volumeName,
      apps:
        apps.length > 1
          ? apps.map((a) => ({ name: a.name, workingDir: `/workspace/${a.relPath}`, manifest: a.manifest }))
          : undefined,
      env: flags["grants-server"] ? { BERTH_GRANTS_SERVER_URL: flags["grants-server"] } : undefined,
      docker,
    });

    this.log(`Container started. Watching ${appDir}/src and berth.yml for changes...`);
    this.printDiagnostics(manifest.name, running.ports);
    void this.tailLogs(running.container);

    const watcher = watchApp(appDir, () => {
      this.log("Change detected — restarting container...");
      void restartContainer(running.container)
        .then(() => this.log("Restarted."))
        .catch((err) => this.error(err instanceof Error ? err.message : String(err), { exit: false }));
    });

    const shutdown = async () => {
      this.log("\nShutting down...");
      await watcher.close();
      await stopContainer(running.container);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  private printDiagnostics(appName: string, ports: { vnc?: number; novnc?: number; cdp?: number; terminal?: number }): void {
    if (ports.novnc) this.log(`[berth:dev] noVNC:    http://localhost:${ports.novnc}/vnc.html`);
    if (ports.vnc) this.log(`[berth:dev] VNC:      localhost:${ports.vnc}`);
    if (ports.cdp) this.log(`[berth:dev] CDP:      http://localhost:${ports.cdp}`);
    if (!ports.novnc && !ports.vnc && !ports.cdp) {
      this.log(`[berth:dev] "${appName}" declares no browser:* capability — no VNC/CDP ports exposed`);
    }
    if (ports.terminal) this.log(`[berth:dev] Terminal: http://localhost:${ports.terminal}`);
    else this.log(`[berth:dev] "${appName}" declares no terminal:* capability — no terminal port exposed`);
  }

  private async tailLogs(container: Docker.Container): Promise<void> {
    for await (const chunk of streamLogs(container)) {
      process.stdout.write(
        chunk
          .split("\n")
          .filter(Boolean)
          .map((line) => `[berth:dev] ${line}`)
          .join("\n") + "\n",
      );
    }
  }
}
