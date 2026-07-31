#!/usr/bin/env node
// Real, running verification of Phase 3's kernel enforcement: confirms
// writes inside a resident app's declared filesystem:write path succeed,
// and a write outside it (via path traversal — proving the kernel catches
// what app code doesn't validate itself) is refused BY THE KERNEL.
//
// Note on scope: this only exercises the app's own runtime process, which is
// what agent-init actually restricts via landlock_restrict_self() before
// exec-ing into it. A separate `docker exec` into the same container would
// NOT be a descendant of that restricted process (Landlock only binds a
// process and its future fork/exec children) — so testing enforcement via
// `docker exec` wouldn't prove anything either way, and isn't attempted here.
//
// Environment caveat: Landlock enforcement requires the kernel to have
// "landlock" active in its LSM stack (check `cat /sys/kernel/security/lsm`
// after `mount -t securityfs securityfs /sys/kernel/security` in a
// privileged container). Docker Desktop for Mac's linuxkit VM kernel has the
// landlock syscalls present but does NOT list landlock as an active LSM
// (only `capability,bpf`) — agent-init's own restrict_self() call reports
// this via a `ruleset=NotEnforced` log line, and this script surfaces that
// as a clear warning rather than a false test failure. On a real Linux host
// or CI runner with Landlock active (most modern distros, GitHub Actions
// ubuntu-latest, real cloud VMs), this test should hard-fail if enforcement
// regresses — see docs/capability-tokens-reference.md.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));

  console.log("Building filesystem's dev image...");
  await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: "berth/filesystem:dev", target: "dev", docker });

  console.log("Starting filesystem's sandbox...");
  const running = await startContainer({
    image: "berth/filesystem:dev",
    name: "berth-capability-enforcement-filesystem",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    docker,
  });

  const containerLog = await startLogCapture(running.container);

  try {
    await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");
    await waitFor(() => /ruleset=/.test(containerLog.text()), 5000, "agent-init's landlock status line");

    const statusLine = containerLog.text().match(/\[agent-init\] landlock restrict_self\(\).*$/m)?.[0] ?? "";
    console.log(statusLine);
    const landlockActive = /ruleset=FullyEnforced|ruleset=PartiallyEnforced/.test(statusLine);
    if (!landlockActive) {
      console.log(
        "\nWARNING: this kernel does not have Landlock active in its LSM stack (see this file's header comment).\n" +
          "Enforcement cannot be verified in this environment — treating the write-outside-workspace check as\n" +
          "informational only, not a hard failure. Re-run this on a Landlock-enabled Linux host before trusting\n" +
          "that Phase 3 actually enforces anything in production.",
      );
    }

    const rpc = await createRpcClient(running.container);

    console.log("\n--- Test 1: write INSIDE the declared path (should always succeed) ---");
    const allowed = await rpc.call({
      id: "1",
      export: "write_file",
      input: { path: "allowed.txt", content: "this should work" },
    });
    console.log("response:", allowed);
    assert(!allowed.error, `expected write inside /workspace to succeed, got error: ${allowed.error}`);

    console.log("\n--- Test 2: write OUTSIDE the declared path via path traversal ---");
    const traversal = await rpc.call({
      id: "2",
      export: "write_file",
      input: { path: "../../../etc/berth-should-not-exist.txt", content: "if you can read this, enforcement failed" },
    });
    console.log("response:", traversal);

    const wasDenied = traversal.error && /EACCES|EPERM|permission/i.test(traversal.error);
    if (landlockActive) {
      assert(wasDenied, `Landlock is active but the traversal write was NOT denied — real regression: ${JSON.stringify(traversal)}`);
      console.log("\nPASS — write inside /workspace succeeded; write outside it was refused by the kernel.");
    } else {
      console.log(
        wasDenied
          ? "\n(Interesting: denied anyway, despite ruleset != Enforced — logged for information, not asserted.)"
          : "\nNOT VERIFIED (expected in this environment) — the traversal write succeeded because Landlock isn't enforced here.",
      );
    }

    rpc.close();
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function startLogCapture(container) {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(raw, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return { text: () => buffer, stop: async () => raw.destroy() };
}

// One attach connection reused across every call — closing it (or ending
// the stream) after a single request tears down the container's actual
// stdin for good, breaking any subsequent RPC call against the same
// container.
async function createRpcClient(container) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  const pending = new Map();

  stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        pending.get(parsed.id)?.(parsed);
        pending.delete(parsed.id);
      } catch {
        // not a JSON line — ignore
      }
    }
  });

  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 5000);
        pending.set(request.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        stream.write(JSON.stringify(request) + "\n");
      });
    },
    close() {
      stream.end();
    },
  };
}

async function waitFor(predicate, timeoutMs, description) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCAPABILITY ENFORCEMENT VERIFICATION FAILED:", err);
    process.exit(1);
  });
