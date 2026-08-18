#!/usr/bin/env node
/**
 * The kernel says no.
 *
 * No LLM, no API key, no agent loop — just the boundary itself. This boots a
 * Berth OS with one resident app (`apps/filesystem`, which declares
 * `filesystem:write:/workspace` and nothing else), then calls the same
 * `write_file` tool an agent would call, twice:
 *
 *   1. inside /workspace  -> succeeds
 *   2. outside /workspace -> EACCES, from the kernel
 *
 * Nothing in this file, in @berth/agents, or in the app's own code checks the
 * second path. `apps/filesystem/berth.yml`'s capability line was compiled into
 * a Landlock ruleset and applied by `agent-init` before the app's first line
 * ran, so the write dies in `open(2)`. A prompt-injected agent, a hallucinated
 * path, and a deliberate attempt all get the same answer.
 *
 * Run it:
 *   pnpm install && pnpm build     # from the repo root, once
 *   cd examples/kernel-says-no && pnpm start
 *
 * Kernel enforcement needs a host kernel that provides Landlock. Docker
 * Desktop for Mac does not (its linuxkit VM returns ENOSYS), so this script
 * refuses to pretend: it exits non-zero and points at
 * ../../docs/mac-enforcement.md, which sets up a Colima daemon where the
 * denial below is real. `berth doctor` tells you which host you're on.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer } from "@berth/agents";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

// Relative to /workspace, which is what apps/filesystem joins onto. Traversal
// rather than a bare "/etc/..." path precisely because the app does the join
// itself — the point is that the kernel refuses the resulting path, not that
// the app validated the input.
const OUTSIDE = "../../../etc/berth-should-not-exist.txt";

const DENIED = /EACCES|EPERM|permission denied/i;

const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR] });
const unenforced = process.env.BERTH_ALLOW_UNENFORCED === "1";

try {
  console.log(`app loaded: filesystem — declares filesystem:write:/workspace`);
  console.log(`tools available: ${computer.tools.map((t) => t.name).join(", ")}\n`);

  console.log("--- inside the declared scope ---");
  await computer.call("write_file", { path: "hello.txt", content: "hello from a sandbox" });
  const { content } = await computer.call("read_file", { path: "hello.txt" });
  console.log(`write /workspace/hello.txt -> ok, read back: ${JSON.stringify(content)}\n`);

  console.log("--- outside the declared scope ---");
  let error;
  try {
    await computer.call("write_file", { path: OUTSIDE, content: "if you can read this, enforcement failed" });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  console.log(`write /etc/berth-should-not-exist.txt -> ${error ?? "NO ERROR"}\n`);

  if (error && DENIED.test(error)) {
    console.log(
      unenforced
        ? "Denied — but BERTH_ALLOW_UNENFORCED=1 is set, so this run did not require a kernel that\n" +
            "enforces anything. Something refused the write; do not read this as proof the kernel did.\n" +
            "Run it again on an enforcing host (docs/mac-enforcement.md) to make the claim."
        : "PASS — the capability line in berth.yml is the boundary, and the kernel is the one holding it.",
    );
  } else if (unenforced) {
    console.log(
      "NOT ENFORCED (expected here) — BERTH_ALLOW_UNENFORCED=1 ran the app with whatever the kernel\n" +
        "managed to apply, which on Docker Desktop for Mac is nothing. This is the honest outcome of\n" +
        "that mode, not a bug. See ../../docs/mac-enforcement.md for a Mac host where the write is\n" +
        "actually refused, and `berth doctor` for which one you are on.",
    );
    process.exitCode = 1;
  } else {
    console.error(
      "FAIL — this host claimed to enforce (the boot would have refused otherwise) and the write\n" +
        "outside /workspace was not denied. That is a real regression, not an environment limit.",
    );
    process.exitCode = 1;
  }
} finally {
  await computer.stop();
}
