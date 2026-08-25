import { spawnSync } from "node:child_process";
import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { runDoctor, type CheckStatus, type DoctorReport } from "@berth/docker-orchestrator";
import { planMacEnforcementFix, type MacFixFacts } from "../util/doctor-fix.js";

const GLYPH: Record<CheckStatus, string> = { ok: "✔", warn: "!", fail: "✘", unknown: "?" };

export default class Doctor extends Command {
  static override description =
    "Check whether this host can actually enforce Berth's capability boundaries, and say so plainly";
  static override examples = [
    "<%= config.bin %> doctor",
    "<%= config.bin %> doctor --json",
    "<%= config.bin %> doctor --image berth/filesystem:dev",
    "<%= config.bin %> doctor --no-probe",
    "<%= config.bin %> doctor --fix",
  ];
  static override flags = {
    json: Flags.boolean({
      description: "emit the report as JSON — see docs/doctor-reference.md for the schema",
      default: false,
    }),
    image: Flags.string({
      description: "image to run the kernel probe in (defaults to a local berth/* image)",
    }),
    "no-probe": Flags.boolean({
      description: "skip the container probe; kernel checks report `unknown` rather than being guessed at",
      default: false,
    }),
    fix: Flags.boolean({
      description:
        "on macOS, provision the enforcing host doctor knows how to verify (a Colima VM per docs/mac-enforcement.md) and re-check against it",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const report = await runDoctor({ image: flags.image, skipProbe: flags["no-probe"] });

    if (flags.json) {
      // Only the JSON, so `berth doctor --json | jq` works without a filter.
      this.log(JSON.stringify(report, null, 2));
    } else {
      this.printHuman(report);
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
  private async fixMac(flags: { image?: string; "no-probe": boolean }): Promise<boolean> {
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
    });
    this.log("");
    this.log(`Re-checked against ${plan.dockerHost}:`);
    this.printHuman(recheck);
    if (!recheck.enforcementActive) return false;

    this.log("");
    this.log("One thing --fix cannot do: export into your shell. Put this in every");
    this.log("shell where you run Berth, or it will talk to Docker Desktop again:");
    this.log("");
    this.log(`  ${plan.exportLine}`);
    return true;
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
