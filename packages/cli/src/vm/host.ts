import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readlinkSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync as readBytes } from "node:fs";
import { KERNEL_PIN, LIBKRUN_VERSION, ROOTFS_PIN, libkrunPin, manifestsInBinary, pinsFromManifests, vmmPin, type ArtifactPin, layerPinsFromManifest } from "./pins.js";
import { vmHome } from "./paths.js";
import type { VmFeatures } from "./support.js";

/**
 * What the host needs before `berth-vmm run` can boot anything: the berth-vmm
 * binary (with the hypervisor entitlement on macOS), the libkrun it links,
 * and a hypervisor (HVF or KVM). Each check says what it saw and, when it
 * fails, the command that fixes it. Nothing here installs or signs anything.
 */

export type HostCheckStatus = "ok" | "warn" | "fail";

export interface HostCheck {
  id: "hypervisor" | "berth-vmm" | "codesign" | "pins" | "libkrun" | "artifacts";
  title: string;
  status: HostCheckStatus;
  detail: string;
  remedy?: string;
}

/** The entitlements berth-vmm is signed with (packages/vmm/berth-vmm.entitlements). */
export const VMM_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.hypervisor</key>
	<true/>
	<key>com.apple.security.cs.disable-library-validation</key>
	<true/>
</dict>
</plist>
`;

export function entitlementsPath(): string {
  return join(vmHome(), "berth-vmm.entitlements");
}

/** Written next to the artifacts so the codesign remedy is one copy-paste. */
export function writeEntitlementsFile(): string {
  const path = entitlementsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, VMM_ENTITLEMENTS);
  return path;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The packages/vmm build in the checkout this CLI runs from, if there is one. */
function checkoutVmm(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/vm/host.js -> packages/cli -> packages/vmm
  return resolve(here, "..", "..", "..", "vmm", "target", "release", "berth-vmm");
}

/**
 * berth-vmm, in order: BERTH_VMM (or the config file's vm.vmm), the copy
 * `berth vm install --vmm` made under ~/.berth/vm/bin, PATH, then this
 * checkout's packages/vmm/target/release.
 */
export function vmmCandidates(env = process.env, configured?: string): string[] {
  const out: string[] = [];
  if (env.BERTH_VMM) out.push(env.BERTH_VMM);
  if (configured) out.push(configured);
  out.push(join(vmHome(), "bin", "berth-vmm"));
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) out.push(join(dir, "berth-vmm"));
  out.push(checkoutVmm());
  return out;
}

export function locateVmm(env = process.env, configured?: string): string | undefined {
  // An explicit BERTH_VMM that isn't there is an error, not a reason to fall through.
  if (env.BERTH_VMM) return env.BERTH_VMM;
  return vmmCandidates(env, configured).find((p) => existsSync(p) && isExecutable(p));
}

/** `codesign -d --entitlements - --xml`: does the binary carry com.apple.security.hypervisor? */
export function hasHypervisorEntitlement(path: string, run = spawnSync): { signed: boolean; entitled: boolean; detail: string } {
  const r = run("codesign", ["-d", "--entitlements", "-", "--xml", path], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) return { signed: false, entitled: false, detail: out.trim().split("\n").pop() ?? `codesign exited ${r.status}` };
  const entitled = /<key>com\.apple\.security\.hypervisor<\/key>\s*<true\s*\/>/.test(out);
  return { signed: true, entitled, detail: entitled ? "signed with com.apple.security.hypervisor" : "signed, without com.apple.security.hypervisor" };
}

export function codesignRemedy(vmm: string): string {
  return `codesign --sign - --force --entitlements ${entitlementsPath()} ${vmm}   (the entitlements file is written by \`berth vm install\`)`;
}

/**
 * The kernel and rootfs this berth-vmm boots (its compiled-in manifests),
 * and whether they are the ones this CLI was built with. berth-vmm's are the
 * ones that count: it refuses anything else.
 */
