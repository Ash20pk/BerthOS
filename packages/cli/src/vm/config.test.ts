import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ARTIFACTS_URL, readConfigFile, resolveArtifactsDir, resolveArtifactsUrl, resolveSandbox } from "./config.js";
import { expandUrlTemplate } from "./artifacts.js";
import { KERNEL_PIN, ROOTFS_PIN } from "./pins.js";

test("sandbox runtime: flag over BERTH_SANDBOX over the config file over docker", () => {
  assert.equal(resolveSandbox(undefined, {}, {}), "docker");
  assert.equal(resolveSandbox(undefined, {}, { sandbox: "vm" }), "vm");
  assert.equal(resolveSandbox(undefined, { BERTH_SANDBOX: "docker" }, { sandbox: "vm" }), "docker");
  assert.equal(resolveSandbox("vm", { BERTH_SANDBOX: "docker" }, {}), "vm");
  assert.throws(() => resolveSandbox("firecracker", {}, {}), /--runtime is "firecracker"; expected docker or vm/);
  // BERTH_RUNTIME is the Docker container runtime (runsc), and is not read here.
  assert.equal(resolveSandbox(undefined, { BERTH_RUNTIME: "vm" } as NodeJS.ProcessEnv, {}), "docker");
});

test("artifact sources: flag, then environment, then config", () => {
  assert.equal(resolveArtifactsUrl(undefined, {}, {}), DEFAULT_ARTIFACTS_URL);
  assert.equal(resolveArtifactsUrl(undefined, {}, { vm: { artifactsUrl: "https://c/{sha256}" } }), "https://c/{sha256}");
  assert.equal(resolveArtifactsUrl(undefined, { BERTH_VM_ARTIFACTS_URL: "https://e/{sha256}" }, { vm: { artifactsUrl: "https://c" } }), "https://e/{sha256}");
  assert.equal(resolveArtifactsUrl("https://f", { BERTH_VM_ARTIFACTS_URL: "https://e" }, {}), "https://f");
  assert.equal(resolveArtifactsDir(undefined, { BERTH_VMM_ARTIFACTS: "" }, {}), undefined);
  assert.equal(resolveArtifactsDir(undefined, { BERTH_VMM_ARTIFACTS: "/a" }, { vm: { artifactsDir: "/b" } }), "/a");
});

test("the URL template is keyed by sha256", () => {
  assert.equal(expandUrlTemplate(DEFAULT_ARTIFACTS_URL, KERNEL_PIN), `https://artifacts.berth.dev/kernel/sha256/${KERNEL_PIN.sha256}/Image`);
  assert.equal(expandUrlTemplate("http://m/{sha256}/{file}", ROOTFS_PIN), `http://m/${ROOTFS_PIN.sha256}/rootfs-${ROOTFS_PIN.sha256}.erofs`);
});

test("a config file that isn't JSON is an error, a missing one is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "berth-config-"));
  assert.deepEqual(readConfigFile(join(dir, "none.json")), {});
  writeFileSync(join(dir, "bad.json"), "{nope");
  assert.throws(() => readConfigFile(join(dir, "bad.json")), /is not valid JSON/);
});
