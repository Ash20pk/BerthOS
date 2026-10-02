import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { partitionSecretsPerApp } from "@berthos/docker-orchestrator";
import { isConventionalEnvName } from "../util/env-args.js";

/**
 * The secrets disk: how a microVM sandbox's environment reaches its apps.
 *
 * The guest's own environment travels on the kernel command line, which any
 * process in the guest can read in /proc/cmdline, so nothing the user passes
 * goes there. Instead the CLI writes it into one small file in the run
 * directory (0600), `berth-vmm run --secrets` attaches it read-only, and
 * berth-init reads it before any app starts, removes the device node, and
 * gives each app the `shared` entries plus its own `apps.<name>` entries
 * (packages/vmm/init/src/secrets.rs). The CLI removes the file once the
 * sandbox is ready.
 *
 * Format (packages/vmm/src/secrets.rs): the magic line, one JSON object,
 * NUL padding to whole 512-byte sectors.
 */

export const SECRETS_FILE = "secrets.img";
export const SECRETS_MAGIC = "BERTHSEC1\n";
export const SECRETS_MAX_BYTES = 1 << 20;
const SECTOR = 512;

export interface VmSecrets {
  /** To every app: names no app declared under `secrets:`. */
  shared: Record<string, string>;
  /** App name -> its declared names that have values, to that app only. */
  perApp: Record<string, Record<string, string>>;
}

export function hasSecrets(s: VmSecrets): boolean {
  return Object.keys(s.shared).length > 0 || Object.values(s.perApp).some((e) => Object.keys(e).length > 0);
}

/**
 * Splits the sandbox's environment the way the container path does
 * (partitionSecretsPerApp): a name an app declares goes to the apps that
 * declare it, and only to them; any other name goes to every app. Unlike the
 * container, nothing goes into a plain environment, so a name's shape doesn't
 * matter here: every value travels on the disk.
 */
export function vmSecrets(
  env: Record<string, string>,
  apps: readonly { name: string; manifest: { secrets?: readonly string[] } }[],
): VmSecrets & { missing: { app: string; name: string }[] } {
  const { shared, perApp, missing } = partitionSecretsPerApp(
    env,
    apps.map((a) => ({ name: a.name, secrets: a.manifest.secrets ?? [] })),
  );
  return { shared, perApp, missing };
}

export function encodeSecretsDisk(s: VmSecrets): Buffer {
  // JSON would carry a NUL as \u0000, and berth-init would refuse the disk at boot; say so here, by name.
  for (const [name, value] of [...Object.entries(s.shared), ...Object.values(s.perApp).flatMap((e) => Object.entries(e))]) {
    if (value.includes("\0")) {
      throw new Error(`the value of ${isConventionalEnvName(name) ? name : "a variable"} contains a NUL byte, which no environment variable can hold`);
    }
  }
  const body = Buffer.from(SECRETS_MAGIC + JSON.stringify({ shared: s.shared, apps: s.perApp }), "utf8");
  const size = Math.ceil(body.length / SECTOR) * SECTOR;
  if (size > SECRETS_MAX_BYTES) {
    throw new Error(`the sandbox's environment is ${body.length} bytes, more than the ${SECRETS_MAX_BYTES} a microVM sandbox takes`);
  }
  const disk = Buffer.alloc(size);
  body.copy(disk);
  return disk;
}

/** Writes the disk into the run directory, 0600, replacing any left from an earlier run. Returns its path. */
export function writeSecretsDisk(runDir: string, s: VmSecrets): string {
  const path = join(runDir, SECRETS_FILE);
  rmSync(path, { force: true });
  // "wx": created by this call, so the mode is the one asked for.
  writeFileSync(path, encodeSecretsDisk(s), { mode: 0o600, flag: "wx" });
  return path;
}

export function removeSecretsDisk(runDir: string): void {
  rmSync(join(runDir, SECRETS_FILE), { force: true });
}
