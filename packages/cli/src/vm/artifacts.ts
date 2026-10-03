import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { KERNEL_PIN, PINS, ROOTFS_PIN, type ArtifactPin } from "./pins.js";
import { vmHome } from "./paths.js";

/**
 * Puts the pinned kernel and rootfs where berth-vmm looks for them
 * (~/.berth/vm, its default artifacts directory), and berth-vmm itself in
 * ~/.berth/vm/bin, verified against their sha256 pins. Sources, in order: a
 * local build directory (`--from`, BERTH_VMM_ARTIFACTS), then a download URL
 * template (by default the GitHub release for the kernel and rootfs pair).
 *
 * Nothing unverified is ever left at the final path: every copy and download
 * goes to a temporary name next to it, is hashed, and is renamed into place
 * only when the hash matches the pin. berth-vmm is made executable, and loses
 * macOS's quarantine attribute, only after it matched.
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
 * (a packages/vmm build's $BERTH_VMM_ARTIFACTS), a directory per sha256,
 * flat, or a downloaded release (assets named by sha256).
 */
export function sourceCandidates(pin: ArtifactPin, dir: string): string[] {
  return [...new Set([join(dir, pin.relPath), join(dir, pin.sha256, pin.file), join(dir, pin.file), join(dir, pin.asset)])];
}

/** The kernel and rootfs pair whose release an artifact is downloaded from. */
export interface ReleasePair {
  kernel: string;
  rootfs: string;
}

/** The pair among `pins`, or the CLI's own for whichever is missing. */
export function releasePair(pins: readonly ArtifactPin[]): ReleasePair {
  return {
    kernel: pins.find((p) => p.kind === "kernel")?.sha256 ?? KERNEL_PIN.sha256,
    rootfs: pins.find((p) => p.kind === "rootfs")?.sha256 ?? ROOTFS_PIN.sha256,
  };
}

