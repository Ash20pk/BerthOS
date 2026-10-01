import { spawnSync } from "node:child_process";
import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { runDoctor, type CheckStatus, type DoctorReport } from "@berthos/docker-orchestrator";
import { planMacEnforcementFix, type MacFixFacts } from "../util/doctor-fix.js";
import { resolveSandbox } from "../vm/config.js";
import { vmDoctor, type VmDoctorReport } from "../vm/doctor.js";

const GLYPH: Record<CheckStatus, string> = { ok: "✔", warn: "!", fail: "✘", unknown: "?" };

export default class Doctor extends Command {
  static override description =
    "Check whether this host can actually enforce Berth's capability boundaries, and say so plainly";
  static override examples = [
    "<%= config.bin %> doctor",
    "<%= config.bin %> doctor --json",
    "<%= config.bin %> doctor --image berth/filesystem:dev-1a2b3c4d",
    "<%= config.bin %> doctor --no-probe",
    "<%= config.bin %> doctor --runtime runsc",
    "<%= config.bin %> doctor --fix",
    "<%= config.bin %> doctor --sandbox vm",
  ];
  static override flags = {
    json: Flags.boolean({
      description: "emit the report as JSON — see docs/doctor-reference.md for the schema",
      default: false,
    }),
    image: Flags.string({
      description: "image to run the kernel probe in (defaults to a local berth/* image)",
    }),
    runtime: Flags.string({
      description:
        "container runtime sandboxes would boot with, e.g. runsc for gVisor — verifies the daemon has it and runs the kernel probe under it (defaults to BERTH_RUNTIME)",
    }),
    "no-probe": Flags.boolean({
      description: "skip the container probe; kernel checks report `unknown` rather than being guessed at",
      default: false,
    }),
    sandbox: Flags.string({
      description:
        "which sandbox to check for: docker (the container checks, plus the microVM section for information) or vm (only the microVM runtime; Docker isn't contacted, and the exit code is the VM's). Defaults to BERTH_SANDBOX, then \"sandbox\" in ~/.berth/config.json",
      options: ["docker", "vm"],
    }),
    fix: Flags.boolean({
      description:
        "on macOS, provision the enforcing host doctor knows how to verify (a Colima VM per docs/mac-enforcement.md) and re-check against it",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    let sandbox;
    try {
      sandbox = resolveSandbox(flags.sandbox);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }

    if (sandbox === "vm") {
      const vm = await vmDoctor();
      if (flags.json) this.log(JSON.stringify({ schemaVersion: 1, sandbox: "vm", vm }, null, 2));
      else this.printVm(vm, true);
      if (!vm.ready) this.exit(1);
      return;
    }

    const report = await runDoctor({ image: flags.image, skipProbe: flags["no-probe"], runtime: flags.runtime });
    const vm = await vmDoctor().catch(() => undefined);

    if (flags.json) {
      // Only the JSON, so `berth doctor --json | jq` works without a filter.
      // `vm` is additive: consumers of the container checks can ignore it.
      this.log(JSON.stringify({ ...report, ...(vm ? { vm } : {}) }, null, 2));
    } else {
      this.printHuman(report);
      if (vm) this.printVm(vm, false);
    }

    if (flags.fix && !report.enforcementActive) {
      const fixed = await this.fixMac(flags);
      if (!fixed) this.exit(1);
      return;
    }

    // A non-zero exit for "cannot enforce" is what makes this usable in a
    // script or a CI gate. `unknown` deliberately also fails: a check that did
    // not run has not passed, and a preflight that exits 0 on "I couldn't tell"
    // is worse than no preflight, because it will be trusted.
    if (!report.enforcementActive) this.exit(1);
  }

  /**
   * The --fix branch: compute the Colima plan from observed facts, run it
   * with inherited stdio, then re-run the same checks against the new
   * daemon's socket — the fix has not happened until doctor itself says so.
   */
  private async fixMac(flags: { image?: string; "no-probe": boolean; runtime?: string }): Promise<boolean> {
    const profile = process.env.COLIMA_PROFILE ?? "default";
    const facts: MacFixFacts = {
      platform: process.platform,
      colimaInstalled: spawnSync("which", ["colima"]).status === 0,
      brewInstalled: spawnSync("which", ["brew"]).status === 0,
      vmRunning: spawnSync("colima", ["status", "--profile", profile]).status === 0,
      profile,
      cpu: process.env.BERTH_COLIMA_CPU,
      memory: process.env.BERTH_COLIMA_MEMORY,
      disk: process.env.BERTH_COLIMA_DISK,
    };

    let plan;
    try {
      plan = planMacEnforcementFix(facts);
    } catch (err) {
      this.log("");
      this.log(`--fix: ${(err as Error).message}`);
      return false;
    }

    this.log("");
    for (const step of plan.steps) {
      this.log(`--fix: ${step.title}`);
      const [bin, ...args] = step.argv as [string, ...string[]];
      const result = spawnSync(bin, args, { stdio: "inherit" });
      if (result.status !== 0) {
        this.log(`--fix: \`${step.argv.join(" ")}\` exited ${result.status ?? "by signal"} — stopping here.`);
        return false;
      }
    }
    if (plan.steps.length === 0) {
      this.log(`--fix: Colima is already installed and running (profile: ${profile}) — re-checking against it.`);
    }

    const socketPath = plan.dockerHost.replace("unix://", "");
    const recheck = await runDoctor({
      docker: new Docker({ socketPath }),
      image: flags.image,
      skipProbe: flags["no-probe"],
      runtime: flags.runtime,
    });
    this.log("");
    this.log(`Re-checked against ${plan.dockerHost}:`);
    this.printHuman(recheck);
    if (!recheck.enforcementActive) return false;

    this.log("");
    this.log("One thing --fix does not do for you: point Docker at Colima from now on.");
    this.log("Berth follows the current Docker context, as the docker CLI does, so either");
    this.log("select it once (for every shell, and for `docker` itself):");
    this.log("");
    this.log(`  docker context use ${plan.contextName}`);
    this.log("");
    this.log("or, per shell:");
    this.log("");
    this.log(`  ${plan.exportLine}`);
    return true;
  }

  private printVm(vm: VmDoctorReport, selected: boolean): void {
    this.log("");
    this.log(`microVM runtime (berth dev --runtime vm)${selected ? "" : ", for information; it doesn't change this exit code"}:`);
    for (const check of vm.checks) {
      this.log(`  ${GLYPH[check.status]} ${check.title}`);
      this.log(`      ${check.detail}`);
      if (check.remedy) this.log(`      → ${check.remedy}`);
    }
    if (vm.features) this.log(`  egress: ${vm.features.egress ? "this berth-vmm has the host egress dialer (--egress-allow)" : "this berth-vmm has no egress dialer; apps that declare network:* can't run in the VM"}`);
    this.log("");
    this.log(
      vm.ready
        ? "The microVM runtime can boot here: Berth's own pinned kernel (Landlock built in), so enforcement doesn't depend on this host's kernel."
        : "The microVM runtime can't boot here yet; fix the ✘ lines above.",
    );
  }

  private printHuman(report: DoctorReport): void {
    if (report.daemon) {
      // Named explicitly, because it is the single most misunderstood thing
      // here: on macOS and Windows this is a VM's kernel, not the laptop's, and
      // it is the only kernel whose Landlock support matters.
      this.log(`Kernel that runs Berth's apps: ${report.daemon.kernelVersion} (${report.daemon.operatingSystem})`);
      if (report.probeImage) this.log(`Probed in: ${report.probeImage}`);
      this.log("");
    }

    for (const check of report.checks) {
      this.log(`  ${GLYPH[check.status]} ${check.title}`);
      this.log(`      ${check.detail}`);
      if (check.remedy) this.log(`      → ${check.remedy}`);
    }

    this.log("");
    this.log(report.verdict);
    if (report.enforcementActive) return;

    this.log("");
    if (report.enforcementDetermined) {
      this.log("Berth still runs. What you lose is the part that makes it worth using:");
      this.log("capability declarations are recorded but not enforced by the kernel, so an");
      this.log("undeclared write or connection will succeed. Do not treat this host as a");
      this.log("security boundary, and do not benchmark enforcement claims on it.");
    } else {
      // Deliberately not the paragraph above: nothing was established here, and
      // telling someone their host is unenforced when it was never checked is
      // the same kind of false claim in the opposite direction.
      this.log("This is not a finding that enforcement is off — it is a failure to check.");
      this.log("Fix the reason above and run `berth doctor` again before relying on either");
      this.log("answer.");
    }
  }
}