export function vmmPins(path: string): { pins?: { kernel: ArtifactPin; rootfs: ArtifactPin }; sameAsCli: boolean } {
  const pins = pinsFromManifests(manifestsInBinary(readBytes(path)));
  return { ...(pins ? { pins } : {}), sameAsCli: pins?.kernel.sha256 === KERNEL_PIN.sha256 && pins.rootfs.sha256 === ROOTFS_PIN.sha256 };
}

/**
 * Whether `berth vm install` replaces the berth-vmm under ~/.berth/vm/bin
 * with the published one this CLI pins. A copy that is the published build is
 * kept, and so is a local build (`--vmm`) that boots this CLI's kernel and
 * rootfs, unless --force. One built for other pins is an older release left by
 * an earlier CLI: it would boot the wrong rootfs, so it is replaced.
 */
export function staleInstalledVmm(path: string, published: ArtifactPin | undefined, force = false): { replace: boolean; reason: string } {
  if (!published) return { replace: false, reason: "none is published for this platform in this CLI version" };
  if (!existsSync(path)) return { replace: true, reason: "not installed" };
  const sha = createHash("sha256").update(readBytes(path)).digest("hex");
  if (sha === published.sha256) return { replace: false, reason: "the published build this CLI pins" };
  if (force) return { replace: true, reason: `sha256 ${sha.slice(0, 16)}…, not the pinned ${published.sha256.slice(0, 16)}…, and --force` };
  const { pins, sameAsCli } = vmmPins(path);
  if (sameAsCli) return { replace: false, reason: "a local build for this CLI's kernel and rootfs (--force replaces it with the published one)" };
  const built = pins ? `built for rootfs ${pins.rootfs.sha256.slice(0, 8)}` : "no readable pins";
  return { replace: true, reason: `${built}, but this CLI pins rootfs ${ROOTFS_PIN.sha256.slice(0, 8)}` };
}

/** The optional layers this berth-vmm will attach, from its compiled-in rootfs manifest. */
export function vmmLayerPins(vmm: string | undefined, read: (path: string) => Buffer = readBytes): ReturnType<typeof layerPinsFromManifest> {
  if (!vmm) return {};
  try {
    return layerPinsFromManifest(manifestsInBinary(read(vmm)).rootfs);
  } catch {
    return {};
  }
}

/** The pins to install and boot: berth-vmm's when it is found and readable, else the CLI's own. */
export function activePins(vmm: string | undefined): readonly ArtifactPin[] {
  if (vmm && existsSync(vmm)) {
    try {
      const p = vmmPins(vmm).pins;
      if (p) return [p.kernel, p.rootfs];
    } catch {}
  }
  return [KERNEL_PIN, ROOTFS_PIN];
}

export interface LibkrunInfo {
  /** The dylib/so berth-vmm links, as the loader would resolve it. */
  path?: string;
  version?: string;
  found: boolean;
}

/**
 * The libkrun berth-vmm loads, and its version: on macOS the one it links
 * (otool -L), from the Homebrew keg or the dylib's name; on Linux the first
 * libkrun.so.1 on its search path, from the name the link resolves to.
 */
export function libkrunInfo(vmm: string | undefined, platform = process.platform, run = spawnSync): LibkrunInfo {
  if (platform === "darwin") {
    let path = "/opt/homebrew/opt/libkrun/lib/libkrun.1.dylib";
    if (vmm) {
      const r = run("otool", ["-L", vmm], { encoding: "utf8" });
      const linked = (r.stdout ?? "").split("\n").map((l) => l.trim().split(" ")[0] ?? "").find((l) => /libkrun\.[0-9.]*dylib$/.test(l));
      if (linked) path = linked;
    }
    if (!existsSync(path)) return { path, found: false };
    return { path, found: true, version: versionFromLibPath(path) };
  }
  // berth-vmm's RUNPATH is $ORIGIN: a libkrun beside it (what `berth vm
  // install` puts there) wins over the system's.
  for (const dir of [...(vmm ? [dirname(vmm)] : []), "/usr/local/lib64", "/usr/local/lib", "/usr/lib64", "/usr/lib", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu"]) {
    const path = join(dir, "libkrun.so.1");
    if (existsSync(path)) return { path, found: true, version: versionFromLibPath(path) };
  }
  return { found: false };
}

function versionFromLibPath(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    const keg = /\/Cellar\/libkrun\/([0-9][^/]*)\//.exec(real);
    if (keg) return keg[1];
    const named = /libkrun\.(?:so\.)?([0-9]+\.[0-9]+\.[0-9]+)/.exec(real);
    if (named) return named[1];
    // Homebrew's opt symlink, when realpath stopped short.
    const link = readlinkSync(dirname(dirname(path)));
    return /libkrun\/([0-9][^/]*)$/.exec(link)?.[1];
  } catch {
    try {
      return readdirSync(dirname(path))
        .map((f) => /^libkrun\.([0-9]+\.[0-9]+\.[0-9]+)\.dylib$/.exec(f)?.[1])
        .find(Boolean);
    } catch {
      return undefined;
    }
  }
}

