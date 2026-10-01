import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PINS, type ArtifactPin } from "./pins.js";
import { vmHome } from "./paths.js";

/**
 * Puts the pinned kernel and rootfs where berth-vmm looks for them
 * (~/.berth/vm, its default artifacts directory), verified against their
 * sha256 pins. Sources, in order: a local build directory (`--from`,
 * BERTH_VMM_ARTIFACTS), then a download URL template keyed by sha256.
 *
 * Nothing unverified is ever left at the final path: every copy and download
 * goes to a temporary name next to it, is hashed, and is renamed into place
 * only when the hash matches the pin.
 */

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export type ArtifactState =
  | { kind: ArtifactPin["kind"]; path: string; status: "verified"; sha256: string }
  | { kind: ArtifactPin["kind"]; path: string; status: "missing" }
  | { kind: ArtifactPin["kind"]; path: string; status: "mismatch"; sha256: string };

export function artifactPath(pin: ArtifactPin, root = vmHome()): string {
  return join(root, pin.relPath);
}

/** Present at the right size: what a boot checks (berth-vmm hashes it again before booting). */
export function artifactsPresent(root = vmHome(), pins: readonly ArtifactPin[] = PINS): boolean {
  return pins.every((pin) => {
    try {
      return statSync(artifactPath(pin, root)).size === pin.size;
    } catch {
      return false;
    }
  });
}

/** Each installed artifact, hashed. */
export async function checkArtifacts(root = vmHome(), pins: readonly ArtifactPin[] = PINS): Promise<ArtifactState[]> {
  return Promise.all(
    pins.map(async (pin): Promise<ArtifactState> => {
      const path = artifactPath(pin, root);
      if (!existsSync(path)) return { kind: pin.kind, path, status: "missing" };
      const sha256 = await sha256File(path);
      return sha256 === pin.sha256 ? { kind: pin.kind, path, status: "verified", sha256 } : { kind: pin.kind, path, status: "mismatch", sha256 };
    }),
  );
}

/**
 * Where a pinned artifact may sit in a source directory: berth-vmm's layout
 * (a packages/vmm build's $BERTH_VMM_ARTIFACTS), a directory per sha256, or
 * flat.
 */
export function sourceCandidates(pin: ArtifactPin, dir: string): string[] {
  return [join(dir, pin.relPath), join(dir, pin.sha256, pin.file), join(dir, pin.file)];
}

export interface InstallOptions {
  /** Install root. Default ~/.berth/vm. */
  root?: string;
  /** A local build directory to copy from. */
  from?: string;
  /** Download URL template ({kind}, {sha256}, {file}); used for whatever `from` lacks. */
  urlTemplate?: string;
  /** Replace an installed artifact even when it verifies. */
  force?: boolean;
  log?: (message: string) => void;
  fetch?: typeof fetch;
  /** The pins to install (tests); default the kernel and rootfs this CLI boots. */
  pins?: readonly ArtifactPin[];
}

export interface InstallResult {
  kind: ArtifactPin["kind"];
  path: string;
  sha256: string;
  /** Where it came from: already installed, a copy from a directory, or a download. */
  source: "installed" | "copied" | "downloaded";
  from?: string;
  ms: number;
}

export function expandUrlTemplate(template: string, pin: ArtifactPin): string {
  return template.replaceAll("{kind}", pin.kind).replaceAll("{sha256}", pin.sha256).replaceAll("{file}", pin.file);
}

export async function installArtifacts(options: InstallOptions): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  for (const pin of options.pins ?? PINS) results.push(await installOne(pin, options));
  return results;
}

async function installOne(pin: ArtifactPin, options: InstallOptions): Promise<InstallResult> {
  const t0 = Date.now();
  const root = options.root ?? vmHome();
  const dest = artifactPath(pin, root);
  const log = options.log ?? (() => {});
  if (!options.force && existsSync(dest)) {
    const sha = await sha256File(dest);
    if (sha === pin.sha256) return { kind: pin.kind, path: dest, sha256: sha, source: "installed", ms: Date.now() - t0 };
    log(`${pin.kind}: ${dest} has sha256 ${sha}, not the pinned ${pin.sha256}; replacing it`);
  }
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.partial-${process.pid}`;
  const problems: string[] = [];
  try {
    if (options.from) {
      const source = sourceCandidates(pin, options.from).find((p) => existsSync(p));
      if (!source) {
        problems.push(`no ${pin.file} for ${pin.sha256.slice(0, 12)}… under ${options.from}`);
      } else {
        // An APFS clone where the volume supports it (the same blocks, no
        // second copy on disk), a plain copy elsewhere.
        await copyFile(source, tmp, constants.COPYFILE_FICLONE);
        const sha = await sha256File(tmp);
        if (sha === pin.sha256) {
          await rename(tmp, dest);
          return { kind: pin.kind, path: dest, sha256: sha, source: "copied", from: source, ms: Date.now() - t0 };
        }
        problems.push(`${source} has sha256 ${sha}, not the pinned ${pin.sha256}`);
        await rm(tmp, { force: true });
      }
    }
    if (options.urlTemplate) {
      const url = expandUrlTemplate(options.urlTemplate, pin);
      log(`${pin.kind}: downloading ${url}`);
      try {
        const sha = await download(url, tmp, pin, options.fetch ?? fetch);
        if (sha === pin.sha256) {
          await rename(tmp, dest);
          return { kind: pin.kind, path: dest, sha256: sha, source: "downloaded", from: url, ms: Date.now() - t0 };
        }
        problems.push(`${url} served sha256 ${sha}, not the pinned ${pin.sha256}`);
      } catch (err) {
        problems.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
  if (!options.from && !options.urlTemplate) problems.push("no source: pass --from <dir> or a download URL");
  throw new Error(`could not install the pinned ${pin.kind} (${pin.sha256}):\n  ${problems.join("\n  ")}`);
}

/** Streams `url` to `dest`, hashing as it goes. Refuses a body larger than the pin says. */
async function download(url: string, dest: string, pin: ArtifactPin, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared !== pin.size) throw new Error(`content-length ${declared}, but the pinned ${pin.kind} is ${pin.size} bytes`);
  const hash = createHash("sha256");
  let bytes = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > pin.size) body.destroy(new Error(`more than the pinned ${pin.size} bytes`));
    else hash.update(chunk);
  });
  await pipeline(body, createWriteStream(dest, { mode: 0o644 }));
  if (bytes !== pin.size) throw new Error(`got ${bytes} bytes, the pinned ${pin.kind} is ${pin.size}`);
  return hash.digest("hex");
}
