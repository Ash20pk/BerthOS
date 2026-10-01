import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BerthManifest } from "@berthos/manifest-schema";
import { devImageTag, productionImageTag, testImageTag } from "./build.js";

const manifest = { name: "filesystem", version: "1.2.0" } as BerthManifest;

test("dev and test images are tagged per checkout; the shipped one isn't", () => {
  const a = mkdtempSync(join(tmpdir(), "berth-checkout-a-"));
  const b = mkdtempSync(join(tmpdir(), "berth-checkout-b-"));
  assert.match(devImageTag(manifest, a), /^berth\/filesystem:dev-[0-9a-f]{8}$/);
  assert.match(testImageTag(manifest, a), /^berth\/filesystem:1\.2\.0-[0-9a-f]{8}$/);
  assert.notEqual(devImageTag(manifest, a), devImageTag(manifest, b));
  assert.notEqual(testImageTag(manifest, a), testImageTag(manifest, b));
  assert.equal(devImageTag(manifest, a), devImageTag(manifest, a));
  assert.equal(productionImageTag(manifest), "berth/filesystem:1.2.0");
});
