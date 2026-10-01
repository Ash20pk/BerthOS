import { checkArtifacts } from "./artifacts.js";
import { readConfigFile } from "./config.js";
import { activePins, checkHost, vmmFeatures, type HostCheck } from "./host.js";
import { vmHome } from "./paths.js";

/**
 * `berth doctor`'s microVM section: can this host boot the local VM runtime?
 * Hypervisor, berth-vmm (entitlement, pins), libkrun, and the pinned
 * artifacts, each hashed. Part of the `--json` contract as `vm`.
 */
export interface VmDoctorReport {
  /** Every check passed: `berth dev --runtime vm` can boot here. */
  ready: boolean;
  checks: HostCheck[];
  /** The berth-vmm the checks ran against. */
  vmm?: string;
  /** What that berth-vmm can do beyond a base boot. */
  features?: { egress: boolean };
}

export async function vmDoctor(): Promise<VmDoctorReport> {
  const config = readConfigFile();
  const host = checkHost(config.vm?.vmm ? { configuredVmm: config.vm.vmm } : {});
  const checks = [...host.checks];
  const vmm = host.checks.find((c) => c.id === "berth-vmm")?.status === "ok" ? host.vmm : undefined;
  const states = await checkArtifacts(vmHome(), activePins(vmm));
  const bad = states.filter((s) => s.status !== "verified");
  checks.push({
    id: "artifacts",
    title: "Pinned kernel and rootfs in ~/.berth/vm",
    status: bad.length === 0 ? "ok" : "fail",
    detail:
      bad.length === 0
        ? states.map((s) => `${s.kind} ${s.status === "verified" ? s.sha256.slice(0, 12) : ""}… verified`).join(", ")
        : bad.map((s) => (s.status === "missing" ? `${s.kind} missing (${s.path})` : `${s.kind} at ${s.path} has sha256 ${s.status === "mismatch" ? s.sha256.slice(0, 12) : "?"}…, not the pin`)).join("; "),
    ...(bad.length === 0 ? {} : { remedy: "berth vm install --from <a packages/vmm artifacts directory> (or set BERTH_VM_ARTIFACTS_URL to download)" }),
  });
  return {
    ready: checks.every((c) => c.status !== "fail"),
    checks,
    ...(vmm ? { vmm, features: vmmFeatures(vmm) } : {}),
  };
}
