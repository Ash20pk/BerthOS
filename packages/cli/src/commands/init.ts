import { Args, Command, Flags } from "@oclif/core";
import { input, select } from "@inquirer/prompts";
import { cp, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
      description: "skip the interactive prompt and scaffold from this template directly",
      options: ["hello-world", "browser-native"],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);

    const name =
      args.name ??
      (await input({
        message: "Resident app name:",
        validate: (value) => /^[a-z0-9-]+$/.test(value) || "must be lowercase alphanumeric with dashes",
      }));

    const template =
      flags.template ??
      (await select({
        message: "Start from which template?",
        choices: [
          { name: "hello-world (minimal)", value: "hello-world" },
          { name: "browser-native (headless Chromium + VNC)", value: "browser-native" },
        ],
      }));

    const targetDir = join(process.cwd(), name);
    if (existsSync(targetDir)) {
      this.error(`${targetDir} already exists`);
    }

    await copyTemplate(join(TEMPLATES_DIR, template), targetDir, name);

    this.log(`Scaffolded ${name} from ${template} template at ${targetDir}`);
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
