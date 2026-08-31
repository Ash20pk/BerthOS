#!/usr/bin/env node
// Real, running verification of gap #19's closure ("sandboxed code-exec as a
// first-class agent primitive"): apps/code-interpreter's run_code export
// actually executes Python/JavaScript/shell as real subprocesses inside a
// booted Berth OS, AND a booted agent's default of declaring no
// network:connect capability really blocks that code from reaching the
// network at the kernel level — the concrete difference between this and a
// bolted-on Docker/E2B executor, which typically has full outbound network
// access unless the wrapping platform specifically restricts it.
//
// Computer.boot() always builds a production-target image
// (BERTH_REQUIRE_ENFORCEMENT=1) — same as computer-boot-milestone.mjs and
// computer-http-rpc-milestone.mjs, this only boots successfully on a kernel
// that can actually enforce Landlock (CI's ubuntu-latest). On Docker Desktop
// for Mac/Windows, agent-init refuses to exec at all under an unenforced
// ruleset rather than silently running unrestricted, so Computer.boot()
// itself never completes there — this test is CI-verified only, not locally
// runnable on this class of dev machine.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CODE_INTERPRETER_APP_DIR = join(REPO_ROOT, "apps", "code-interpreter");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("Booting a Computer with apps/code-interpreter...");
  const computer = await Computer.boot({ apps: [CODE_INTERPRETER_APP_DIR] });

  try {
    const toolNames = computer.tools.map((t) => t.name).sort();
    console.log("tools:", toolNames);
    assert(toolNames.includes("run_code"), `expected an unnamespaced "run_code" tool, got: ${JSON.stringify(toolNames)}`);

    console.log("\nCalling run_code (python)...");
    const py = await computer.call("run_code", { language: "python", code: "print(1 + 1)" });
    console.log("python result:", py);
    assert(py.stdout.trim() === "2", `expected python stdout "2", got: ${JSON.stringify(py)}`);
    assert(py.exit_code === 0, `expected exit_code 0, got: ${JSON.stringify(py)}`);

    console.log("\nCalling run_code (javascript)...");
    const js = await computer.call("run_code", { language: "javascript", code: "console.log(2 + 2)" });
    console.log("javascript result:", js);
    assert(js.stdout.trim() === "4", `expected javascript stdout "4", got: ${JSON.stringify(js)}`);

    console.log("\nCalling run_code (shell)...");
    const sh = await computer.call("run_code", { language: "shell", code: "echo $((3 + 3))" });
    console.log("shell result:", sh);
    assert(sh.stdout.trim() === "6", `expected shell stdout "6", got: ${JSON.stringify(sh)}`);

    console.log("\nCalling run_code with a real timeout (python sleeping past a 500ms budget)...");
    const timedOut = await computer.call("run_code", {
      language: "python",
      code: "import time; time.sleep(5)",
      timeout_ms: 500,
    });
    console.log("timeout result:", timedOut);
    assert(timedOut.timed_out === true, `expected timed_out: true, got: ${JSON.stringify(timedOut)}`);

    console.log(
      "\nCalling run_code with an outbound network probe — apps/code-interpreter declares no network:connect " +
        "capability, so this should be refused at the kernel level, not just by an application-level check...",
    );
    const netProbe = await computer.call("run_code", {
      language: "python",
      code: [
        "import socket",
        "try:",
        "    socket.create_connection(('1.1.1.1', 80), timeout=3)",
        "    print('CONNECTED')",
        "except OSError as e:",
        "    print('BLOCKED:', e)",
      ].join("\n"),
    });
    console.log("network probe result:", netProbe);
    assert(
      netProbe.stdout.includes("BLOCKED"),
      `Landlock is active in this environment (this test only completes boot with real enforcement) but an undeclared outbound connection was not refused — deny-by-default regression: ${JSON.stringify(netProbe)}`,
    );

    console.log(
      "\nPASS — run_code executed real Python/JavaScript/shell subprocesses inside the sandbox, enforced a real " +
        "timeout, and a kernel-enforced policy (not an application-level check) blocked an undeclared outbound connection.",
    );
  } finally {
    await computer.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCODE INTERPRETER MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
