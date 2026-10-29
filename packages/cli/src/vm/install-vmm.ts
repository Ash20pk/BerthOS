import { existsSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { installArtifacts, releasePair, sha256File } from "./artifacts.js";
import { locateVmm, staleInstalledVmm } from "./host.js";
import { vmHome } from "./paths.js";
import { PINS, libkrunNames, libkrunPin, vmmPin } from "./pins.js";

export interface InstallVmmOptions {
  /** A directory to copy from before downloading (--from, BERTH_VMM_ARTIFACTS). */
  from?: string;
  /** The download URL template; undefined means copy only. */
  urlTemplate?: string;
  /** Replace an installed berth-vmm or libkrun even when it verifies. */
  force?: boolean;
  /** Skip berth-vmm itself (BERTH_VMM, vm.vmm or --vmm chose one); libkrun is still checked. */
  vmmChosen?: boolean;
  /** Skip libkrun too: --vmm copied a binary, and its libkrun with it. */
  skipLibkrun?: boolean;
  log: (message: string) => void;
}

/**
 * Puts the published berth-vmm for this platform in ~/.berth/vm/bin, when none
 * is found or the one there is an older release's, and the libkrun it loads
 * beside it. Shared by `berth vm install` and the first boot of a sandbox, so
 * that `berth dev` on a fresh machine needs no separate install step. Throws
 * on a failed download or a file that doesn't match its pin.
 */
export async function installPublishedVmm(options: InstallVmmOptions): Promise<void> {
  const { log } = options;
  const from = options.from ? { from: resolve(options.from) } : {};
  const url = options.urlTemplate ? { urlTemplate: options.urlTemplate } : {};
  const published = vmmPin();
  const home = join(vmHome(), "bin", "berth-vmm");

  if (!options.vmmChosen) {
    const found = locateVmm(process.env);
    const decision = found && found !== home ? { replace: false, reason: `using ${found}` } : staleInstalledVmm(home, published, options.force ?? false);
    if (!decision.replace) {
      if (!found && !published) {
        log(`! no berth-vmm found, and none is published for ${process.platform}-${process.arch} in this CLI version; build it (packages/vmm: cargo build --release) and pass --vmm`);
      } else if (found === home) {
        log(`  berth-vmm in ${home}: ${decision.reason}`);
      }
    } else if (published) {
      if (found) log(`  berth-vmm in ${home}: ${decision.reason}; replacing it`);
      const [r] = await installArtifacts({ ...from, ...url, force: true, pins: [published], release: releasePair(PINS), log });
      log(`✔ berth-vmm ${r!.sha256.slice(0, 16)}… verified (${r!.source === "copied" ? `copied from ${r!.from}` : `downloaded from ${r!.from}`}, ${r!.ms} ms)`);
      log(`    ${r!.path}`);
    }
  }

  const libkrun = libkrunPin();
  if (libkrun && published && !options.skipLibkrun && existsSync(home) && (await sha256File(home)) === published.sha256) {
    const [r] = await installArtifacts({ ...from, ...url, force: options.force ?? false, pins: [libkrun], release: releasePair(PINS), log });
    const link = join(vmHome(), "bin", libkrunNames().link);
    let current: string | undefined;
    try {
      current = readlinkSync(link);
    } catch {}
    if (current !== libkrun.file) {
      rmSync(link, { force: true });
      symlinkSync(libkrun.file, link);
    }
    log(`✔ libkrun ${r!.sha256.slice(0, 16)}… verified (${r!.source === "installed" ? "already installed" : r!.source === "copied" ? `copied from ${r!.from}` : `downloaded from ${r!.from}`}, ${r!.ms} ms)`);
    log(`    ${r!.path} (and ${link})`);
  }
}
