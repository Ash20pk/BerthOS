import { Command, Flags } from "@oclif/core";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { clearQuarantine, installArtifacts, releasePair, sha256File } from "../../vm/artifacts.js";
import { readConfigFile, resolveArtifactsDir, resolveArtifactsUrl } from "../../vm/config.js";
import { activePins, checkHost, locateVmm, staleInstalledVmm, writeEntitlementsFile } from "../../vm/host.js";
import { vmHome } from "../../vm/paths.js";
import { LIBKRUN_VERSION, PINS, libkrunPin, vmmPin } from "../../vm/pins.js";
import { ensureLayers } from "../../vm/runtime.js";

export default class VmInstall extends Command {
  static override description =
    "Install the pinned microVM kernel and rootfs (and berth-vmm, when it isn't there or is an older release's) into ~/.berth/vm, verified against their sha256 pins, and check that berth-vmm and libkrun can boot them";
  static override examples = [
    "<%= config.bin %> vm install",
    "<%= config.bin %> vm install --from ../vm-runtime-artifacts --vmm packages/vmm/target/release/berth-vmm",
    "<%= config.bin %> vm install --url 'file:///path/to/release/{asset}'",
    "BERTH_VM_ARTIFACTS_URL='https://mirror.example/vm-artifacts-{kernel8}-{rootfs8}/{asset}' <%= config.bin %> vm install",
  ];
  static override flags = {
    from: Flags.string({
      description: "a directory to copy the artifacts from: a packages/vmm build's artifacts directory (defaults to BERTH_VMM_ARTIFACTS)",
    }),
    url: Flags.string({
      description:
        "download URL template for whatever --from lacks: {asset} is the release asset name (Image-<sha256>, rootfs-<sha256>.erofs, berth-vmm-<platform>-<sha256>), {kernel8}/{rootfs8} the release's pins, {sha256} the artifact's; http(s) or file: (defaults to BERTH_VM_ARTIFACTS_URL, then vm.artifactsUrl in ~/.berth/config.json, then the GitHub release)",
    }),
    "no-download": Flags.boolean({ description: "only copy from --from; never download", default: false }),
    vmm: Flags.string({
      description: "copy this berth-vmm binary to ~/.berth/vm/bin/berth-vmm instead of downloading the published one (its signature travels with it)",
    }),
    force: Flags.boolean({ description: "replace installed artifacts even when they verify", default: false }),
    layer: Flags.string({
      multiple: true,
      description: "also install this optional layer (e.g. browser), which is otherwise downloaded the first time an app needs it",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VmInstall);
    const config = readConfigFile();
    const from = resolveArtifactsDir(flags.from, process.env, config);
    if (from && !existsSync(from)) this.error(`--from ${from} does not exist`);
    const urlTemplate = flags["no-download"] ? undefined : resolveArtifactsUrl(flags.url, process.env, config);
    if (!from && !urlTemplate) this.error("nothing to install from: pass --from <dir>, or drop --no-download");

    const t0 = Date.now();
    const published = vmmPin();
    if (flags.vmm) {
      const src = resolve(flags.vmm);
      if (!existsSync(src)) this.error(`--vmm ${src} does not exist`);
      const dest = join(vmHome(), "bin", "berth-vmm");
      mkdirSync(join(vmHome(), "bin"), { recursive: true });
      copyFileSync(src, `${dest}.tmp`, constants.COPYFILE_FICLONE);
      chmodSync(`${dest}.tmp`, 0o755);
      // A published build that a browser downloaded is quarantined. Clear that
      // only on the exact bytes the CLI pins; a local build is the user's own.
      if (published && (await sha256File(`${dest}.tmp`)) === published.sha256 && clearQuarantine(`${dest}.tmp`)) {
        this.log("  berth-vmm matches the published build's sha256; cleared com.apple.quarantine");
      }
      renameSync(`${dest}.tmp`, dest);
      this.log(`✔ berth-vmm copied to ${dest}`);
      // Linux: a libkrun beside the build (as CI and a release lay them out)
      // goes with it, since berth-vmm loads the one beside itself first.
      const lib = join(dirname(src), "libkrun.so.1");
      if (process.platform === "linux" && existsSync(lib)) {
        const real = realpathSync(lib);
        const name = basename(real) === "libkrun.so.1" ? `libkrun.so.${LIBKRUN_VERSION}` : basename(real);
        copyFileSync(real, join(vmHome(), "bin", name));
        rmSync(join(vmHome(), "bin", "libkrun.so.1"), { force: true });
        symlinkSync(name, join(vmHome(), "bin", "libkrun.so.1"));
        this.log(`✔ ${name} copied beside it, from ${real}`);
      }
    } else if (!process.env.BERTH_VMM && !config.vm?.vmm) {
      // The published berth-vmm, pinned in this CLI, into ~/.berth/vm/bin:
      // when none is there, or the one there is an older release's.
      const home = join(vmHome(), "bin", "berth-vmm");
      const found = locateVmm(process.env);
      const decision = found && found !== home ? { replace: false, reason: `using ${found}` } : staleInstalledVmm(home, published, flags.force);
      if (!decision.replace) {
        if (!found && !published) {
          this.log(`! no berth-vmm found, and none is published for ${process.platform}-${process.arch} in this CLI version; build it (packages/vmm: cargo build --release) and pass --vmm`);
        } else if (found === home) {
          this.log(`  berth-vmm in ${home}: ${decision.reason}`);
        }
      } else if (published) {
        if (found) this.log(`  berth-vmm in ${home}: ${decision.reason}; replacing it`);
        try {
          const [r] = await installArtifacts({ ...(from ? { from: resolve(from) } : {}), ...(urlTemplate ? { urlTemplate } : {}), force: true, pins: [published], release: releasePair(PINS), log: (m) => this.log(m) });
          this.log(`✔ berth-vmm ${r!.sha256.slice(0, 16)}… verified (${r!.source === "copied" ? `copied from ${r!.from}` : `downloaded from ${r!.from}`}, ${r!.ms} ms)`);
          this.log(`    ${r!.path}`);
        } catch (err) {
          this.error(err instanceof Error ? err.message : String(err));
        }
      }
    }
    // Linux: the libkrun the published berth-vmm was built against, beside it
    // (its RUNPATH is $ORIGIN), with the soname link the loader looks for.
    const libkrun = libkrunPin();
    const home = join(vmHome(), "bin", "berth-vmm");
    if (libkrun && published && !flags.vmm && existsSync(home) && (await sha256File(home)) === published.sha256) {
      try {
        const [r] = await installArtifacts({ ...(from ? { from: resolve(from) } : {}), ...(urlTemplate ? { urlTemplate } : {}), force: flags.force, pins: [libkrun], release: releasePair(PINS), log: (m) => this.log(m) });
        const link = join(vmHome(), "bin", "libkrun.so.1");
        let current: string | undefined;
        try {
          current = readlinkSync(link);
        } catch {}
        if (current !== libkrun.file) {
          rmSync(link, { force: true });
          symlinkSync(libkrun.file, link);
        }
        this.log(`✔ libkrun ${r!.sha256.slice(0, 16)}… verified (${r!.source === "installed" ? "already installed" : r!.source === "copied" ? `copied from ${r!.from}` : `downloaded from ${r!.from}`}, ${r!.ms} ms)`);
        this.log(`    ${r!.path} (and ${link})`);
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }
    }
    // The kernel and rootfs berth-vmm was built to boot; it refuses any other.
    const pins = activePins(locateVmm(process.env, config.vm?.vmm));
    let results;
    try {
      results = await installArtifacts({ ...(from ? { from: resolve(from) } : {}), ...(urlTemplate ? { urlTemplate } : {}), force: flags.force, pins, log: (m) => this.log(m) });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }
    for (const r of results) {
      const how = r.source === "installed" ? "already installed" : r.source === "copied" ? `copied from ${r.from}` : `downloaded from ${r.from}`;
      this.log(`✔ ${r.kind} ${r.sha256.slice(0, 16)}… verified (${how}, ${r.ms} ms)`);
      this.log(`    ${r.path}`);
    }

    if (flags.layer?.length) {
      const vmm = locateVmm(process.env, config.vm?.vmm);
      if (!vmm) this.error("--layer needs a berth-vmm, which carries the layer pins");
      try {
        await ensureLayers(flags.layer, vmm, (m) => this.log(m), "--layer");
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }
      for (const l of flags.layer) this.log(`✔ layer ${l} verified`);
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
