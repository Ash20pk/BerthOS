import { test } from "node:test";
import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHost, vmmFeatures } from "./host.js";
import { KERNEL_PIN, ROOTFS_PIN } from "./pins.js";

const dir = mkdtempSync(join(tmpdir(), "berth-host-"));
function fakeVmm(kernel = KERNEL_PIN.sha256, rootfs = ROOTFS_PIN.sha256) {
  const path = join(dir, `berth-vmm-${kernel.slice(0, 4)}-${rootfs.slice(0, 4)}`);
  writeFileSync(path, `\0ELF\0name = "berth-kernel"\nimage_size = 1\nimage_sha256 = "${kernel}"\n\0name = "berth-rootfs"\nimage_sha256 = "${rootfs}"\nimage_size = 2\n\0`);
  chmodSync(path, 0o755);
  return path;
}
const lib = join(dir, "libkrun.1.19.6.dylib");
writeFileSync(lib, "");
const oldLib = join(dir, "libkrun.1.18.0.dylib");
writeFileSync(oldLib, "");

/** Answers the commands checkHost runs, as a macOS host would. */
function host(o: { hv?: string; codesign?: { status: number; out: string }; libkrun?: string }) {
  return ((cmd: string) => {
    if (cmd === "sysctl") return { status: 0, stdout: `${o.hv ?? "1"}\n`, stderr: "" };
    if (cmd === "codesign") return { status: o.codesign?.status ?? 0, stdout: o.codesign?.out ?? "<key>com.apple.security.hypervisor</key>\n\t<true/>", stderr: "" };
    if (cmd === "otool") return { status: 0, stdout: `x:\n\t${o.libkrun ?? lib} (compatibility version 1.0.0)\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
}
const byId = (r: ReturnType<typeof checkHost>) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test("a ready macOS host: HVF, a signed berth-vmm with this CLI's pins, libkrun 1.19.6", () => {
  const r = checkHost({ env: { BERTH_VMM: fakeVmm() }, platform: "darwin", run: host({}) });
  assert.deepEqual(r.checks.map((c) => [c.id, c.status]), [["hypervisor", "ok"], ["berth-vmm", "ok"], ["codesign", "ok"], ["pins", "ok"], ["libkrun", "ok"]]);
});

test("unsigned berth-vmm: fail, with the codesign command that fixes it", () => {
  const vmm = fakeVmm();
  const c = byId(checkHost({ env: { BERTH_VMM: vmm }, platform: "darwin", run: host({ codesign: { status: 1, out: `${vmm}: code object is not signed at all` } }) }));
  assert.equal(c.codesign!.status, "fail");
  assert.match(c.codesign!.detail, /not signed at all/);
  assert.match(c.codesign!.remedy!, new RegExp(`codesign --sign - --force --entitlements .*berth-vmm.entitlements ${vmm}`));
  const noEntitlement = byId(checkHost({ env: { BERTH_VMM: vmm }, platform: "darwin", run: host({ codesign: { status: 0, out: "<dict></dict>" } }) }));
  assert.equal(noEntitlement.codesign!.status, "fail");
});

test("libkrun missing or the wrong version: fail, with the install command", () => {
  const missing = byId(checkHost({ env: { BERTH_VMM: fakeVmm() }, platform: "darwin", run: host({ libkrun: join(dir, "nope", "libkrun.1.dylib") }) }));
  assert.equal(missing.libkrun!.status, "fail");
  assert.match(missing.libkrun!.remedy!, /brew tap libkrun\/krun && brew install libkrun/);
  const old = byId(checkHost({ env: { BERTH_VMM: fakeVmm() }, platform: "darwin", run: host({ libkrun: oldLib }) }));
  assert.equal(old.libkrun!.status, "fail");
  assert.match(old.libkrun!.detail, /1\.18\.0 .*built against 1\.19\.6/);
});

test("no hypervisor, no berth-vmm, other pins", () => {
  assert.equal(byId(checkHost({ env: { BERTH_VMM: fakeVmm() }, platform: "darwin", run: host({ hv: "0" }) })).hypervisor!.status, "fail");
  const none = byId(checkHost({ env: { BERTH_VMM: join(dir, "absent") }, platform: "darwin", run: host({}) }));
  assert.equal(none["berth-vmm"]!.status, "fail");
  assert.match(none["berth-vmm"]!.detail, /BERTH_VMM=.*does not exist/);
  const other = byId(checkHost({ env: { BERTH_VMM: fakeVmm(KERNEL_PIN.sha256, "f".repeat(64)) }, platform: "darwin", run: host({}) }));
  assert.equal(other.pins!.status, "warn", "berth-vmm's pins are used; the CLI's differing copy is only a warning");
  assert.match(other.pins!.detail, /rootfs ffffffffffff…/);
});

test("secrets disk support is read from berth-vmm's own run --help", () => {
  const withSecrets = ((_: string) => ({ status: 0, stdout: "  --secrets FILE        the sandbox's credentials", stderr: "" })) as unknown as typeof spawnSync;
  const without = ((_: string) => ({ status: 0, stdout: "  --egress-allow LIST", stderr: "" })) as unknown as typeof spawnSync;
  assert.deepEqual(vmmFeatures("/c/berth-vmm", withSecrets), { egress: false, secrets: true, publish: false, python: false, semanticFs: false, github: false, terminal: false, layers: [] });
  assert.deepEqual(vmmFeatures("/d/berth-vmm", without), { egress: true, secrets: false, publish: false, python: false, semanticFs: false, github: false, terminal: false, layers: [] });
});

test("egress support is read from berth-vmm's own run --help", () => {
  const withEgress = ((_: string) => ({ status: 0, stdout: "  --egress-allow LIST   the hosts this sandbox may reach", stderr: "" })) as unknown as typeof spawnSync;
  const without = ((_: string) => ({ status: 0, stdout: "  --state DISK", stderr: "" })) as unknown as typeof spawnSync;
  assert.equal(vmmFeatures("/a/berth-vmm", withEgress).egress, true);
  assert.equal(vmmFeatures("/b/berth-vmm", without).egress, false);
});

test("python3 and semantic-fs are read from the rootfs manifest compiled into berth-vmm", () => {
  const help = ((_: string) => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof spawnSync;
  const binary = (rootfsKeys: string) => () => Buffer.from(`\0ELF\0name = "berth-rootfs"\n${rootfsKeys}image_size = 2\n\0`);
  const sha = (c: string) => c.repeat(64);
  assert.deepEqual(vmmFeatures("/e/berth-vmm", help, binary(`sdk_python_sha256 = "${sha("a")}"\n`)), { egress: false, secrets: false, publish: false, python: true, semanticFs: false, github: false, terminal: false, layers: [] });
  assert.deepEqual(
    vmmFeatures("/f/berth-vmm", help, binary(`sdk_python_sha256 = "${sha("a")}"\nsemantic_fs_daemon_sha256 = "${sha("b")}"\n`)),
    { egress: false, secrets: false, publish: false, python: true, semanticFs: true, github: false, terminal: false, layers: [] },
  );
  assert.equal(vmmFeatures("/g/berth-vmm", help, binary(`semantic_fs_daemon_sha256 = "unset"\n`)).semanticFs, false);
});

test("the GitHub API broker is read from the rootfs manifest compiled into berth-vmm", () => {
  const help = ((_: string) => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof spawnSync;
  const binary = () => Buffer.from(`\0ELF\0name = "berth-rootfs"\ngithub_api_broker_sha256 = "${"c".repeat(64)}"\nimage_size = 2\n\0`);
  assert.equal(vmmFeatures("/h/berth-vmm", help, binary).github, true);
});

test("tmux for terminal:* apps is read from the rootfs manifest compiled into berth-vmm", () => {
  const help = ((_: string) => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof spawnSync;
  assert.equal(vmmFeatures("/t/berth-vmm", help, () => Buffer.from(`\0ELF\0name = "berth-rootfs"\nterminal = "tmux"\nimage_size = 2\n\0`)).terminal, true);
  assert.equal(vmmFeatures("/u/berth-vmm", help, () => Buffer.from(`\0ELF\0name = "berth-rootfs"\nimage_size = 2\n\0`)).terminal, false);
});

test("layers are read from the rootfs manifest compiled into berth-vmm, and only with run --layer", () => {
  const sha = (c: string) => c.repeat(64);
  const bin = () => Buffer.from(`\0ELF\0name = "berth-rootfs"\nimage_sha256 = "${sha("a")}"\nimage_size = 2\nlayer_browser_sha256 = "${sha("b")}"\nlayer_browser_size = 400\nlayer_browser_base = "${sha("a")}"\n\0`);
  const withLayer = ((_: string) => ({ status: 0, stdout: "  --layer NAME", stderr: "" })) as unknown as typeof spawnSync;
  const without = ((_: string) => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof spawnSync;
  assert.deepEqual(vmmFeatures("/l/berth-vmm", withLayer, bin).layers, ["browser"]);
  assert.deepEqual(vmmFeatures("/m/berth-vmm", without, bin).layers, []);
});