export function libkrunRemedy(platform = process.platform): string {
  return platform === "darwin"
    ? `brew tap libkrun/krun && brew install libkrun   (berth-vmm is built against libkrun ${LIBKRUN_VERSION})`
    : libkrunPin(`${platform}-${process.arch}`)
      ? "run `berth vm install`, which puts the libkrun berth-vmm was built with beside it"
      : `install libkrun ${LIBKRUN_VERSION} (https://github.com/containers/libkrun, built with BLK=1 NET=1)`;
}

export interface HypervisorInfo {
  name: "hvf" | "kvm" | "none";
  available: boolean;
  detail: string;
}

export function hypervisorInfo(platform = process.platform, run = spawnSync): HypervisorInfo {
  if (platform === "darwin") {
    const r = run("sysctl", ["-n", "kern.hv_support"], { encoding: "utf8" });
    const ok = (r.stdout ?? "").trim() === "1";
    return { name: "hvf", available: ok, detail: ok ? "Hypervisor.framework available (kern.hv_support=1)" : `kern.hv_support=${(r.stdout ?? "").trim() || "?"}` };
  }
  if (platform === "linux") {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
      return { name: "kvm", available: true, detail: "/dev/kvm is readable and writable" };
    } catch (err) {
      return { name: "kvm", available: false, detail: `/dev/kvm: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
    }
  }
  return { name: "none", available: false, detail: `no supported hypervisor on ${platform}` };
}

/**
 * Everything doctor and `berth vm install` report about the host, without the
 * artifacts (those need hashing, see artifacts.ts). `run` is injectable for tests.
 */
export function checkHost(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; configuredVmm?: string; run?: typeof spawnSync } = {}): { checks: HostCheck[]; vmm?: string; hypervisor: HypervisorInfo; libkrun: LibkrunInfo } {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? spawnSync;
  const checks: HostCheck[] = [];
  const hypervisor = hypervisorInfo(platform, run);
  checks.push({
    id: "hypervisor",
    title: `Hypervisor (${hypervisor.name.toUpperCase()})`,
    status: hypervisor.available ? "ok" : "fail",
    detail: hypervisor.detail,
    ...(hypervisor.available
      ? {}
      : { remedy: platform === "linux" ? "enable KVM and add yourself to the kvm group: sudo usermod -aG kvm $USER (then log in again)" : "the microVM runtime needs Apple silicon macOS or Linux with KVM; use --runtime docker" }),
  });

  const vmm = locateVmm(options.env ?? process.env, options.configuredVmm);
  if (!vmm || !existsSync(vmm)) {
    checks.push({
      id: "berth-vmm",
      title: "berth-vmm",
      status: "fail",
      detail: vmm ? `BERTH_VMM=${vmm} does not exist` : `not found: not in BERTH_VMM, ${join(vmHome(), "bin", "berth-vmm")}, PATH, or this checkout's packages/vmm/target/release`,
      remedy: vmmPin()
        ? "run `berth vm install`, which downloads the published berth-vmm and checks it against this CLI's pin, or set BERTH_VMM"
        : "build it (cd packages/vmm && cargo build --release) and run `berth vm install --vmm packages/vmm/target/release/berth-vmm`, or set BERTH_VMM",
    });
  } else {
    checks.push({ id: "berth-vmm", title: "berth-vmm", status: "ok", detail: vmm });
    if (platform === "darwin") {
      const sig = hasHypervisorEntitlement(vmm, run);
      checks.push({
        id: "codesign",
        title: "berth-vmm hypervisor entitlement",
        status: sig.entitled ? "ok" : "fail",
        detail: sig.detail,
        ...(sig.entitled ? {} : { remedy: codesignRemedy(vmm) }),
      });
    }
    const read = vmmPins(vmm);
    checks.push({
      id: "pins",
      title: "berth-vmm's pinned kernel and rootfs",
      status: read.pins ? (read.sameAsCli ? "ok" : "warn") : "fail",
      detail: !read.pins
        ? "no readable kernel/rootfs manifests in the binary"
        : `kernel ${read.pins.kernel.sha256.slice(0, 12)}…, rootfs ${read.pins.rootfs.sha256.slice(0, 12)}…${read.sameAsCli ? " (the same as this CLI's)" : ` — not this CLI's built-in kernel ${KERNEL_PIN.sha256.slice(0, 12)}… / rootfs ${ROOTFS_PIN.sha256.slice(0, 12)}…; berth-vmm's are used`}`,
      ...(read.pins ? {} : { remedy: "rebuild berth-vmm from packages/vmm (cargo build --release)" }),
    });
  }

  const libkrun = libkrunInfo(vmm && existsSync(vmm) ? vmm : undefined, platform, run);
  const versionOk = libkrun.version === LIBKRUN_VERSION;
  checks.push({
    id: "libkrun",
    title: "libkrun",
    status: !libkrun.found ? "fail" : versionOk ? "ok" : libkrun.version ? "fail" : "warn",
    detail: !libkrun.found
      ? `not found${libkrun.path ? ` at ${libkrun.path}` : ""}`
      : `${libkrun.version ?? "unknown version"} at ${libkrun.path}${versionOk || !libkrun.version ? "" : ` (berth-vmm is built against ${LIBKRUN_VERSION})`}`,
    ...(libkrun.found && versionOk ? {} : { remedy: libkrunRemedy(platform) }),
  });
  return { checks, ...(vmm ? { vmm } : {}), hypervisor, libkrun };
}

