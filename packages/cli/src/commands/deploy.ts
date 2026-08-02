import { Command, Flags } from "@oclif/core";
import { loadManifestOrExit } from "../util/manifest.js";
import { buildProductionImage, productionImageTag } from "../util/build.js";
import { resolveFleet } from "../util/fleet.js";
import { resolveApps, assertAtMostOneBrowserApp } from "../util/multi-app.js";
import { appendFleetInstances } from "../util/fleet-state.js";
import type { DeployHandle } from "@berth/adapter-core";
import type { BerthManifest } from "@berth/manifest-schema";
import { declaresBrowserCapability, declaresTerminalCapability } from "@berth/docker-orchestrator";

const NOVNC_PORT = 6080;
const TERMINAL_PORT = 7681;

/**
 * Only the primary app's own expose.preview opt-in is consulted here (not
 * every companion app's) — same v1 simplification the plan calls for, since
 * aggregating preview opt-in across a whole --apps group is a real design
 * question this doesn't need to answer yet.
 */
function previewPortsFor(manifest: BerthManifest): number[] {
  if (!manifest.expose.preview) return [];
  const ports: number[] = [];
  if (declaresBrowserCapability(manifest)) ports.push(NOVNC_PORT);
  if (declaresTerminalCapability(manifest)) ports.push(TERMINAL_PORT);
  return ports;
}

function labelFor(port: number): string {
  return port === NOVNC_PORT ? "noVNC" : port === TERMINAL_PORT ? "Terminal" : `port ${port}`;
}

export default class Deploy extends Command {
  static override description = "Build and deploy the resident app to a fleet (E2B, Daytona, or an alias in ~/.berthrc)";
  static override flags = {
    fleet: Flags.string({ description: "e2b, daytona, or an alias from ~/.berthrc", required: true }),
    count: Flags.integer({ description: "how many instances to start — overrides the fleet alias's own count (default 1)" }),
    apps: Flags.string({ description: "comma-separated workspace-relative paths of companion resident apps to run alongside this one" }),
    "grants-server": Flags.string({
      description:
        "berth-grants server URL to consult for human-approved capability grants — must be reachable from the deployed fleet, not just localhost",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Deploy);
    const appDir = process.cwd();
    const manifest = await loadManifestOrExit(appDir);

    const apps = await resolveApps(appDir, flags.apps, manifest);
    assertAtMostOneBrowserApp(apps);
    const companions = apps.slice(1);

    this.log(`Building production image for "${manifest.name}"...`);
    await buildProductionImage(appDir, manifest, companions);
    const imageRef = productionImageTag(manifest);

    const { adapter, env, count: aliasCount } = await resolveFleet(flags.fleet);
    const count = flags.count ?? aliasCount;
    if (count < 1) this.error(`--count must be at least 1, got ${count}`);

    const appsEnv: Record<string, string> = {};
    if (apps.length > 1) {
      appsEnv.BERTH_APPS = JSON.stringify(apps.map((a) => ({ name: a.name, workingDir: `/app/apps/${a.name}` })));
    }
    if (flags["grants-server"]) {
      appsEnv.BERTH_GRANTS_SERVER_URL = flags["grants-server"];
    }
    const target = { imageRef, manifest, env: { ...env, ...appsEnv } };

    this.log(`Uploading to ${adapter.name}...`);
    const { remoteImageRef } = await adapter.upload(target);

    const previewPorts = previewPortsFor(manifest);

    this.log(`Starting ${count} instance${count === 1 ? "" : "s"} on ${adapter.name}...`);
    // Recorded to fleet-state ONE INSTANCE AT A TIME, immediately after each
    // start() succeeds — not batched into a single appendFleetInstances()
    // call after the whole loop. A batched call meant that if instance N of
    // count failed, instances 1..N-1 had already started and were very much
    // running (and billing) on the provider, but were never persisted
    // anywhere: `berth fleet status`/`berth fleet stop` had no idea they
    // existed. Recording each one as it starts means a partial failure never
    // leaves untracked resources, whatever the operator decides to do about
    // the ones that did start.
    const handles: DeployHandle[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const handle = await adapter.start(remoteImageRef, target);
        this.log(`Started instance ${i + 1}/${count}: ${handle.id}`);
        handles.push(handle);
        await appendFleetInstances(flags.fleet, [
          {
            id: handle.id,
            appName: manifest.name,
            startedAt: new Date().toISOString(),
            previewPorts: previewPorts.length > 0 ? previewPorts : undefined,
          },
        ]);
        for (const port of previewPorts) {
          const url = await adapter.previewUrl?.(handle, port);
          if (url) this.log(`  ${labelFor(port)}: ${url}`);
        }
      }
    } catch (err) {
      if (handles.length > 0) {
        this.log(
          `${handles.length}/${count} instance(s) started and recorded to fleet state before this failure — ` +
            `they are still running on ${adapter.name}. Use \`berth fleet status ${flags.fleet}\` to see them.`,
        );
      }
      throw err;
    }

    this.log("Streaming logs from all instances (Ctrl+C to detach — this does not stop the deployment)...");

    const detach = () => {
      this.log("\nDetached.");
      process.exit(0);
    };
    process.on("SIGINT", detach);
    process.on("SIGTERM", detach);

    await Promise.all(
      handles.map(async (handle) => {
        for await (const line of handle.streamLogs()) {
          process.stdout.write(`[${adapter.name}:${handle.id}] ${line}\n`);
        }
      }),
    );
  }
}
