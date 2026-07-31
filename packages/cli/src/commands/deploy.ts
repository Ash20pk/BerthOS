import { Command, Flags } from "@oclif/core";
import { loadManifestOrExit } from "../util/manifest.js";
import { buildProductionImage, productionImageTag } from "../util/build.js";
import { resolveFleet } from "../util/fleet.js";

export default class Deploy extends Command {
  static override description = "Build and deploy the resident app to a fleet (E2B, Daytona, or an alias in ~/.berthrc)";
  static override flags = {
    fleet: Flags.string({ description: "e2b, daytona, or an alias from ~/.berthrc", required: true }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Deploy);
    const appDir = process.cwd();
    const manifest = await loadManifestOrExit(appDir);

    this.log(`Building production image for "${manifest.name}"...`);
    await buildProductionImage(appDir, manifest);
    const imageRef = productionImageTag(manifest);

    const { adapter, env } = await resolveFleet(flags.fleet);
    const target = { imageRef, manifest, env };

    this.log(`Uploading to ${adapter.name}...`);
    const { remoteImageRef } = await adapter.upload(target);

    this.log(`Starting on ${adapter.name}...`);
    const handle = await adapter.start(remoteImageRef, target);
    this.log(`Deployed. Instance id: ${handle.id}`);
    this.log("Streaming logs (Ctrl+C to detach — this does not stop the deployment)...");

    const detach = () => {
      this.log("\nDetached.");
      process.exit(0);
    };
    process.on("SIGINT", detach);
    process.on("SIGTERM", detach);

    for await (const line of handle.streamLogs()) {
      process.stdout.write(`[${adapter.name}:${handle.id}] ${line}\n`);
    }
  }
}