const featureCache = new Map<string, VmFeatures>();

/**
 * What this berth-vmm can do beyond the base `run`: options from its own
 * `run --help`, python3 when the rootfs manifest compiled into it pins
 * berth_sdk (sdk_python_sha256, feat/vm-python), and /context when it pins
 * semantic-fs-daemon (semantic_fs_daemon_sha256, feat/vm-semantic-fs-init).
 */
export function vmmFeatures(vmm: string, run = spawnSync, read: (path: string) => Buffer = readBytes): VmFeatures {
  const cached = featureCache.get(vmm);
  if (cached) return cached;
  const r = run(vmm, ["run", "--help"], { encoding: "utf8", timeout: 5_000 });
  const help = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  let python = false;
  let semanticFs = false;
  let github = false;
  let terminal = false;
  try {
    const rootfs = manifestsInBinary(read(vmm)).rootfs;
    python = /^[0-9a-f]{64}$/.test(rootfs?.sdk_python_sha256 ?? "");
    semanticFs = /^[0-9a-f]{64}$/.test(rootfs?.semantic_fs_daemon_sha256 ?? "");
    github = /^[0-9a-f]{64}$/.test(rootfs?.github_api_broker_sha256 ?? "");
    terminal = rootfs?.terminal === "tmux";
  } catch {}
  const layers = help.includes("--layer") ? Object.keys(vmmLayerPins(vmm, read)) : [];
  const features = { egress: help.includes("--egress-allow"), secrets: help.includes("--secrets"), publish: help.includes("--publish"), python, semanticFs, github, terminal, layers };
  featureCache.set(vmm, features);
  return features;
}
