import { Command, Flags } from "@oclif/core";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { pack } from "tar-fs";
import { loadManifestOrExit } from "../util/manifest.js";
import { buildProductionImage, productionImageTag } from "../util/build.js";

export default class Publish extends Command {
  static override description = "Build the resident app and, with --registry, publish it to a running berth-registry";
  static override flags = {
    registry: Flags.string({ description: "registry URL to publish to, e.g. http://localhost:4873" }),
    author: Flags.string({ description: "author name recorded alongside the published app" }),
    token: Flags.string({
      description: "owner token for this app name (also read from BERTH_REGISTRY_TOKEN) — required to publish a new version of a name someone already published; not needed for a name's first-ever publish",
      env: "BERTH_REGISTRY_TOKEN",
    }),
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

    // Actually gzip (not just name the file .tar.gz) — the registry serves this
    // as application/gzip and `berth init --registry` gunzips it back down.
    // Also skip vendor/ — a locally-scaffolded app's berth-sdk.tgz vendoring
    // (see init.ts's vendorSdk()) is re-derived fresh by whoever `berth
    // init`s this app from the registry; shipping the publisher's own copy
    // would just bloat the bundle.
    const tarStream = pack(appDir, {
      ignore: (p) => p.includes("node_modules") || p.includes("dist-bundle") || p.startsWith(join(appDir, "vendor")),
    });
    await pipeline(tarStream, createGzip(), createWriteStream(bundlePath));

    this.log(`Bundle written to ${bundlePath}`);

    if (flags.registry) {
      await this.publishToRegistry(flags.registry, appDir, bundlePath, flags.author, flags.token);
    } else {
      this.log("No --registry given. Use `berth publish --registry=<url>` to push to a running berth-registry, or `berth deploy --fleet=<e2b|daytona>` to run this app directly.");
    }
  }

  private async publishToRegistry(registryUrl: string, appDir: string, bundlePath: string, author?: string, token?: string): Promise<void> {
    this.log(`Publishing to ${registryUrl}...`);
    const manifestText = await readFile(join(appDir, "berth.yml"), "utf-8");
    const bundleBytes = await readFile(bundlePath);

    const form = new FormData();
    form.set("manifest", manifestText);
    if (author) form.set("author", author);
    form.set("bundle", new Blob([bundleBytes], { type: "application/gzip" }), "bundle.tar.gz");

    const url = new URL("/apps", registryUrl);
    const res = await fetch(url, {
      method: "POST",
      body: form,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    const body = (await res.json()) as { name?: string; version?: string; error?: string; ownerToken?: string };

    if (!res.ok) {
      this.error(`registry rejected publish (${res.status}): ${body.error ?? res.statusText}`);
    }

    this.log(`Published ${body.name}@${body.version} to ${registryUrl}`);
    if (body.ownerToken) {
      this.log(`\nThis is the FIRST publish of "${body.name}" — it now owns that name. Save this owner token, it won't be shown again:`);
      this.log(`  ${body.ownerToken}`);
      this.log(`Pass it as --token (or BERTH_REGISTRY_TOKEN) to publish future versions of "${body.name}".`);
    }
  }
}
