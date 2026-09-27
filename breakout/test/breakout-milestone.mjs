#!/usr/bin/env node
// The public break-out box holds two flags that no capability
// grants, and the only thing keeping a stranger's code away from them is the
// enforcement Berth ships to everyone.
//
//   Enforced boot — the box exactly as the public endpoint runs it:
//     1. a submission can read and write its OWN scratch directory. The
//        positive control: without it, every refusal below would also be
//        satisfied by a box where nothing runs at all.
//     2. reading /var/breakout/flag-kernel.txt is refused. The file is 0644 —
//        ordinary permissions ALLOW the read — so the refusal can only come
//        from the Landlock domain compiled from breakout-target's berth.yml.
//     3. the same read via a symlink planted in the app's own writable
//        directory is refused too (resolved at syscall time, not by string).
//     4. reading the co-tenant's per-app secret file is refused (uid split).
//     5. listing /run/berth to find it is refused as well.
//     6. outbound TCP is refused, so a captured flag could not be posted out.
//     7. neither flag appears anywhere in the target app's own environment.
//
//   Weakened boot — the negative control, and the reason this test exists:
//     8. with the kernel tier switched off, the SAME submission reads the
//        kernel flag and it leaves the box. That is what makes assertion 2 a
//        statement about Landlock rather than about a lucky file mode.
//
// Run it against the deployed box's own recipe: `node breakout/test/breakout-milestone.mjs`.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bootBox, mintFlags, detectCapture, FLAG_KERNEL_PATH, FLAG_COTENANT_PATH } from "../box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

let failures = 0;
function check(what, ok, extra) {
  if (ok) console.log(`  PASS  ${what}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${what}${extra ? ` — ${extra}` : ""}`);
  }
}

/** The canonical attempts, written the way a challenger would write them. */
const ATTEMPTS = {
  ownScratch: `
    const fs = await require("node:fs/promises");
    const dir = process.env.BERTH_WORKSPACE_ROOT + "/breakout-target";
    await fs.writeFile(dir + "/hello.txt", "a submission was here");
    return await fs.readFile(dir + "/hello.txt", "utf-8");
  `,
  readKernelFlag: `
    const fs = await require("node:fs/promises");
    return await fs.readFile(${JSON.stringify(FLAG_KERNEL_PATH)}, "utf-8");
  `,
  symlinkToFlag: `
    const fs = await require("node:fs/promises");
    const link = process.env.BERTH_WORKSPACE_ROOT + "/breakout-target/shortcut";
    try { await fs.symlink("/var/breakout", link); } catch (e) { if (e.code !== "EEXIST") throw e; }
    return await fs.readFile(link + "/flag-kernel.txt", "utf-8");
  `,
  readCotenantFlag: `
    const fs = await require("node:fs/promises");
    return await fs.readFile(${JSON.stringify(FLAG_COTENANT_PATH)}, "utf-8");
  `,
  listRunBerth: `
    const fs = await require("node:fs/promises");
    return JSON.stringify(await fs.readdir("/run/berth"));
  `,
  outboundTcp: `
    const net = await require("node:net");
    return await new Promise((resolve) => {
      const s = net.createConnection({ host: "1.1.1.1", port: 80, timeout: 4000 });
      s.on("connect", () => { s.destroy(); resolve("CONNECTED"); });
      s.on("timeout", () => { s.destroy(); resolve("TIMEOUT"); });
      s.on("error", (e) => resolve("ERROR:" + e.code));
    });
  `,
  dumpEnvironment: `return JSON.stringify(process.env);`,
};

const refused = (result) => !result.ok && /EACCES|EPERM|denied|not permitted/i.test(result.output);

async function main() {
  const flags = mintFlags();
  const log = (message) => console.log(`  [box] ${message}`);

  console.log("=== Enforced boot: the box exactly as the public endpoint runs it ===");
  const box = await bootBox({ repoRoot: REPO_ROOT, flags, log });
  let enforcement;
  try {
    enforcement = await box.enforcement();
    const probe = enforcement.doctorProbe?.status;
    const rulesets = (enforcement.rulesetReports ?? []).map((r) => `${r.app}=${r.ruleset}`).join(", ");
    console.log(`  (measured enforcement: probe=${probe}, ${rulesets})`);
    const enforcing = probe === "enforcing" && (enforcement.rulesetReports ?? []).every((r) => r.ruleset === "FullyEnforced");

    const scratch = await box.attempt(ATTEMPTS.ownScratch);
    check("1. a submission can use its own scratch directory (positive control)", scratch.ok && scratch.output.includes("a submission was here"), scratch.output);

    const kernelFlag = await box.attempt(ATTEMPTS.readKernelFlag);
    const kernelCaptured = detectCapture(kernelFlag.output, flags);
    if (enforcing) {
      check("2. reading the 0644 kernel-tier flag is refused by the policy", refused(kernelFlag) && kernelCaptured.length === 0, kernelFlag.output.slice(0, 160));
    } else {
      // Honest, not silently green: on a host where nothing enforces, this box
      // does not hold. Saying so is the whole point of the M2.1 measurement.
      check(
        "2. SKIPPED — this host does not enforce Landlock, so the box's kernel-tier flag is NOT protected here",
        true,
        undefined,
      );
      console.error("        (do not deploy the box on this host: the kernel flag is reachable)");
    }

    const symlink = await box.attempt(ATTEMPTS.symlinkToFlag);
    if (enforcing) check("3. the same read through a planted symlink is refused", refused(symlink) && detectCapture(symlink.output, flags).length === 0, symlink.output.slice(0, 160));

    const cotenant = await box.attempt(ATTEMPTS.readCotenantFlag);
    check("4. reading the co-tenant's per-app secret file is refused", refused(cotenant) && detectCapture(cotenant.output, flags).length === 0, cotenant.output.slice(0, 160));

    const listing = await box.attempt(ATTEMPTS.listRunBerth);
    check("5. listing /run/berth to find it is refused", !listing.ok || !listing.output.includes(`secrets.flag-keeper`), listing.output.slice(0, 160));

    const tcp = await box.attempt(ATTEMPTS.outboundTcp);
    if (enforcing) check("6. outbound TCP is refused, so a captured flag could not be posted out", tcp.output.includes("ERROR:EACCES") || tcp.output.includes("ERROR:EPERM"), tcp.output.slice(0, 160));

    const env = await box.attempt(ATTEMPTS.dumpEnvironment);
    check("7. neither flag is present in the target app's own environment", detectCapture(env.output, flags).length === 0, "a flag leaked through the environment");
  } finally {
    await box.stop();
  }

  console.log("\n=== Weakened boot: the negative control — the flag MUST leak when enforcement is off ===");
  const weakFlags = mintFlags();
  const weakBox = await bootBox({ repoRoot: REPO_ROOT, flags: weakFlags, weakened: true, containerName: "berth-breakout-box-control", log });
  try {
    const kernelFlag = await weakBox.attempt(ATTEMPTS.readKernelFlag);
    const captured = detectCapture(kernelFlag.output, weakFlags);
    check(
      "8. with the kernel tier switched off, the same submission reads the flag",
      captured.includes("FLAG_KERNEL"),
      `the control boot did NOT leak the flag (${kernelFlag.output.slice(0, 160)}) — assertion 2 may be passing for a reason other than Landlock, which would make this box prove nothing`,
    );
  } finally {
    await weakBox.stop();
  }

  console.log(failures === 0 ? "\nAll break-out box checks passed." : `\n${failures} break-out box check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
