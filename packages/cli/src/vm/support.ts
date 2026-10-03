import type { BerthManifest } from "@berthos/manifest-schema";

/**
 * What an app may need that the microVM doesn't provide yet (berth-init
 * covers only part of entrypoint.sh; docs/local-vm.md, "Limits"). An app that
 * needs any of it is refused before boot with the reason, rather than booted
 * into a sandbox where the first call that needs it fails.
 *
 * Update this list as the guest gains each part (the egress broker is on
 * feat/vm-egress, the secrets disk on feat/vm-secrets, python3 on feat/vm-python,
 * semantic-fs on feat/vm-semantic-fs-init).
 */
export interface VmFeatures {
  /** berth-vmm has the host egress dialer (`run --egress-allow`, feat/vm-egress). */
  egress: boolean;
  /**
   * berth-vmm takes a secrets disk (`run --secrets`, feat/vm-secrets), and
   * its pinned rootfs has the berth-init that reads it.
   */
  secrets: boolean;
  /** berth-vmm's pinned rootfs has python3 and berth_sdk (feat/vm-python). */
  python: boolean;
  /**
   * berth-vmm's pinned rootfs has semantic-fs-daemon, which berth-init starts
   * to serve /context (feat/vm-semantic-fs-init).
   */
  semanticFs: boolean;
}

const NO_FEATURES: VmFeatures = { egress: false, secrets: false, python: false, semanticFs: false };

export function vmUnsupported(manifest: BerthManifest, features: VmFeatures = NO_FEATURES): string[] {
  const reasons: string[] = [];
  const m = manifest as BerthManifest & { runtime?: string; secrets?: string[] };
  if (m.runtime === "python" && !features.python) reasons.push("runtime: python (this berth-vmm's image has no python3 or berth_sdk; update it with `berth vm install`)");
  if (m.secrets && m.secrets.length > 0 && !features.secrets) {
    reasons.push(`secrets: ${m.secrets.join(", ")} (this berth-vmm has no secrets disk, and the guest environment is on the kernel command line, which is world-readable; update berth-vmm with \`berth vm install\`)`);
  }
  for (const cap of manifest.capabilities) {
    const [ns, action, ...rest] = cap.split(":");
    const scope = rest.join(":");
    if (ns === "network" && features.egress && (action === "host" || action === "connect")) continue;
    if (ns === "network") {
      reasons.push(
        features.egress
          ? `${cap} (the VM's egress covers network:host and network:connect only)`
          : `${cap} (this berth-vmm has no egress dialer: no NIC, TSI off; egress needs a berth-vmm with --egress-allow)`,
      );
    }
    else if (ns === "browser") reasons.push(`${cap} (no browser or display in the VM image)`);
    else if (ns === "terminal") reasons.push(`${cap} (no terminal service in the VM)`);
    else if (ns === "filesystem" && (scope === "/context" || scope.startsWith("/context/")) && !features.semanticFs) {
      reasons.push(`${cap} (this berth-vmm's image has no semantic-fs, so no /context; update it with \`berth vm install\`)`);
    }
    else if (ns !== "filesystem") reasons.push(`${cap} (a ${ns}:${action} capability is served through the egress broker or a host service, which the VM doesn't have yet)`);
  }
  return reasons;
}

export function vmUnsupportedMessage(name: string, reasons: string[]): string {
  return `"${name}" needs what the microVM runtime doesn't have yet:\n  - ${reasons.join("\n  - ")}\nRun it with --runtime docker (the default), or see docs/local-vm.md for what the VM covers.`;
}

/**
 * The egress allowlist berth-vmm's host dialer enforces (`--egress-allow`):
 * every `network:host:` and `browser:navigate:` scope the sandbox's apps
 * declare, verbatim. Computed here because berth-vmm never reads manifests.
 */
export function egressAllowList(manifests: BerthManifest[]): string[] {
  const out: string[] = [];
  for (const m of manifests) {
    for (const cap of m.capabilities) {
      const [ns, action, ...rest] = cap.split(":");
      const scope = rest.join(":");
      if (((ns === "network" && action === "host") || (ns === "browser" && action === "navigate")) && scope && !out.includes(scope)) out.push(scope);
    }
  }
  return out;
}