export interface InstallOptions {
  /** Install root. Default ~/.berth/vm. */
  root?: string;
  /** A local build directory to copy from. */
  from?: string;
  /** Download URL template (see expandUrlTemplate); used for whatever `from` lacks. */
  urlTemplate?: string;
  /** The release to download from; default the kernel and rootfs among `pins` (else the CLI's). */
  release?: ReleasePair;
  /** Replace an installed artifact even when it verifies. */
  force?: boolean;
  log?: (message: string) => void;
  fetch?: typeof fetch;
  /** The pins to install; default the kernel and rootfs this CLI boots. */
  pins?: readonly ArtifactPin[];
  /** Runs `xattr` (tests). */
  run?: typeof spawnSync;
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

/**
 * A download URL for `pin`: {asset} its release asset name, {kind} kernel,
 * rootfs or vmm, {sha256} its pin, {file} its file name in the artifacts
 * directory, {kernel}/{rootfs} the release pair's pins and {kernel8}/{rootfs8}
 * their first 8 hex digits (the release tag is vm-artifacts-{kernel8}-{rootfs8}).
 */
export function expandUrlTemplate(template: string, pin: ArtifactPin, release: ReleasePair = releasePair([pin])): string {
  return template
    .replaceAll("{kind}", pin.kind)
    .replaceAll("{sha256}", pin.sha256)
    .replaceAll("{file}", pin.file)
    .replaceAll("{asset}", pin.asset)
    .replaceAll("{kernel8}", release.kernel.slice(0, 8))
    .replaceAll("{rootfs8}", release.rootfs.slice(0, 8))
    .replaceAll("{kernel}", release.kernel)
    .replaceAll("{rootfs}", release.rootfs);
}

export async function installArtifacts(options: InstallOptions): Promise<InstallResult[]> {
  const pins = options.pins ?? PINS;
  const release = options.release ?? releasePair(pins);
  const results: InstallResult[] = [];
  for (const pin of pins) results.push(await installOne(pin, { ...options, release }));
  return results;
}

/**
 * Removes com.apple.quarantine (set on files a browser or another
 * quarantine-aware app downloaded), so Gatekeeper does not refuse an ad hoc
 * signed berth-vmm. Only ever called on a file whose sha256 matched its pin.
 * True when the attribute was there and is gone; a no-op off macOS.
 */
export function clearQuarantine(path: string, run: typeof spawnSync = spawnSync, platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  const r = run("xattr", ["-d", "com.apple.quarantine", path], { encoding: "utf8" });
  return r.status === 0;
}

/** Done to a verified file before it is renamed into place. */
async function finish(pin: ArtifactPin, tmp: string, options: InstallOptions): Promise<void> {
  if (pin.kind !== "vmm") return;
  await chmod(tmp, 0o755);
  if (clearQuarantine(tmp, options.run)) options.log?.(`${pin.kind}: cleared com.apple.quarantine after verifying the sha256`);
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
          await finish(pin, tmp, options);
          await rename(tmp, dest);
          return { kind: pin.kind, path: dest, sha256: sha, source: "copied", from: source, ms: Date.now() - t0 };
        }
        problems.push(`${source} has sha256 ${sha}, not the pinned ${pin.sha256}`);
        await rm(tmp, { force: true });
      }
    }
    if (options.urlTemplate) {
      const url = expandUrlTemplate(options.urlTemplate, pin, options.release);
      log(`${pin.kind}: downloading ${url}`);
      try {
        const sha = await download(url, tmp, pin, options.fetch ?? fetch, log);
        if (sha === pin.sha256) {
          await finish(pin, tmp, options);
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

/** No bytes for this long (from the request, or since the last chunk) aborts an attempt. */
const STALL_MS = (): number => Number(process.env.BERTH_VM_DOWNLOAD_STALL_MS) || 30_000;
/** Attempts per artifact, the later ones resuming where the last stopped. */
const DOWNLOAD_ATTEMPTS = 4;

/**
 * Fetches `url` (http(s), or file: for a local mirror) to `dest` and returns
 * the sha256 of the whole file. GitHub release downloads redirect to a CDN;
 * the redirect is followed and the bytes are what is checked.
 *
 * A CDN connection can stop sending without closing, which used to hang an
 * install for good. So an attempt is aborted when no bytes arrive for
 * STALL_MS, and retried (up to DOWNLOAD_ATTEMPTS, with a short backoff),
 * asking for the rest with a Range request: a 206 whose Content-Range starts
 * where the file ends is appended, anything else starts over. A body larger
 * than the pin is refused at any point. The hash is taken over the finished
 * file, so a resumed download is checked exactly like a whole one.
 */
async function download(url: string, dest: string, pin: ArtifactPin, fetchImpl: typeof fetch, log: (message: string) => void = () => {}): Promise<string> {
  if (url.startsWith("file:")) {
    const path = fileURLToPath(url);
    const size = (await stat(path)).size;
    if (size !== pin.size) throw new Error(`size ${size}, but the pinned ${pin.kind} is ${pin.size} bytes`);
    await pipeline(createReadStream(path), createWriteStream(dest, { mode: 0o644 }));
    return sha256File(dest);
  }
  await rm(dest, { force: true });
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadAttempt(url, dest, pin, fetchImpl);
      break;
    } catch (err) {
      const have = existsSync(dest) ? statSync(dest).size : 0;
      const why = err instanceof Error ? err.message : String(err);
      if (err instanceof RefusedDownload || attempt >= DOWNLOAD_ATTEMPTS) {
        throw new Error(attempt > 1 ? `${why} (after ${attempt} attempts)` : why);
      }
      log(`${pin.kind}: ${why} at ${have} of ${pin.size} bytes; retrying (${attempt + 1} of ${DOWNLOAD_ATTEMPTS})${have > 0 ? ", resuming" : ""}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  const size = statSync(dest).size;
  if (size !== pin.size) throw new Error(`got ${size} bytes, the pinned ${pin.kind} is ${pin.size}`);
  return sha256File(dest);
}

/** What retrying can't fix: the server sends something other than the pinned file. */
class RefusedDownload extends Error {}

async function downloadAttempt(url: string, dest: string, pin: ArtifactPin, fetchImpl: typeof fetch): Promise<void> {
  const have = existsSync(dest) ? statSync(dest).size : 0;
  if (have === pin.size) return;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let received = 0;
  const stall = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`stalled: no data for ${STALL_MS() >= 1000 ? `${Math.round(STALL_MS() / 1000)} s` : `${STALL_MS()} ms`}`)), STALL_MS());
  };
  stall();
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal, ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    // A 206 for exactly the rest appends; a 200 (the server ignored the
    // range) or a range that doesn't start where the file ends starts over.
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    const resume = response.status === 206 && range !== null && Number(range[1]) === have && Number(range[3]) === pin.size;
    if (response.status === 206 && !resume) throw new Error(`the server answered a range request with ${response.headers.get("content-range") ?? "no Content-Range"}`);
    const start = resume ? have : 0;
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && start + declared !== pin.size) {
      throw new RefusedDownload(`content-length ${declared}${start ? ` from byte ${start}` : ""}, but the pinned ${pin.kind} is ${pin.size} bytes`);
    }
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (start + received > pin.size) body.destroy(new RefusedDownload(`more than the pinned ${pin.size} bytes`));
      else stall();
    });
    await pipeline(body, createWriteStream(dest, { mode: 0o644, flags: start > 0 ? "a" : "w" }));
  } catch (err) {
    // The abort's reason is the stall error; surface that, not "aborted".
    throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : err;
  } finally {
    clearTimeout(timer);
  }
}
