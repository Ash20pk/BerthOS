#!/usr/bin/env node
// Real, running verification that a Computer whose app dies during startup
// surfaces the container's own logs — not a populated tool list followed by
// an RPC timeout half a minute later with the real reason left in `docker
// logs` of a container nobody mentioned.
//
// Three cases, all against real Docker with no mocking:
//   1. An app that throws during module load. The failure must surface with
//      the app's actual log output, quickly, rather than as a bare RPC
//      timeout at the end of the 30s ready-retry ceiling.
//   2. The default enforcement posture on a kernel that doesn't enforce
//      Landlock. It must fail closed, naming agent-init's refusal — the same
//      code path, and the reason this milestone exists.
//   3. The same app in enforcement: "warn" must boot and serve a tool call,
//      which is what makes packages/agents runnable on macOS at all.
//
// Case 2 only asserts on a kernel where enforcement genuinely can't happen
// (Docker Desktop's linuxkit VM); on an enforcing Linux kernel that boot
// legitimately succeeds, so it's reported as skipped rather than failed.
// Case 3 must pass everywhere.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CRASH_APP_DIR = join(__dirname, "fixtures", "crash-on-boot");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Boots, then exercises one tool call, and reports what happened. Whether the
 * container has already exited by the time Docker reports it started is a
 * genuine race, so a failure is accepted from either boot() or the call —
 * what the assertions care about is the *content* and the *latency* of the
 * error, not which of the two produced it. Returns `undefined` when the whole
 * sequence succeeded.
 */
async function bootAndProbe({ appDir, tool, input, enforcement }) {
  const started = Date.now();
  let computer;
  let err;
  try {
    computer = await Computer.boot({ apps: [appDir], ...(enforcement ? { enforcement } : {}) });
    try {
      await computer.call(tool, input);
    } catch (callErr) {
      err = callErr;
    } finally {
      await computer.stop().catch(() => {});
    }
  } catch (bootErr) {
    err = bootErr;
  }
  return err ? { err, elapsedMs: Date.now() - started } : undefined;
}

/** Shared across both cases: the whole point is that neither reports a timeout. */
function assertNotABareTimeout(err) {
  assert(
    !/attempt timed out after \d+ms$/.test(err.message),
    `failed with a bare RPC timeout instead of the real cause — this is the exact bug this milestone covers: ${err.message}`,
  );
}

async function crashingAppFailsWithItsOwnLogs() {
  console.log("Booting a Computer whose app throws during module load...");
  // Relaxed enforcement deliberately: this case is about the *app* crashing,
  // so the enforcement gate must not be what fails, or the assertions below
  // would pass for the wrong reason on a Landlock-less kernel.
  const failure = await bootAndProbe({ appDir: CRASH_APP_DIR, tool: "never_reached", input: {}, enforcement: "warn" });
  assert(failure, "expected a Computer whose app throws at import to fail, but boot and the tool call both succeeded");

  console.log(`failed after ${failure.elapsedMs}ms with:`, failure.err.message);
  assertNotABareTimeout(failure.err);
  assert(
    failure.err.message.includes("CRASH_ON_BOOT_FIXTURE_MARKER"),
    `expected the container's own log output in the error, got: ${failure.err.message}`,
  );
  console.log("PASS — a crashing app is reported with its own logs, not a timeout.\n");
}

async function unenforcedKernelFailsClosed() {
  console.log("Booting a Computer with the default enforcement posture...");
  // Explicit rather than relying on the default, so this case still asserts
  // what it claims to when the whole milestone is run with
  // BERTH_ALLOW_UNENFORCED=1 set in the environment.
  const failure = await bootAndProbe({
    appDir: FILESYSTEM_APP_DIR,
    tool: "write_file",
    input: { path: "boot-failure-probe.txt", content: "probe" },
    enforcement: "required",
  });

  if (!failure) {
    console.log("SKIP — this kernel enforces Landlock, so the default posture worked end to end (as it should).\n");
    return;
  }

  console.log(`failed after ${failure.elapsedMs}ms with:`, failure.err.message);
  assertNotABareTimeout(failure.err);
  assert(
    failure.err.message.includes("capability_enforcement_refused"),
    `expected agent-init's refusal event in the error, got: ${failure.err.message}`,
  );
  console.log("PASS — the default posture fails closed, naming the enforcement refusal.\n");
}

/** The other half of 0.1: the same app the previous case refused must work in the relaxed mode. */
async function relaxedModeBootsTheSameApp() {
  console.log("Booting the same app with enforcement: \"warn\"...");
  const failure = await bootAndProbe({
    appDir: FILESYSTEM_APP_DIR,
    tool: "write_file",
    input: { path: "boot-failure-probe.txt", content: "probe" },
    enforcement: "warn",
  });
  assert(!failure, `expected the relaxed mode to boot and serve a tool call, got: ${failure?.err.message}`);
  console.log("PASS — enforcement: \"warn\" produces a live, callable Computer.\n");
}

async function main() {
  await crashingAppFailsWithItsOwnLogs();
  await unenforcedKernelFailsClosed();
  await relaxedModeBootsTheSameApp();
  console.log("COMPUTER BOOT FAILURE MILESTONE: PASS");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCOMPUTER BOOT FAILURE MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
