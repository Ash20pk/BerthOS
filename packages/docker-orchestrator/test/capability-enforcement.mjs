#!/usr/bin/env node
// Real, running verification of Phase 3's kernel enforcement: confirms
// writes inside a resident app's declared filesystem:write path succeed,
// and a write outside it (via path traversal — proving the kernel catches
// what app code doesn't validate itself) is refused BY THE KERNEL. Also
// covers read-path scoping (opt-in — see generate-capability-policy.ts):
// apps/filesystem/berth.yml already declares filesystem:read:/workspace and
// filesystem:read:/context, so reads are confined to baseline+declared paths
// for this app without any test-only manifest changes.
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
import { buildImage, startContainer, stopContainer, invokeAppExport } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const BOUNDARY_APP_A_DIR = join(__dirname, "fixtures", "boundary-app-a");
const BOUNDARY_APP_B_DIR = join(__dirname, "fixtures", "boundary-app-b");

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

  // Declared here (not `const` inside the try block below) so Test 6, which
  // needs to know whether this host can enforce anything at all, can read it
  // after that try/finally has already torn down the Test 1-5 container.
  let landlockActive;

  try {
    await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");
    await waitFor(() => /ruleset=/.test(containerLog.text()), 5000, "agent-init's landlock status line");

    const statusLine = containerLog.text().match(/\[agent-init\] landlock restrict_self\(\).*$/m)?.[0] ?? "";
    console.log(statusLine);
    landlockActive = /ruleset=FullyEnforced|ruleset=PartiallyEnforced/.test(statusLine);
    if (!landlockActive) {
      assert(
        !process.env.CI,
        "Landlock is NOT active in this CI runner's LSM stack. GitHub Actions ubuntu-latest is expected to " +
          "have Landlock active (mainline since kernel 5.13) — this is a real regression (runner image change, " +
          "kernel config change, or a container/security-opt change suppressing it), not an environment " +
          "limitation. Investigate before assuming Phase 3 enforces anything.",
      );
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

    console.log("\n--- Test 3: read INSIDE the declared+baseline path (should always succeed) ---");
    // apps/filesystem/berth.yml already declares filesystem:read:/workspace
    // and filesystem:read:/context — read scoping (opt-in per
    // generate-capability-policy.ts) is therefore already active for this
    // app, no synthetic manifest needed to exercise it.
    const insideRead = await rpc.call({ id: "3", export: "read_file", input: { path: "allowed.txt" } });
    assert(!insideRead.error, `expected read inside /workspace to succeed, got error: ${insideRead.error}`);

    console.log("\n--- Test 4: read OUTSIDE the declared+baseline paths via path traversal ---");
    // The fixture must actually exist for this to mean anything: Landlock
    // only gates open()/readdir() on a *resolved* inode, not path traversal
    // itself, so reading a path that simply doesn't exist returns ENOENT
    // from ordinary VFS lookup before Landlock's check is ever reached —
    // indistinguishable from "denied" by the error-message check below, but
    // proving nothing about enforcement either way. Created via a fresh
    // `docker exec` (unrestricted — a sibling of the Landlock-restricted app
    // process, not a descendant of it, same as this file's header comment
    // already notes about not *testing* enforcement via exec) rather than
    // baking a test-only file into entrypoint.sh's real production boot path.
    await execInContainer(running.container, ["sh", "-c", "mkdir -p /opt && echo secret > /opt/berth-should-not-be-readable.txt"]);
    const outsideRead = await rpc.call({
      id: "4",
      export: "read_file",
      input: { path: "../../../opt/berth-should-not-be-readable.txt" },
    });
    console.log("response:", outsideRead);
    const readDenied = outsideRead.error && /EACCES|EPERM|permission/i.test(outsideRead.error);
    if (landlockActive) {
      assert(readDenied, `Landlock is active but the out-of-scope read was NOT denied — real regression: ${JSON.stringify(outsideRead)}`);
      console.log("\nPASS — declaring filesystem:read:* confined reads to baseline+declared paths.");
    } else {
      console.log("\nNOT VERIFIED (expected in this environment) — Landlock isn't enforced here.");
    }

    console.log("\n--- Test 5: network is deny-by-default — filesystem declares no network:connect capability ---");
    // apps/filesystem/berth.yml declares no network:* capability, so under
    // the deny-by-default policy (packages/agent-init/src/main.rs) it should
    // get a Landlock ruleset with zero allowed outbound ports — a real
    // attempted TCP connect from inside the actually-restricted runtime
    // process (not a docker-exec'd one, see this file's header comment)
    // should fail at the kernel level, not just look denied.
    const netProbe = await rpc.call({
      id: "5",
      export: "probe_network_connect",
      input: { host: "1.1.1.1", port: 80 },
    });
    console.log("response:", netProbe);
    assert(!netProbe.error, `probe_network_connect itself errored (unexpected): ${netProbe.error}`);
    const wasNetDenied = netProbe.result?.connected === false;
    if (landlockActive) {
      assert(
        wasNetDenied,
        `Landlock is active but an app with no declared network:connect capability was able to connect out — deny-by-default regression: ${JSON.stringify(netProbe)}`,
      );
      console.log("\nPASS — an app declaring no network:connect capability could not reach out at all.");
    } else {
      console.log(
        wasNetDenied
          ? "\n(Interesting: denied anyway, despite ruleset != Enforced — logged for information, not asserted.)"
          : "\nNOT VERIFIED (expected in this environment) — the connect succeeded because Landlock isn't enforced here.",
      );
    }

    console.log("\n--- Test 6: symlink escape — a symlink INSIDE the declared path pointing OUTSIDE it ---");
    // PathBeneath rules bind to a real inode hierarchy (resolved when
    // agent-init opens the path via PathFd::new(), see main.rs), not a path
    // string — so Landlock is expected to resolve a symlink at syscall time
    // and deny access to whatever it actually points at, even though the
    // symlink itself lives inside the granted /workspace hierarchy. This is
    // the classic "escape the sandbox via a symlink" technique; proving it
    // doesn't work here is what makes the write/read-path grants above mean
    // anything against an app that tries to plant one.
    await execInContainer(running.container, ["sh", "-c", "ln -sfn /opt /workspace/escape-write-link"]);
    const symlinkWrite = await rpc.call({
      id: "6",
      export: "write_file",
      input: { path: "escape-write-link/pwned-via-symlink.txt", content: "if this exists, symlink escape worked" },
    });
    console.log("write response:", symlinkWrite);
    const symlinkWriteDenied = symlinkWrite.error && /EACCES|EPERM|permission/i.test(symlinkWrite.error);

    await execInContainer(running.container, ["sh", "-c", "ln -sfn /opt /workspace/escape-read-link"]);
    const symlinkRead = await rpc.call({
      id: "7",
      export: "read_file",
      input: { path: "escape-read-link/berth-should-not-be-readable.txt" },
    });
    console.log("read response:", symlinkRead);
    const symlinkReadDenied = symlinkRead.error && /EACCES|EPERM|permission/i.test(symlinkRead.error);

    if (landlockActive) {
      assert(
        symlinkWriteDenied,
        `Landlock is active but a write through a symlink pointing outside /workspace was NOT denied — real regression: ${JSON.stringify(symlinkWrite)}`,
      );
      assert(
        symlinkReadDenied,
        `Landlock is active but a read through a symlink pointing outside the declared read paths was NOT denied — real regression: ${JSON.stringify(symlinkRead)}`,
      );
      console.log("\nPASS — the kernel resolved both symlinks to their real target and denied access outside the declared paths.");
    } else {
      console.log("\nNOT VERIFIED (expected in this environment) — Landlock isn't enforced here.");
    }

    rpc.close();
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }

  console.log("\n--- Test 7: BERTH_REQUIRE_ENFORCEMENT=1 refuses to boot unrestricted ---");
  // A second, independent container from the same image — proves
  // agent-init's fail-closed gate (packages/agent-init/src/main.rs) without
  // touching the container Test 1-5 already tore down.
  const enforcedRunning = await startContainer({
    image: "berth/filesystem:dev",
    name: "berth-capability-enforcement-filesystem-require-enforcement",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    env: { BERTH_REQUIRE_ENFORCEMENT: "1" },
    docker,
  });
  const enforcedLog = await startLogCapture(enforcedRunning.container);
  try {
    if (landlockActive) {
      // Enforcement is genuinely FullyEnforced/PartiallyEnforced here, so the
      // gate must not interfere with a boot that would have passed anyway.
      await waitFor(() => /"filesystem" ready/.test(enforcedLog.text()), 20000, "filesystem runtime ready under BERTH_REQUIRE_ENFORCEMENT");
      console.log("\nPASS — BERTH_REQUIRE_ENFORCEMENT=1 did not block a correctly-enforced boot.");
    } else {
      // This host can't fully enforce the policy — agent-init must refuse to
      // exec the app at all rather than falling back to today's warn-and-run.
      await waitFor(
        () => /capability_enforcement_refused/.test(enforcedLog.text()),
        10000,
        "agent-init's capability_enforcement_refused audit line",
      );
      await waitFor(
        async () => !(await enforcedRunning.container.inspect()).State.Running,
        10000,
        "container to exit after agent-init's enforcement refusal",
      );
      const finalInspect = await enforcedRunning.container.inspect();
      assert(
        finalInspect.State.ExitCode !== 0,
        `expected a non-zero exit code when enforcement couldn't be verified, got ${finalInspect.State.ExitCode}`,
      );
      console.log("\nPASS — BERTH_REQUIRE_ENFORCEMENT=1 refused to exec unrestricted and exited non-zero.");
    }
  } finally {
    await enforcedLog.stop();
    await stopContainer(enforcedRunning.container).catch(() => {});
  }

  console.log("\n--- Test 8: cross-app boundary — one app's grant must not reach a sibling app's directory ---");
  // boundary-app-a/-b (test/fixtures) are each scoped ONLY to their own
  // /workspace/apps/boundary-app-<x> subdirectory (unlike filesystem's own
  // broad filesystem:write:/workspace grant, which legitimately covers the
  // whole tree and so proves nothing about cross-app isolation). Both run in
  // the SAME container via the real --apps multi-app path (see
  // multi-app-milestone.mjs) — each gets its own independent agent-init/
  // Landlock ruleset, and this proves app A's ruleset doesn't leak into app
  // B's directory just because they share a container and a bind mount.
  const boundaryAManifest = await loadManifest(join(BOUNDARY_APP_A_DIR, "berth.yml"));
  const boundaryBManifest = await loadManifest(join(BOUNDARY_APP_B_DIR, "berth.yml"));

  console.log("Building boundary-app-a's dev image (shared by both apps in this container)...");
  await buildImage({ appDir: BOUNDARY_APP_A_DIR, tag: "berth/boundary-app-a:dev", target: "dev", docker });

  const BOUNDARY_APP_A_CONTAINER_DIR = "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-a";
  const BOUNDARY_APP_B_CONTAINER_DIR = "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-b";
  const boundaryApps = [
    { name: "boundary-app-a", workingDir: BOUNDARY_APP_A_CONTAINER_DIR, manifest: boundaryAManifest },
    { name: "boundary-app-b", workingDir: BOUNDARY_APP_B_CONTAINER_DIR, manifest: boundaryBManifest },
  ];
  const boundaryRunning = await startContainer({
    image: "berth/boundary-app-a:dev",
    name: "berth-capability-enforcement-boundary",
    manifest: boundaryAManifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: BOUNDARY_APP_A_CONTAINER_DIR,
    apps: boundaryApps,
    docker,
  });
  const boundaryLog = await startLogCapture(boundaryRunning.container);
  try {
    await waitFor(() => /"boundary-app-a" ready/.test(boundaryLog.text()), 20000, "boundary-app-a runtime ready");
    await waitFor(() => /"boundary-app-b" ready/.test(boundaryLog.text()), 20000, "boundary-app-b runtime ready");

    // Seed a file only boundary-app-b is allowed to touch, via app B itself
    // (not a raw docker exec) so it's a real write through B's own ruleset.
    const seedResp = await invokeAppExport(boundaryRunning.container, "boundary-app-b", {
      id: "1",
      export: "write_file",
      input: { path: "b-owned.txt", content: "only boundary-app-b should be able to write or read this" },
    });
    assert(!seedResp.error, `boundary-app-b seeding its own file failed unexpectedly: ${seedResp.error}`);

    console.log("\n--- App A attempting to WRITE into App B's directory via relative traversal ---");
    const crossWrite = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "2",
      export: "write_file",
      input: { path: "../boundary-app-b/pwned-by-a.txt", content: "if this exists, cross-app isolation failed" },
    });
    console.log("response:", crossWrite);
    const crossWriteDenied = crossWrite.error && /EACCES|EPERM|permission/i.test(crossWrite.error);

    console.log("\n--- App A attempting to READ App B's file via relative traversal ---");
    const crossRead = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "3",
      export: "read_file",
      input: { path: "../boundary-app-b/b-owned.txt" },
    });
    console.log("response:", crossRead);
    const crossReadDenied = crossRead.error && /EACCES|EPERM|permission/i.test(crossRead.error);

    if (landlockActive) {
      assert(
        crossWriteDenied,
        `Landlock is active but boundary-app-a was able to write into boundary-app-b's directory — cross-app isolation regression: ${JSON.stringify(crossWrite)}`,
      );
      assert(
        crossReadDenied,
        `Landlock is active but boundary-app-a was able to read boundary-app-b's file — cross-app isolation regression: ${JSON.stringify(crossRead)}`,
      );
      console.log("\nPASS — sharing a container did not let app A reach app B's declared scope.");
    } else {
      console.log("\nNOT VERIFIED (expected in this environment) — Landlock isn't enforced here.");
    }
  } finally {
    await boundaryLog.stop();
    await stopContainer(boundaryRunning.container).catch(() => {});
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function execInContainer(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  let out = "";
  stdout.on("data", (chunk) => (out += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => process.stderr.write(`[exec stderr] ${chunk}`));
  await new Promise((resolve) => stream.on("end", resolve));
  return out;
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
