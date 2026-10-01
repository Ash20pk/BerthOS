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
 * local build: the GitHub release .github/workflows/vm-artifacts.yml publishes
 * for this kernel and rootfs pair. The placeholders (artifacts.ts,
 * expandUrlTemplate): {asset} the release asset name (Image-<sha256>,
 * rootfs-<sha256>.erofs, berth-vmm-<platform>-<sha256>), {kernel8}/{rootfs8}
 * the first 8 hex digits of the pair's pins (the release tag), {kind} kernel,
 * rootfs or vmm, {sha256} the artifact's pin, {file} its file name in the
 * artifacts directory. Every download is checked against its pin, so a mirror
 * (BERTH_VM_ARTIFACTS_URL, vm.artifactsUrl, --url) needs no trust.
 */
export const DEFAULT_ARTIFACTS_URL = "https://github.com/Ash20pk/BerthOS/releases/download/vm-artifacts-{kernel8}-{rootfs8}/{asset}";

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
