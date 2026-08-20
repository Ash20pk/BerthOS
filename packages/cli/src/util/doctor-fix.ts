import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One executable step of a `berth doctor --fix` plan. `argv[0]` is the
 * binary; the CLI runs steps with stdio inherited so the user watches the
 * same output the underlying tool prints.
 */
export interface FixStep {
  title: string;
  argv: string[];
}

export interface MacFixFacts {
  platform: NodeJS.Platform;
  /** `colima` resolves on PATH. */
  colimaInstalled: boolean;
  /** `brew` resolves on PATH — the only installer this plan knows. */
  brewInstalled: boolean;
  /** `colima status --profile <p>` exited 0 (the VM is already running). */
  vmRunning: boolean;
  profile?: string;
  cpu?: string;
  memory?: string;
  disk?: string;
}

export interface MacFixPlan {
  steps: FixStep[];
  /** Where the enforcing daemon's socket will live once the plan has run. */
  dockerHost: string;
  /** The line the user must put in their shell — a child process cannot. */
  exportLine: string;
}

/**
 * The programmatic form of scripts/mac-enforcement.sh (which stays as the
 * documented, standalone recipe): decide the exact commands that take this
 * Mac from "Docker Desktop, no Landlock" to "Colima guest whose kernel
 * enforces". Pure — computes the plan from facts, executes nothing — so the
 * --fix branch is unit-testable on any machine.
 */
export function planMacEnforcementFix(facts: MacFixFacts): MacFixPlan {
  if (facts.platform !== "darwin") {
    throw new Error(
      "`berth doctor --fix` only knows how to fix macOS hosts (by provisioning a Colima VM). " +
        "On Linux, enforcement depends on the running kernel's LSM stack — see docs/kernel-enforcement.md.",
    );
  }
  if (!facts.colimaInstalled && !facts.brewInstalled) {
    throw new Error(
      "colima is not installed and Homebrew was not found to install it. " +
        "Install Colima manually (https://github.com/abiosoft/colima), then re-run `berth doctor --fix`.",
    );
  }

  const profile = facts.profile ?? "default";
  const steps: FixStep[] = [];

  if (!facts.colimaInstalled) {
    steps.push({ title: "Install colima and the docker CLI (Homebrew)", argv: ["brew", "install", "colima", "docker"] });
  }
  if (!facts.vmRunning) {
    steps.push({
      title: `Start the Colima VM (profile: ${profile})`,
      argv: [
        "colima",
        "start",
        "--profile",
        profile,
        "--cpu",
        facts.cpu ?? "4",
        "--memory",
        facts.memory ?? "8",
        "--disk",
        facts.disk ?? "60",
        "--vm-type",
        "vz",
        "--mount-type",
        "virtiofs",
        // $HOME writable: Colima mounts it read-only by default and Berth
        // bind-mounts checkouts read-write — EROFS there reads like a
        // capability denial and is not one.
        "--mount",
        `${homedir()}:w`,
      ],
    });
  }

  const sock = join(homedir(), ".colima", profile, "docker.sock");
  const dockerHost = `unix://${sock}`;
  return {
    steps,
    dockerHost,
    exportLine: `export DOCKER_HOST="${dockerHost}"`,
  };
}
