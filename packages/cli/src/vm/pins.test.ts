import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_CONFIG_SHA256, KERNEL_LINUX, KERNEL_SHA256, KERNEL_SIZE, ROOTFS_SHA256, ROOTFS_SIZE } from "./pins.js";

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
  // The download template's default matches the kernel manifest's planned dist_url.
  assert.equal(get(kernel, "dist_url"), `https://artifacts.berth.dev/kernel/sha256/{image_sha256}/Image`);
});
