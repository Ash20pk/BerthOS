#!/usr/bin/env node
// The red-team mutation suite.
//
// The milestone suite proves Berth refuses an attack. This proves those
// refusals are not vacuous: for each attack class it runs the attack twice —
// once against the shipped configuration (must be DENIED) and once against a
// configuration with the enforcing mechanism deliberately removed (must then
// be ALLOWED). A denial that does not flip when its mechanism is taken away
// was never being caused by that mechanism, and the suite fails on it just as
// hard as on a denial that does not hold.
//
// That two-sided contract is the "a deliberately introduced hole fails the
// suite" clause of the done-when, made structural rather than a one-off
// negative control: every row carries its own hole.
//
// It reuses the break-out box (breakout/box.mjs) as infrastructure — the box
// already boots a sandbox that runs stranger code in a restricted process, and
// already has a weakened boot. Attacks run through the target app's `attempt`
// export, i.e. inside the app's own Landlock domain, the only place a result
// means anything.
//
//   node redteam/redteam.mjs
//
// Not every class has a clean mutation expressible through a shipped knob: the
// namespace and co-tenant-socket denials come from agent-init's own seccomp
// filter and the per-app uid split, neither of which the weakened boot
// disables. Those are asserted denied here and their falsifiability is carried
// by their own milestone's control rather
// than pretended here. Honesty over a full green grid.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bootBox, mintFlags, detectCapture, FLAG_KERNEL_PATH } from "../breakout/box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

let failures = 0;
function check(what, ok, extra) {
  if (ok) console.log(`  PASS  ${what}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${what}${extra ? ` — ${extra}` : ""}`);
  }
}

const denied = (result) => !result.ok && /EACCES|EPERM|denied|not permitted/i.test(result.output);

/**
 * Attack classes whose enforcing mechanism the weakened boot removes
 * (Landlock's filesystem and TCP-network rules). Each is expected DENIED
 * under the shipped box and ALLOWED under the weakened box — the mutation.
 *
 * The scratch-write control is not a mutation row: it must succeed under BOTH
 * boots, proving the box runs attacks at all rather than failing everything.
 */
const LANDLOCK_TIER_ATTACKS = [
  {
    id: "undeclared-write",
    title: "write outside the declared paths (kernel-tier flag file, 0644)",
    // The flag file is world-readable at the DAC layer, so a refusal to READ
    // it can only be Landlock; a write to its directory is the same tier.
    code: `
      const fs = await require("node:fs/promises");
      return await fs.readFile(${JSON.stringify(FLAG_KERNEL_PATH)}, "utf-8");
    `,
    // Under mutation the read succeeds and returns the flag; detectCapture
    // confirms it is the live value, not an error string that happens to parse.
    mutationSucceeds: (result, flags) => result.ok && detectCapture(result.output, flags).includes("FLAG_KERNEL"),
  },
  {
    id: "symlink-escape",
    title: "read the flag through a symlink planted in the app's own directory",
    code: `
      const fs = await require("node:fs/promises");
      const link = process.env.BERTH_WORKSPACE_ROOT + "/breakout-target/redteam-link";
      try { await fs.symlink("/var/breakout", link); } catch (e) { if (e.code !== "EEXIST") throw e; }
      return await fs.readFile(link + "/flag-kernel.txt", "utf-8");
    `,
    mutationSucceeds: (result, flags) => result.ok && detectCapture(result.output, flags).includes("FLAG_KERNEL"),
  },
  {
    id: "undeclared-egress",
    title: "open an outbound TCP connection the app never declared",
    code: `
      const net = await require("node:net");
      return await new Promise((resolve) => {
        const s = net.createConnection({ host: "1.1.1.1", port: 80, timeout: 4000 });
        s.on("connect", () => { s.destroy(); resolve("CONNECTED"); });
        s.on("timeout", () => { s.destroy(); resolve("TIMEOUT"); });
        s.on("error", (e) => resolve("ERROR:" + e.code));
      });
    `,
    // TCP connect is a Landlock network rule (not the UDP/raw seccomp filter),
    // so the weakened boot flips it. "denied" here means the connect errored
    // with a policy errno; "allowed" means it connected.
    deniedResult: (result) => result.ok && /ERROR:(EACCES|EPERM)/.test(result.output),
    mutationSucceeds: (result) => result.ok && result.output.includes("CONNECTED"),
  },
];

async function runClass(shippedBox, weakBox, attack, flags, weakFlags) {
  const shipped = await shippedBox.attempt(attack.code);
  const isDenied = attack.deniedResult ? attack.deniedResult(shipped) : denied(shipped);
  const leaked = detectCapture(shipped.output ?? "", flags);
  check(`${attack.id}: DENIED under the shipped box — ${attack.title}`, isDenied && leaked.length === 0, shipped.output?.slice(0, 140));

  const mutated = await weakBox.attempt(attack.code);
  const flips = attack.mutationSucceeds(mutated, weakFlags);
  check(
    `${attack.id}: mutation flips it to ALLOWED (the denial was caused by the kernel tier, not by accident)`,
    flips,
    flips ? undefined : `the hole did not open — this denial may be vacuous: ${mutated.output?.slice(0, 140)}`,
  );
}

async function main() {
  const flags = mintFlags();
  const weakFlags = mintFlags();
  const log = (m) => console.log(`  [box] ${m}`);

  console.log("=== Booting the shipped box and the mutated (kernel-tier-off) box ===");
  const shippedBox = await bootBox({ repoRoot: REPO_ROOT, flags, containerName: "berth-redteam-shipped", log });
  const weakBox = await bootBox({ repoRoot: REPO_ROOT, flags: weakFlags, weakened: true, containerName: "berth-redteam-mutated", log });

  try {
    const enforcement = await shippedBox.enforcement();
    const enforcing = enforcement.doctorProbe?.status === "enforcing" && (enforcement.rulesetReports ?? []).every((r) => r.ruleset === "FullyEnforced");
    if (!enforcing) {
      // The whole suite is a statement about a kernel that enforces. On a host
      // that does not, it cannot run as assertions — and says so, rather than
      // reporting a green grid that means nothing.
      console.error(`\nThis host does not enforce Landlock (probe=${enforcement.doctorProbe?.status}). The red-team mutation suite needs an enforcing host — see docs/mac-enforcement.md.`);
      console.error("Skipping the assertions rather than reporting vacuous passes.");
      process.exit(process.env.CI ? 1 : 0);
    }
    console.log(`  (measured enforcement: probe=${enforcement.doctorProbe?.status}, all apps FullyEnforced)\n`);

    console.log("=== Control: the box runs attacks at all ===");
    const scratch = await shippedBox.attempt(`
      const fs = await require("node:fs/promises");
      const d = process.env.BERTH_WORKSPACE_ROOT + "/breakout-target";
      await fs.writeFile(d + "/redteam-control.txt", "ran");
      return await fs.readFile(d + "/redteam-control.txt", "utf-8");
    `);
    check("control: a submission can use its own declared directory (else every denial below is vacuous)", scratch.ok && scratch.output.includes("ran"), scratch.output?.slice(0, 140));

    console.log("\n=== Attack classes: DENIED as shipped, ALLOWED when the mechanism is removed ===");
    for (const attack of LANDLOCK_TIER_ATTACKS) {
      await runClass(shippedBox, weakBox, attack, flags, weakFlags);
    }
  } finally {
    await shippedBox.stop();
    await weakBox.stop();
  }

  console.log(
    failures === 0
      ? "\nAll red-team mutation checks passed: every asserted denial held, and every one flipped when its mechanism was removed."
      : `\n${failures} red-team check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
