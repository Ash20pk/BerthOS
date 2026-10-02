import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import {
  restartContainer,
  stopContainer,
  streamLogs,
  watchApp,
  declaresBrowserCapability,
  declaresTerminalCapability,
  needsBrowserPorts,
  needsTerminalPort,
} from "@berthos/docker-orchestrator";
import type { BerthManifest } from "@berthos/manifest-schema";
import { loadManifestOrExit } from "../util/manifest.js";
import { resolveSandbox } from "../vm/config.js";
import { runDevVm } from "../vm/dev.js";
import { bootDevContainer } from "../util/dev-boot.js";
import { describeEnvNames, envFlags, readEnvFlags, undeclaredEnvNames } from "../util/env-args.js";
import {
  resolveApps,
  assertAtMostOneBrowserApp,
  assertAtMostOneTerminalApp,
  assertAtMostOneMeshApp,
  assertAtMostOneEgressBrokerApp,
} from "../util/multi-app.js";

export default class Dev extends Command {
  static override description = "Boot the resident app in a local Agent OS instance, with hot reload";
  static override flags = {
    apps: Flags.string({ description: "comma-separated workspace-relative paths of companion resident apps to run alongside this one" }),
    runtime: Flags.string({
      description: "where the sandbox runs: docker (default) or vm, a local microVM (see docs/local-vm.md). Defaults to BERTH_SANDBOX, then \"sandbox\" in ~/.berth/config.json",
      options: ["docker", "vm"],
    }),
    "mesh-coordinator": Flags.string({
      description: "berth-mesh-coordinator URL for network:peer:* apps, e.g. http://localhost:4875 (see docs/mesh-reference.md)",
    }),
    ...envFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Dev);
    const appDir = process.cwd();
    const manifest = await loadManifestOrExit(appDir);
    let sandbox;
    try {
      sandbox = resolveSandbox(flags.runtime);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }

    const apps = await resolveApps(appDir, flags.apps, manifest);
    let env: Record<string, string> = {};
    try {
      env = await readEnvFlags(flags);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }
    const undeclared = undeclaredEnvNames(env, apps);
    if (undeclared.length > 0) {
      this.warn(
        `no app declares ${describeEnvNames(undeclared)} under secrets:, so every app in this sandbox can read ${undeclared.length === 1 ? "it" : "them"}. Declare a secret in the berth.yml of the app that needs it to deliver it to that app alone — see docs/secrets-reference.md.`,
      );
    }
    if (sandbox === "vm") {
      if (flags["mesh-coordinator"]) this.error("--mesh-coordinator needs network:peer, which the microVM runtime doesn't have; use --runtime docker");
      assertAtMostOneEgressBrokerApp(apps);
      if (apps.length > 1) this.log(`Running with companion apps: ${apps.slice(1).map((a) => a.name).join(", ")}`);
      try {
        await runDevVm({ apps, env, log: (m) => this.log(m), error: (m) => this.error(m, { exit: false }) });
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const docker = new Docker();
    assertAtMostOneBrowserApp(apps);
    assertAtMostOneTerminalApp(apps);
    assertAtMostOneMeshApp(apps);
    assertAtMostOneEgressBrokerApp(apps);
    if (apps.length > 1) this.log(`Running with companion apps: ${apps.slice(1).map((a) => a.name).join(", ")}`);

    const running = await bootDevContainer({
      appDir,
      manifest,
      apps,
      docker,
      meshCoordinatorUrl: flags["mesh-coordinator"],
      env,
      log: (message) => this.log(message),
    });

    this.log(`Container started. Watching ${appDir}/src and berth.yml for changes...`);
    this.printDiagnostics(
      apps.map((a) => a.manifest),
      running.ports,
      running.credentials,
    );
    void this.tailLogs(running.container);

    const watcher = watchApp(appDir, () => {
      this.log("Change detected, restarting container...");
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

  private printDiagnostics(
    manifests: BerthManifest[],
    ports: { vnc?: number; novnc?: number; terminal?: number },
    credentials: { terminal?: string; vnc?: string },
  ): void {
    const names = manifests.map((m) => m.name).join(", ");
    // Every published port is bound to 127.0.0.1 and credential-gated — the
    // password is printed here because it's generated fresh per boot, so
    // there's nowhere else to get it. See docs/threat-model.md.
    if (ports.novnc) this.log(`[berth:dev] noVNC:    http://127.0.0.1:${ports.novnc}/vnc.html`);
    if (ports.vnc) this.log(`[berth:dev] VNC:      127.0.0.1:${ports.vnc}`);
    if (credentials.vnc) this.log(`[berth:dev]           password: ${credentials.vnc}`);
    if (!ports.novnc && !ports.vnc) {
      if (manifests.some(declaresBrowserCapability) && !manifests.some(needsBrowserPorts)) {
        this.log(`[berth:dev] "${names}" sets expose.browser: false: VNC ports not published to the host`);
      } else {
        this.log(`[berth:dev] "${names}" declares no browser:* capability: no VNC ports exposed`);
      }
    }
    if (ports.terminal) {
      this.log(`[berth:dev] Terminal: http://127.0.0.1:${ports.terminal}`);
      if (credentials.terminal) {
        const [user, ...rest] = credentials.terminal.split(":");
        this.log(`[berth:dev]           login: ${user} / ${rest.join(":")}`);
      }
    } else if (manifests.some(declaresTerminalCapability) && !manifests.some(needsTerminalPort)) {
      this.log(`[berth:dev] "${names}" sets expose.terminal: false: terminal port not published to the host`);
    } else {
      this.log(`[berth:dev] "${names}" declares no terminal:* capability: no terminal port exposed`);
    }
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
