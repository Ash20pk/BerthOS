import { Args, Command, Flags } from "@oclif/core";
import { applyClientTls } from "@berth/tls";
import { input, select } from "@inquirer/prompts";
import { cp, readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extract } from "tar-fs";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadManifest } from "@berth/manifest-schema";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
// Templates are plain (non-TS) files shipped as-is from src/ — see this
// package's "files" field — rather than something tsc copies into dist/.
// __dirname here is dist/commands/, so: dist/commands -> dist -> package root -> src/templates.
const TEMPLATES_DIR = join(__dirname, "..", "..", "src", "templates");

export default class Init extends Command {
  static override description = "Scaffold a new resident app from a template";
  static override args = {
    name: Args.string({ description: "name of the new resident app", required: false }),
  };
  static override flags = {
    template: Flags.string({
      description: "skip the interactive prompt and scaffold from this template (or, with --registry, this published app name) directly",
    }),
    registry: Flags.string({
      description: "scaffold from a published app on this berth-registry instead of a bundled local template",
    }),
    ca: Flags.string({
      description: "CA certificate to trust for an https:// server (e.g. the one `berth tls init` minted); also settable via NODE_EXTRA_CA_CERTS",
    }),
    insecure: Flags.boolean({
      description: "skip TLS certificate verification — encrypted but unauthenticated, and trivially interceptable. Use --ca instead",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);
    applyClientTls(flags);

    const name =
      args.name ??
      (await input({
        message: "Resident app name:",
        validate: (value) => /^[a-z0-9-]+$/.test(value) || "must be lowercase alphanumeric with dashes",
      }));

    const targetDir = join(process.cwd(), name);
    if (existsSync(targetDir)) {
      this.error(`${targetDir} already exists`);
    }

    if (flags.registry) {
      const template = flags.template ?? (await input({ message: `App to scaffold from ${flags.registry}:` }));
      try {
        await scaffoldFromRegistry(flags.registry, template, targetDir, name);
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }
      this.log(`Scaffolded ${name} from ${flags.registry}'s "${template}" at ${targetDir}`);
    } else {
      const template =
        flags.template ??
        (await select({
          message: "Start from which template?",
          choices: [
            { name: "hello-world (minimal)", value: "hello-world" },
            { name: "browser-native (headless Chromium + VNC)", value: "browser-native" },
          ],
        }));
      if (!["hello-world", "browser-native"].includes(template)) {
        this.error(`unknown local template "${template}" — pass --registry=<url> to scaffold from a published app instead`);
      }
      await copyTemplate(join(TEMPLATES_DIR, template), targetDir, name);
      this.log(`Scaffolded ${name} from ${template} template at ${targetDir}`);
    }

    if (existsSync(join(targetDir, "package.json"))) {
      try {
        await vendorSdk(targetDir);
      } catch (err) {
        this.warn(err instanceof Error ? err.message : String(err));
      }
    }

    this.log("Installing dependencies...");
    try {
      await execFileAsync("pnpm", ["install"], { cwd: targetDir });
    } catch {
      this.warn("pnpm install failed — run it manually inside the new directory (not inside a pnpm workspace?)");
    }

    // Validate immediately so `init` never hands out a broken starting point.
    await loadManifest(join(targetDir, "berth.yml"));
    this.log(`berth.yml is valid. Next: cd ${name} && berth dev`);
  }
}

/**
 * Vendors @berth/sdk's self-contained external bundle (built by
 * packages/sdk/scripts/build-external.mjs) into the scaffolded project and
 * points its package.json at the vendored copy via a `file:` dependency,
 * replacing whatever was there ("^0.1.0" in local templates, "workspace:*"
 * in a real first-party app pulled from the registry) — neither resolves
 * once `targetDir` is copied somewhere outside this monorepo's pnpm
 * workspace, which is exactly the case this exists to cover.
 */
async function vendorSdk(targetDir: string): Promise<void> {
  const sdkEntryPath = fileURLToPath(import.meta.resolve("@berth/sdk"));
  const sdkPkgRoot = dirname(dirname(sdkEntryPath)); // dist/index.js -> dist -> package root
  const tarballPath = join(sdkPkgRoot, "dist-external", "berth-sdk.tgz");
  if (!existsSync(tarballPath)) {
    throw new Error(
      `@berth/sdk's external bundle not found at ${tarballPath} — run \`pnpm --filter @berth/sdk build\` first; skipping SDK vendoring`,
    );
  }

  const vendorDir = join(targetDir, "vendor");
  await mkdir(vendorDir, { recursive: true });
  await cp(tarballPath, join(vendorDir, "berth-sdk.tgz"));

  const pkgJsonPath = join(targetDir, "package.json");
  const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf-8")) as { dependencies?: Record<string, string> };
  if (pkgJson.dependencies?.["@berth/sdk"]) {
    pkgJson.dependencies["@berth/sdk"] = "file:./vendor/berth-sdk.tgz";
    await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  }

  // pnpm (10.21+) refuses to run a fresh dependency's install script until
  // it's explicitly approved, and protobufjs (an @berth/sdk dependency, via
  // its context-bus client) has a benign one (scripts/postinstall — just an
  // optional-dep advisory). Outside this monorepo there's no prior approval
  // on record, so a first-time `pnpm install` would otherwise hard-fail —
  // pre-approve it so scaffolding a project actually finishes installable.
  const workspaceYamlPath = join(targetDir, "pnpm-workspace.yaml");
  if (!existsSync(workspaceYamlPath)) {
    await writeFile(workspaceYamlPath, stringifyYaml({ allowBuilds: { protobufjs: true } }));
  }
}

interface RegistryAppMeta {
  name: string;
  version: string;
  error?: string;
}

/** Downloads a published app's latest version and extracts it as the new project — the `berth init` half of the publish/discover/install loop. */
async function scaffoldFromRegistry(registryUrl: string, template: string, targetDir: string, name: string): Promise<void> {
  const metaRes = await fetch(new URL(`/apps/${template}/latest`, registryUrl));
  const meta = (await metaRes.json()) as RegistryAppMeta;
  if (!metaRes.ok) {
    throw new Error(`registry lookup for "${template}" failed (${metaRes.status}): ${meta.error ?? metaRes.statusText}`);
  }

  const downloadRes = await fetch(new URL(`/apps/${template}/${meta.version}/download`, registryUrl));
  if (!downloadRes.ok) {
    throw new Error(`could not download ${template}@${meta.version} from ${registryUrl} (${downloadRes.status})`);
  }
  const bytes = Buffer.from(await downloadRes.arrayBuffer());

  await mkdir(targetDir, { recursive: true });
  await pipeline(Readable.from(bytes), createGunzip(), extract(targetDir));

  // The downloaded bundle is a real published app (its own berth.yml name),
  // not a {{name}}-templated scaffold — rewrite the name to what was asked for.
  const manifestPath = join(targetDir, "berth.yml");
  const parsed = parseYaml(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
  parsed.name = name;
  await writeFile(manifestPath, stringifyYaml(parsed));
}

async function copyTemplate(sourceDir: string, targetDir: string, name: string): Promise<void> {
  await cp(sourceDir, targetDir, { recursive: true });
  await substitutePlaceholders(targetDir, name);
}

async function substitutePlaceholders(dir: string, name: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    const entryPath = join(dir, entry);
    const info = await stat(entryPath);
    if (info.isDirectory()) {
      await substitutePlaceholders(entryPath, name);
      continue;
    }
    if (!/\.(yml|yaml|json|md|ts|js)$/.test(entry)) continue;
    const contents = await readFile(entryPath, "utf-8");
    await writeFile(entryPath, contents.replaceAll("{{name}}", name));
  }
}
