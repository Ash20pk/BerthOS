import { Command, Flags } from "@oclif/core";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pack } from "tar-fs";
import { loadManifestOrExit } from "../util/manifest.js";
import { buildProductionImage, productionImageTag } from "../util/build.js";

export default class Publish extends Command {
  static override description = "Build the resident app for publishing (no live registry until Phase 5)";
  static override flags = {
    registry: Flags.string({ description: "registry URL (accepted for forward compatibility, not yet used)" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Publish);
    const appDir = process.cwd();
    const manifest = await loadManifestOrExit(appDir);

    this.log(`Building production image for "${manifest.name}"...`);
    await buildProductionImage(appDir, manifest);
    const image = productionImageTag(manifest);

    const distDir = join(appDir, "dist-bundle");
    await mkdir(distDir, { recursive: true });
    const bundlePath = join(distDir, "publish-bundle.tar.gz");

    await writeFile(
      join(distDir, "bundle-manifest.json"),
      JSON.stringify({ name: manifest.name, version: manifest.version, image }, null, 2),
    );

    await new Promise<void>((resolve, reject) => {
      const tarStream = pack(appDir, { ignore: (p) => p.includes("node_modules") || p.includes("dist-bundle") });
      const out = createWriteStream(bundlePath);
      tarStream.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
    });

    this.log(`Bundle written to ${bundlePath}`);
    if (flags.registry) {
      this.warn(`--registry=${flags.registry} is accepted but not yet implemented — no live registry until Phase 5.`);
    } else {
      this.log("No live registry available yet (Phase 5). Use `berth deploy --fleet=<e2b|daytona>` to run this app directly.");
    }
  }
}
