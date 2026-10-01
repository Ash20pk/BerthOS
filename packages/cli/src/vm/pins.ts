/**
 * The guest kernel and base rootfs this CLI boots, by sha256. They are the
 * same pins berth-vmm compiles in (packages/vmm/kernel/manifest.toml and
 * rootfs/manifest.toml, image_sha256); berth-vmm refuses anything else, so a
 * mismatch here only means the CLI fetched the wrong thing, never that it
 * booted it. pins.test.ts checks these against the manifests in a checkout,
 * and `berth doctor` checks that the berth-vmm binary it finds carries them.
 */
export interface ArtifactPin {
  kind: "kernel" | "rootfs";
  sha256: string;
  size: number;
  /** The file name inside the artifacts directory. */
  file: string;
  /** Where berth-vmm looks for it, relative to the artifacts directory. */
  relPath: string;
}

export const KERNEL_SHA256 = "8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8";
export const KERNEL_SIZE = 23668744;
export const KERNEL_LINUX = "6.12.109";
export const KERNEL_CONFIG_SHA256 = "e3f33c2bd4bffa16e52a066c325967e4bde091f20063e6eb5b81e8a2efac4dc8";
export const ROOTFS_SHA256 = "57e7ef8b56a30280beeb2f96eb77c35b0e2fcd0c585e9259e2899d47e565bf0d";
export const ROOTFS_SIZE = 46678016;
/** The libkrun berth-vmm is built against (packages/vmm/src/main.rs declares its API at this version). */
export const LIBKRUN_VERSION = "1.19.6";

export const KERNEL_PIN: ArtifactPin = {
  kind: "kernel",
  sha256: KERNEL_SHA256,
  size: KERNEL_SIZE,
  file: "Image",
  relPath: `kernel/sha256/${KERNEL_SHA256}/Image`,
};

export const ROOTFS_PIN: ArtifactPin = {
  kind: "rootfs",
  sha256: ROOTFS_SHA256,
  size: ROOTFS_SIZE,
  file: `rootfs-${ROOTFS_SHA256}.erofs`,
  relPath: `rootfs/rootfs-${ROOTFS_SHA256}.erofs`,
};

export const PINS: readonly ArtifactPin[] = [KERNEL_PIN, ROOTFS_PIN];

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
  return {
    kernel: { kind: "kernel", sha256: ks, size: kn, file: "Image", relPath: `kernel/sha256/${ks}/Image` },
    rootfs: { kind: "rootfs", sha256: rs, size: rn, file: `rootfs-${rs}.erofs`, relPath: `rootfs/rootfs-${rs}.erofs` },
  };
}
