import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ARTIFACTS_URL } from "./config.js";
import { KERNEL_CONFIG_SHA256, KERNEL_LINUX, KERNEL_SHA256, KERNEL_SIZE, ROOTFS_SHA256, ROOTFS_SIZE, VMM_PINS, manifestsInBinary, pinsFromManifests } from "./pins.js";

const vmm = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "vmm");
const get = (manifest: string, key: string) => manifest.split("\n").map((l) => l.split("=")).find(([k]) => k!.trim() === key)?.[1]?.trim().replace(/^"|"$/g, "");

test("the CLI's pins are the ones berth-vmm compiles in (packages/vmm manifests)", { skip: !existsSync(join(vmm, "kernel", "manifest.toml")) && "not in a checkout" }, () => {
  const kernel = readFileSync(join(vmm, "kernel", "manifest.toml"), "utf8");
  const rootfs = readFileSync(join(vmm, "rootfs", "manifest.toml"), "utf8");
  assert.equal(get(kernel, "image_sha256"), KERNEL_SHA256);
  assert.equal(Number(get(kernel, "image_size")), KERNEL_SIZE);
  assert.equal(get(kernel, "linux_version"), KERNEL_LINUX);
  assert.equal(get(kernel, "config_sha256"), KERNEL_CONFIG_SHA256);
  assert.equal(get(rootfs, "image_sha256"), ROOTFS_SHA256);
  assert.equal(Number(get(rootfs, "image_size")), ROOTFS_SIZE);
  // The kernel manifest's dist_url is the CLI's default template, for the kernel.
  assert.equal(get(kernel, "dist_url"), DEFAULT_ARTIFACTS_URL.replace("{asset}", "Image-{image_sha256}"));
  // A pinned berth-vmm was built for this pair (the release it is published in).
  for (const p of Object.values(VMM_PINS)) assert.match(p!.sha256, /^[0-9a-f]{64}$/);
});

test("the pins are read out of a berth-vmm binary's compiled-in manifests", () => {
  const k = "a".repeat(64);
  const r = "b".repeat(64);
  const bin = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]),
    Buffer.from(`# kernel pin\nschema = 1\nname = "berth-kernel"\nimage_size = 10\nimage_sha256 = "${k}"\ncmdline = "x init=/sbin/berth-init"\n`),
    Buffer.from([0, 0, 0xff]),
    Buffer.from(`name = "berth-rootfs"\nimage_sha256 = "${r}"\nimage_size = 20\n`),
    Buffer.from([0]),
  ]);
  const pins = pinsFromManifests(manifestsInBinary(bin))!;
  assert.equal(pins.kernel.sha256, k);
  assert.equal(pins.kernel.size, 10);
  assert.equal(pins.kernel.relPath, `kernel/sha256/${k}/Image`);
  assert.equal(pins.rootfs.relPath, `rootfs/rootfs-${r}.erofs`);
  assert.equal(pinsFromManifests(manifestsInBinary(Buffer.from("no manifests here"))), undefined);
});
