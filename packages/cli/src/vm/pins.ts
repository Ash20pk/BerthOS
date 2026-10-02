/**
 * The guest kernel and base rootfs this CLI boots, by sha256. They are the
 * same pins berth-vmm compiles in (packages/vmm/kernel/manifest.toml and
 * rootfs/manifest.toml, image_sha256); berth-vmm refuses anything else, so a
 * mismatch here only means the CLI fetched the wrong thing, never that it
 * booted it. pins.test.ts checks these against the manifests in a checkout,
 * and `berth doctor` checks that the berth-vmm binary it finds carries them.
 */
export interface ArtifactPin {
  kind: "kernel" | "rootfs" | "vmm";
  sha256: string;
  size: number;
  /** The file name inside the artifacts directory. */
  file: string;
  /** Where berth-vmm looks for it, relative to the artifacts directory. */
  relPath: string;
  /**
   * Its name as a release asset, which carries the sha256 (Image-<sha256>,
   * rootfs-<sha256>.erofs, berth-vmm-darwin-arm64-<sha256>), so that one
   * release can hold several of a kind and a file is always its own hash.
   */
  asset: string;
}

export const KERNEL_SHA256 = "8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8";
export const KERNEL_SIZE = 23668744;
export const KERNEL_LINUX = "6.12.109";
export const KERNEL_CONFIG_SHA256 = "e3f33c2bd4bffa16e52a066c325967e4bde091f20063e6eb5b81e8a2efac4dc8";
export const ROOTFS_SHA256 = "322ee4f323f591b4fe2adaf3e305f2f06f8b8fe8cf7d79b9ee30e327ed0868eb";
export const ROOTFS_SIZE = 74743808;
/** The libkrun berth-vmm is built against (packages/vmm/src/main.rs declares its API at this version). */
export const LIBKRUN_VERSION = "1.19.6";

export function kernelPin(sha256: string, size: number): ArtifactPin {
  return { kind: "kernel", sha256, size, file: "Image", relPath: `kernel/sha256/${sha256}/Image`, asset: `Image-${sha256}` };
}

export function rootfsPin(sha256: string, size: number): ArtifactPin {
  const file = `rootfs-${sha256}.erofs`;
  return { kind: "rootfs", sha256, size, file, relPath: `rootfs/${file}`, asset: file };
}

export const KERNEL_PIN: ArtifactPin = kernelPin(KERNEL_SHA256, KERNEL_SIZE);
export const ROOTFS_PIN: ArtifactPin = rootfsPin(ROOTFS_SHA256, ROOTFS_SIZE);

export const PINS: readonly ArtifactPin[] = [KERNEL_PIN, ROOTFS_PIN];

/**
 * The GitHub release that publishes a kernel and rootfs pair
 * (.github/workflows/vm-artifacts.yml): `vm-artifacts-<kernel8>-<rootfs8>`.
 */
export function releaseTag(kernelSha256: string, rootfsSha256: string): string {
  return `vm-artifacts-${kernelSha256.slice(0, 8)}-${rootfsSha256.slice(0, 8)}`;
}

/** A platform berth-vmm is published for: `${process.platform}-${process.arch}`. */
export type VmmPlatform = "darwin-arm64";

/**
 * Published berth-vmm builds this CLI will download and run, by platform. Each
 * is the binary the vm-artifacts workflow built for this CLI's kernel and
 * rootfs pins (it compiles those pins in) and uploaded to their release as
 * berth-vmm-<platform>-<sha256>. The workflow prints the line to add here.
 * The binary is ad hoc signed, so the sha256 here is what vouches for it:
 * `berth vm install` refuses any other bytes, and clears macOS's quarantine
 * attribute only on a file that matched.
 *
 * Empty until the first release is built: the sha256 of a binary CI builds
 * cannot be known before CI builds it.
 */
export const VMM_PINS: Partial<Record<VmmPlatform, { sha256: string; size: number }>> = {};

export function vmmPin(platform: string = `${process.platform}-${process.arch}`, pins: Partial<Record<string, { sha256: string; size: number }>> = VMM_PINS): ArtifactPin | undefined {
  const p = pins[platform];
  if (!p) return undefined;
  return { kind: "vmm", sha256: p.sha256, size: p.size, file: "berth-vmm", relPath: "bin/berth-vmm", asset: `berth-vmm-${platform}-${p.sha256}` };
}

/** `key = "value"` / `key = 123` lines of a flat manifest. */
export function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([a-z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/.exec(line.trim());
    if (m) out[m[1]!] ??= m[2]!;
  }
  return out;
}

/**
 * The manifests a berth-vmm binary was built with. They are compiled in
 * verbatim (include_str!), so each sits in the binary as one run of text
 * starting at its `name = "berth-kernel"` / `name = "berth-rootfs"` line.
 */
export function manifestsInBinary(bytes: Buffer): { kernel?: Record<string, string>; rootfs?: Record<string, string> } {
  const region = (marker: string) => {
    const at = bytes.indexOf(marker);
    if (at < 0) return undefined;
    let end = at;
    // Up to the first byte that can't be manifest text.
    while (end < bytes.length && end - at < 16384 && (bytes[end] === 0x0a || bytes[end] === 0x09 || (bytes[end]! >= 0x20 && bytes[end]! < 0x7f))) end++;
    return parseManifest(bytes.subarray(at, end).toString("latin1"));
  };
  return { kernel: region('name = "berth-kernel"'), rootfs: region('name = "berth-rootfs"') };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The pins a berth-vmm boots, read out of the binary: it refuses anything
 * else, so these, not the CLI's built-in copy, are what an install must
 * fetch. Undefined when the binary doesn't carry readable manifests.
 */
export function pinsFromManifests(m: { kernel?: Record<string, string>; rootfs?: Record<string, string> }): { kernel: ArtifactPin; rootfs: ArtifactPin } | undefined {
  const ks = m.kernel?.image_sha256;
  const rs = m.rootfs?.image_sha256;
  const kn = Number(m.kernel?.image_size);
  const rn = Number(m.rootfs?.image_size);
  if (!ks || !rs || !HEX64.test(ks) || !HEX64.test(rs) || !Number.isInteger(kn) || !Number.isInteger(rn)) return undefined;
  return { kernel: kernelPin(ks, kn), rootfs: rootfsPin(rs, rn) };
}
