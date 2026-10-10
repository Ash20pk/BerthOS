import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ARTIFACTS_URL } from "./config.js";
import { GUEST_PINS, guestArch, layerPinsFromManifest, VMM_PINS, manifestsInBinary, pinsFromManifests, type GuestArch } from "./pins.js";

const vmm = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "vmm");
const get = (manifest: string, key: string) => manifest.split("\n").map((l) => l.split("=")).find(([k]) => k!.trim() === key)?.[1]?.trim().replace(/^"|"$/g, "");

const ARCHES: GuestArch[] = ["aarch64", "x86_64"];

for (const arch of ARCHES) {
  const kernelFile = join(vmm, "kernel", `manifest-${arch}.toml`);
  test(`the CLI's ${arch} pins are the ones berth-vmm compiles in (packages/vmm manifests)`, { skip: !existsSync(kernelFile) && `no ${arch} manifests in this checkout` }, () => {
    const kernel = readFileSync(kernelFile, "utf8");
    const rootfs = readFileSync(join(vmm, "rootfs", `manifest-${arch}.toml`), "utf8");
    const pins = GUEST_PINS[arch];
    assert.ok(pins, `pins.ts has no ${arch} pins`);
    assert.equal(get(kernel, "arch"), arch);
    assert.equal(get(rootfs, "arch"), arch);
    assert.equal(get(kernel, "image_sha256"), pins.kernel.sha256);
    assert.equal(Number(get(kernel, "image_size")), pins.kernel.size);
    assert.equal(get(kernel, "linux_version"), pins.kernel.linux);
    assert.equal(get(kernel, "config_sha256"), pins.kernel.configSha256);
    assert.equal(get(rootfs, "image_sha256"), pins.rootfs.sha256);
    assert.equal(Number(get(rootfs, "image_size")), pins.rootfs.size);
    // The kernel manifest's dist_url is the CLI's default template, for the kernel.
    assert.equal(get(kernel, "dist_url"), DEFAULT_ARTIFACTS_URL.replace("{asset}", "Image-{image_sha256}"));
    // Every layer is pinned in full, and for this base.
    const layers = layerPinsFromManifest(Object.fromEntries(rootfs.split("\n").map((l) => l.split("=")).filter((kv) => kv.length === 2).map(([k, v]) => [k!.trim(), v!.trim().replace(/^"|"$/g, "")])));
    for (const l of Object.values(layers)) assert.equal(l.base, pins.rootfs.sha256, `layer ${l.name} was built for this rootfs`);
  });
}

test("every pinned architecture has its manifests, and berth-vmm pins are well formed", () => {
  for (const arch of Object.keys(GUEST_PINS)) {
    if (existsSync(join(vmm, "kernel"))) assert.ok(existsSync(join(vmm, "kernel", `manifest-${arch}.toml`)), `pins.ts pins ${arch}, the checkout has no manifest`);
  }
  for (const p of Object.values(VMM_PINS)) assert.match(p!.sha256, /^[0-9a-f]{64}$/);
});

test("a Node arch names its guest architecture", () => {
  assert.equal(guestArch("arm64"), "aarch64");
  assert.equal(guestArch("x64"), "x86_64");
  assert.equal(guestArch("ia32"), undefined);
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
