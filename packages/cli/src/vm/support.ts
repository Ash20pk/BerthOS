import type { BerthManifest } from "@berthos/manifest-schema";

/**
 * What an app may need that the microVM doesn't provide yet (berth-init
 * covers only part of entrypoint.sh; docs/local-vm.md, "Limits"). An app that
 * needs any of it is refused before boot with the reason, rather than booted
 * into a sandbox where the first call that needs it fails.
 *
 * Update this list as the guest gains each part (the egress broker is on
 * feat/vm-egress).
 */
export function vmUnsupported(manifest: BerthManifest): string[] {
  const reasons: string[] = [];
  const m = manifest as BerthManifest & { runtime?: string; secrets?: string[] };
  if (m.runtime === "python") reasons.push("runtime: python (the VM image has no python3 or berthos-sdk yet)");
  if (m.secrets && m.secrets.length > 0) reasons.push(`secrets: ${m.secrets.join(", ")} (the VM has no secrets channel yet; the guest environment is on the kernel command line, which is world-readable)`);
  for (const cap of manifest.capabilities) {
    const [ns, action, ...rest] = cap.split(":");
    const scope = rest.join(":");
    if (ns === "network") reasons.push(`${cap} (no network in the VM yet: no NIC, TSI off, and the egress broker isn't there)`);
    else if (ns === "browser") reasons.push(`${cap} (no browser or display in the VM image)`);
    else if (ns === "terminal") reasons.push(`${cap} (no terminal service in the VM)`);
    else if (ns === "filesystem" && (scope === "/context" || scope.startsWith("/context/"))) reasons.push(`${cap} (no semantic-fs in the VM, so no /context)`);
    else if (ns !== "filesystem") reasons.push(`${cap} (a ${ns}:${action} capability is served through the egress broker or a host service, which the VM doesn't have yet)`);
  }
  return reasons;
}

export function vmUnsupportedMessage(name: string, reasons: string[]): string {
  return `"${name}" needs what the microVM runtime doesn't have yet:\n  - ${reasons.join("\n  - ")}\nRun it with --runtime docker (the default), or see docs/local-vm.md for what the VM covers.`;
}
