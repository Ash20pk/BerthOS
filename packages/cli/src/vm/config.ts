import { readFileSync } from "node:fs";
import { join } from "node:path";
import { berthHome } from "./paths.js";

/**
 * Which sandbox `berth dev`, `berth mcp` and `berth rpc` use, and where the
 * VM artifacts come from. Resolved flag > environment > ~/.berth/config.json
 * > default:
 *
 *   --runtime docker|vm        BERTH_SANDBOX          {"sandbox": "vm"}
 *   --url TEMPLATE             BERTH_VM_ARTIFACTS_URL {"vm": {"artifactsUrl": "..."}}
 *   --from DIR                 BERTH_VMM_ARTIFACTS    {"vm": {"artifactsDir": "..."}}
 *
 * The environment variable is BERTH_SANDBOX, not BERTH_RUNTIME: that one
 * already names the Docker container runtime (runsc for gVisor), and a value
 * of "vm" there would reach Docker as a runtime name.
 */
export type SandboxRuntime = "docker" | "vm";
export const DEFAULT_SANDBOX: SandboxRuntime = "docker";

/**
 * Where `berth vm install` downloads a pinned artifact from when there is no
 * local build: {kind} is kernel or rootfs, {sha256} its pin, {file} its file
 * name. Matches kernel/manifest.toml's dist_url. Nothing is published there
 * yet; set your own with BERTH_VM_ARTIFACTS_URL or the config file.
 */
export const DEFAULT_ARTIFACTS_URL = "https://artifacts.berth.dev/{kind}/sha256/{sha256}/{file}";

export interface BerthConfigFile {
  sandbox?: string;
  vm?: { artifactsUrl?: string; artifactsDir?: string; vmm?: string };
}

export function configPath(): string {
  return join(berthHome(), "config.json");
}

/** The config file, or {} when there is none. A file that isn't valid JSON is an error, not a silent default. */
export function readConfigFile(path = configPath()): BerthConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as BerthConfigFile) : {};
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseSandbox(value: string, from: string): SandboxRuntime {
  if (value === "docker" || value === "vm") return value;
  throw new Error(`${from} is "${value}"; expected docker or vm`);
}

export function resolveSandbox(flag: string | undefined, env = process.env, file: BerthConfigFile = readConfigFile()): SandboxRuntime {
  if (flag) return parseSandbox(flag, "--runtime");
  if (env.BERTH_SANDBOX) return parseSandbox(env.BERTH_SANDBOX, "BERTH_SANDBOX");
  if (file.sandbox) return parseSandbox(file.sandbox, `"sandbox" in ${configPath()}`);
  return DEFAULT_SANDBOX;
}

export function resolveArtifactsUrl(flag: string | undefined, env = process.env, file: BerthConfigFile = readConfigFile()): string {
  return flag ?? env.BERTH_VM_ARTIFACTS_URL ?? file.vm?.artifactsUrl ?? DEFAULT_ARTIFACTS_URL;
}

export function resolveArtifactsDir(flag: string | undefined, env = process.env, file: BerthConfigFile = readConfigFile()): string | undefined {
  return flag ?? (env.BERTH_VMM_ARTIFACTS || undefined) ?? file.vm?.artifactsDir;
}
