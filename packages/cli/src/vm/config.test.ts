import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ARTIFACTS_URL, defaultSandbox, readConfigFile, resolveArtifactsDir, resolveArtifactsUrl, resolveSandbox } from "./config.js";
import { expandUrlTemplate } from "./artifacts.js";
import { KERNEL_PIN, ROOTFS_PIN, releaseTag } from "./pins.js";

const intelMac = { platform: "darwin" as const, arch: "x64", kvm: () => false };
const appleSilicon = { platform: "darwin" as const, arch: "arm64", kvm: () => false };

test("sandbox runtime: flag over BERTH_SANDBOX over the config file over the host's default", () => {
  assert.equal(resolveSandbox(undefined, {}, {}, intelMac), "docker");
  assert.equal(resolveSandbox(undefined, {}, {}, appleSilicon), "vm");
  assert.equal(resolveSandbox(undefined, {}, { sandbox: "vm" }, intelMac), "vm");
  assert.equal(resolveSandbox(undefined, {}, { sandbox: "docker" }, appleSilicon), "docker");
  assert.equal(resolveSandbox(undefined, { BERTH_SANDBOX: "docker" }, { sandbox: "vm" }, appleSilicon), "docker");
  assert.equal(resolveSandbox("vm", { BERTH_SANDBOX: "docker" }, {}, intelMac), "vm");
  assert.throws(() => resolveSandbox("firecracker", {}, {}, appleSilicon), /--runtime is "firecracker"; expected docker or vm/);
  // BERTH_RUNTIME is the Docker container runtime (runsc), and is not read here.
  assert.equal(resolveSandbox(undefined, { BERTH_RUNTIME: "vm" } as NodeJS.ProcessEnv, {}, intelMac), "docker");
});

test("the default is the microVM wherever it can run, and Docker everywhere else", () => {
  assert.equal(defaultSandbox(appleSilicon), "vm");
  assert.equal(defaultSandbox(intelMac), "docker");
  assert.equal(defaultSandbox({ platform: "linux", arch: "x64", kvm: () => true }), "vm");
  assert.equal(defaultSandbox({ platform: "linux", arch: "arm64", kvm: () => true }), "vm");
  // Most CI runners and cloud VMs: no /dev/kvm, or not this user's.
  assert.equal(defaultSandbox({ platform: "linux", arch: "x64", kvm: () => false }), "docker");
  assert.equal(defaultSandbox({ platform: "win32", arch: "x64", kvm: () => false }), "docker");
  // No published berth-vmm for the platform: nothing to download, so Docker.
  assert.equal(defaultSandbox({ platform: "linux", arch: "riscv64", kvm: () => true }), "docker");
});

test("artifact sources: flag, then environment, then config", () => {
  assert.equal(resolveArtifactsUrl(undefined, {}, {}), DEFAULT_ARTIFACTS_URL);
  assert.equal(resolveArtifactsUrl(undefined, {}, { vm: { artifactsUrl: "https://c/{sha256}" } }), "https://c/{sha256}");
  assert.equal(resolveArtifactsUrl(undefined, { BERTH_VM_ARTIFACTS_URL: "https://e/{sha256}" }, { vm: { artifactsUrl: "https://c" } }), "https://e/{sha256}");
  assert.equal(resolveArtifactsUrl("https://f", { BERTH_VM_ARTIFACTS_URL: "https://e" }, {}), "https://f");
  assert.equal(resolveArtifactsDir(undefined, { BERTH_VMM_ARTIFACTS: "" }, {}), undefined);
  assert.equal(resolveArtifactsDir(undefined, { BERTH_VMM_ARTIFACTS: "/a" }, { vm: { artifactsDir: "/b" } }), "/a");
});

test("the URL template is keyed by sha256, and defaults to the pair's GitHub release", () => {
  const tag = releaseTag(KERNEL_PIN.sha256, ROOTFS_PIN.sha256);
  assert.equal(tag, `vm-artifacts-${KERNEL_PIN.sha256.slice(0, 8)}-${ROOTFS_PIN.sha256.slice(0, 8)}`);
  const pair = { kernel: KERNEL_PIN.sha256, rootfs: ROOTFS_PIN.sha256 };
  assert.equal(expandUrlTemplate(DEFAULT_ARTIFACTS_URL, KERNEL_PIN, pair), `https://github.com/Ash20pk/BerthOS/releases/download/${tag}/Image-${KERNEL_PIN.sha256}`);
  assert.equal(expandUrlTemplate(DEFAULT_ARTIFACTS_URL, ROOTFS_PIN, pair), `https://github.com/Ash20pk/BerthOS/releases/download/${tag}/rootfs-${ROOTFS_PIN.sha256}.erofs`);
  assert.equal(expandUrlTemplate("http://m/{sha256}/{file}", ROOTFS_PIN), `http://m/${ROOTFS_PIN.sha256}/rootfs-${ROOTFS_PIN.sha256}.erofs`);
});

test("a config file that isn't JSON is an error, a missing one is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "berth-config-"));
  assert.deepEqual(readConfigFile(join(dir, "none.json")), {});
  writeFileSync(join(dir, "bad.json"), "{nope");
  assert.throws(() => readConfigFile(join(dir, "bad.json")), /is not valid JSON/);
});
