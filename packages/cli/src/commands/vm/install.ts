import { Command, Flags } from "@oclif/core";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { installArtifacts } from "../../vm/artifacts.js";
import { readConfigFile, resolveArtifactsDir, resolveArtifactsUrl } from "../../vm/config.js";
import { checkHost, writeEntitlementsFile } from "../../vm/host.js";
import { vmHome } from "../../vm/paths.js";

export default class VmInstall extends Command {
  static override description =
    "Install the pinned microVM kernel and rootfs into ~/.berth/vm, verified against their sha256 pins, and check that berth-vmm and libkrun can boot them";
  static override examples = [
    "<%= config.bin %> vm install --from ../vm-runtime-artifacts",
    "<%= config.bin %> vm install --from ../vm-runtime-artifacts --vmm packages/vmm/target/release/berth-vmm",
    "BERTH_VM_ARTIFACTS_URL='https://mirror.example/{kind}/sha256/{sha256}/{file}' <%= config.bin %> vm install",
  ];
  static override flags = {
    from: Flags.string({
      description: "a directory to copy the artifacts from: a packages/vmm build's artifacts directory (defaults to BERTH_VMM_ARTIFACTS)",
    }),
    url: Flags.string({
      description: "download URL template for whatever --from lacks; {kind} is kernel or rootfs, {sha256} the pin, {file} the file name (defaults to BERTH_VM_ARTIFACTS_URL, then vm.artifactsUrl in ~/.berth/config.json)",
    }),
    "no-download": Flags.boolean({ description: "only copy from --from; never download", default: false }),
    vmm: Flags.string({ description: "also copy this berth-vmm binary to ~/.berth/vm/bin/berth-vmm (its signature travels with it)" }),
    force: Flags.boolean({ description: "replace installed artifacts even when they verify", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VmInstall);
    const config = readConfigFile();
    const from = resolveArtifactsDir(flags.from, process.env, config);
    if (from && !existsSync(from)) this.error(`--from ${from} does not exist`);
    const urlTemplate = flags["no-download"] ? undefined : resolveArtifactsUrl(flags.url, process.env, config);
    if (!from && !urlTemplate) this.error("nothing to install from: pass --from <dir>, or drop --no-download");

    const t0 = Date.now();
    let results;
    try {
      results = await installArtifacts({ ...(from ? { from: resolve(from) } : {}), ...(urlTemplate ? { urlTemplate } : {}), force: flags.force, log: (m) => this.log(m) });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }
    for (const r of results) {
      const how = r.source === "installed" ? "already installed" : r.source === "copied" ? `copied from ${r.from}` : `downloaded from ${r.from}`;
      this.log(`✔ ${r.kind} ${r.sha256.slice(0, 16)}… verified (${how}, ${r.ms} ms)`);
      this.log(`    ${r.path}`);
    }

    if (flags.vmm) {
      const src = resolve(flags.vmm);
      if (!existsSync(src)) this.error(`--vmm ${src} does not exist`);
      const dest = join(vmHome(), "bin", "berth-vmm");
      mkdirSync(join(vmHome(), "bin"), { recursive: true });
      copyFileSync(src, `${dest}.tmp`, constants.COPYFILE_FICLONE);
      chmodSync(`${dest}.tmp`, 0o755);
      renameSync(`${dest}.tmp`, dest);
      this.log(`✔ berth-vmm copied to ${dest}`);
    }
    const entitlements = writeEntitlementsFile();

    const host = checkHost(config.vm?.vmm ? { configuredVmm: config.vm.vmm } : {});
    this.log("");
    for (const c of host.checks) {
      this.log(`  ${c.status === "ok" ? "✔" : c.status === "warn" ? "!" : "✘"} ${c.title}: ${c.detail}`);
      if (c.remedy) this.log(`      → ${c.remedy}`);
    }
    this.log("");
    this.log(`Done in ${Date.now() - t0} ms. (codesign entitlements for berth-vmm: ${entitlements})`);
    if (host.checks.some((c) => c.status === "fail")) {
      this.log("The artifacts are in place, but this host can't boot them yet; fix the ✘ lines above.");
      this.exit(1);
    }
    this.log("Next: `berth dev --runtime vm` in an app directory.");
  }
}
