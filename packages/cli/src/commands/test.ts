import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { loadManifestOrExit } from "../util/manifest.js";
import { buildProductionImage, productionImageTag } from "../util/build.js";
import { resolveApps, assertAtMostOneBrowserApp, type AppSpec } from "../util/multi-app.js";
import { startContainer, stopContainer } from "@berth/docker-orchestrator";

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
    apps: Flags.string({ description: "comma-separated workspace-relative paths of companion resident apps to run alongside this one" }),
    "grants-server": Flags.string({
      description: "berth-grants server URL to consult for human-approved capability grants, e.g. http://localhost:4874",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Test);
    const appDir = process.cwd();
    const manifest = await loadManifestOrExit(appDir);
    const docker = new Docker();
    const grantsServerEnv = flags["grants-server"] ? [`BERTH_GRANTS_SERVER_URL=${flags["grants-server"]}`] : [];

    const apps = await resolveApps(appDir, flags.apps, manifest);
    assertAtMostOneBrowserApp(apps);
    const companions = apps.slice(1);

    if (!flags.json) this.log(`Building test image for "${manifest.name}"...`);
    await buildProductionImage(appDir, manifest, companions);
    const image = productionImageTag(manifest);

    const exportCheck = await this.runInContainer(
      docker,
      image,
      apps,
      ["node", "node_modules/@berth/sdk/dist/check-exports.js"],
      grantsServerEnv,
    );
    const appTestCheck = await this.maybeRunAppTests(docker, image, appDir, apps, grantsServerEnv);

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
    apps: AppSpec[],
    grantsServerEnv: string[],
  ): Promise<{ exitCode: number; output: string } | null> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf-8"));
      if (!pkg.scripts?.test) return null;
    } catch {
      return null;
    }
    return this.runInContainer(docker, image, apps, ["npm", "test"], grantsServerEnv);
  }

  /**
   * Single-app: today's exact one-shot `docker.run(AutoRemove)` path,
   * unchanged. Multi-app: `docker.run` has no way to keep companion apps
   * alive alongside the checked command, so this case instead starts a real
   * container (all apps, real per-app Landlock enforcement via
   * entrypoint.sh's multi-app branch), execs the check inside the primary
   * app's own directory, then tears the container down — same net effect,
   * companions just get to exist during the check.
   */
  private async runInContainer(
    docker: Docker,
    image: string,
    apps: AppSpec[],
    cmd: string[],
    grantsServerEnv: string[] = [],
  ): Promise<{ exitCode: number; output: string; parsed?: ExportCheckResult }> {
    if (apps.length <= 1) {
      let output = "";
      const stdout = new PassThrough();
      stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf-8");
      });

      const [result] = await docker.run(image, cmd, stdout, {
        Env: ["BERTH_TEST_MODE=1", ...grantsServerEnv],
        HostConfig: { AutoRemove: true },
      });

      return { exitCode: result.StatusCode ?? 0, output, parsed: parseLastJsonLine(output) };
    }

    const primary = apps[0]!;
    const running = await startContainer({
      image,
      name: `berth-test-${primary.name}-${Date.now()}`,
      manifest: primary.manifest,
      workingDir: `/app/apps/${primary.name}`,
      env: { BERTH_TEST_MODE: "1", ...envArrayToObject(grantsServerEnv) },
      apps: apps.map((a) => ({ name: a.name, workingDir: `/app/apps/${a.name}`, manifest: a.manifest })),
      docker,
    });

    try {
      const exec = await running.container.exec({
        Cmd: cmd,
        WorkingDir: `/app/apps/${primary.name}`,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(stream, stdout, stderr);

      let output = "";
      stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));
      stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));
      await new Promise<void>((resolve) => stream.on("end", resolve));

      const inspect = await exec.inspect();
      return { exitCode: inspect.ExitCode ?? 0, output, parsed: parseLastJsonLine(output) };
    } finally {
      await stopContainer(running.container);
    }
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

function envArrayToObject(env: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    result[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return result;
}

function parseLastJsonLine(output: string): ExportCheckResult | undefined {
  const lastLine = output.trim().split("\n").pop();
  if (!lastLine) return undefined;
  try {
    return JSON.parse(lastLine);
  } catch {
    // app's own `npm test` output won't be JSON — that's expected.
    return undefined;
  }
}
