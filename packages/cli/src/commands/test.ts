import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { loadManifestOrExit } from "../util/manifest.js";
import { buildProductionImage, productionImageTag } from "../util/build.js";

interface ExportCheckResult {
  ok: boolean;
  error?: string;
  results?: Array<{ export: string; ok: boolean; error?: string }>;
  missingInCode?: string[];
  missingInManifest?: string[];
}

export default class Test extends Command {
  static override description = "Run the resident app in an isolated test OS instance and check its export contracts";
  static override flags = {
    json: Flags.boolean({ description: "emit a structured JSON summary" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Test);
    const appDir = process.cwd();
    const manifest = await loadManifestOrExit(appDir);
    const docker = new Docker();

    if (!flags.json) this.log(`Building test image for "${manifest.name}"...`);
    await buildProductionImage(appDir, manifest);
    const image = productionImageTag(manifest);

    const exportCheck = await this.runInContainer(docker, image, [
      "node",
      "node_modules/@berth/sdk/dist/check-exports.js",
    ]);
    const appTestCheck = await this.maybeRunAppTests(docker, image, appDir);

    const summary = {
      manifest: manifest.name,
      exportCheck: exportCheck.parsed,
      appTest: appTestCheck,
    };

    const passed = exportCheck.exitCode === 0 && (appTestCheck === null || appTestCheck.exitCode === 0);

    if (flags.json) {
      this.log(JSON.stringify(summary, null, 2));
    } else {
      this.printHumanSummary(exportCheck, appTestCheck);
    }

    if (!passed) this.exit(1);
  }

  private async maybeRunAppTests(
    docker: Docker,
    image: string,
    appDir: string,
  ): Promise<{ exitCode: number; output: string } | null> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf-8"));
      if (!pkg.scripts?.test) return null;
    } catch {
      return null;
    }
    return this.runInContainer(docker, image, ["npm", "test"]);
  }

  private async runInContainer(
    docker: Docker,
    image: string,
    cmd: string[],
  ): Promise<{ exitCode: number; output: string; parsed?: ExportCheckResult }> {
    let output = "";
    const stdout = new PassThrough();
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    const [result] = await docker.run(image, cmd, stdout, {
      Env: ["BERTH_TEST_MODE=1"],
      HostConfig: { AutoRemove: true },
    });

    let parsed: ExportCheckResult | undefined;
    const lastLine = output.trim().split("\n").pop();
    if (lastLine) {
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        // app's own `npm test` output won't be JSON — that's expected.
      }
    }

    return { exitCode: result.StatusCode ?? 0, output, parsed };
  }

  private printHumanSummary(
    exportCheck: { exitCode: number; parsed?: ExportCheckResult },
    appTestCheck: { exitCode: number; output: string } | null,
  ): void {
    if (exportCheck.parsed?.ok) {
      this.log(`✓ manifest + export contracts (${exportCheck.parsed.results?.length ?? 0} exports checked)`);
    } else {
      this.log("✗ manifest + export contracts failed:");
      if (exportCheck.parsed?.missingInCode?.length) {
        this.log(`  declared in berth.yml but not implemented: ${exportCheck.parsed.missingInCode.join(", ")}`);
      }
      if (exportCheck.parsed?.missingInManifest?.length) {
        this.log(`  implemented but not declared: ${exportCheck.parsed.missingInManifest.join(", ")}`);
      }
      for (const r of exportCheck.parsed?.results ?? []) {
        if (!r.ok) this.log(`  ✗ ${r.export}: ${r.error}`);
      }
    }

    if (appTestCheck) {
      this.log(appTestCheck.exitCode === 0 ? "✓ app test suite" : "✗ app test suite failed");
    }
  }
}
