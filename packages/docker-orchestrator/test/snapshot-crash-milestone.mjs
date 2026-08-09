#!/usr/bin/env node
// Real, running verification of the actual failure mode production has to
// survive: snapshot-milestone.mjs only ever snapshots a container that's
// still healthy and then cleanly stops it afterward — it never proves
// anything about a container that crashed first. This test kills the
// original container with a real SIGKILL (no graceful shutdown, no RPC
// close) before ever calling createSnapshot(), so the restore path is
// exercised against exactly what commit()/getArchive() actually see after a
// crash, not an idealized clean-shutdown container.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer, createSnapshot, restoreSnapshot } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const IMAGE_TAG = "berth/filesystem:snapshot-crash-milestone";

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));

  console.log("--- Building filesystem's production image (self-contained, no bind mount) ---");
  await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: IMAGE_TAG, target: "production", docker });

  console.log("\n--- Starting the original container ---");
  const original = await startContainer({
    image: IMAGE_TAG,
    name: "berth-snapshot-crash-milestone-original",
    manifest,
    workingDir: "/app",
    docker,
  });

  const originalLog = await startLogCapture(original.container);
  let snapshotDir;
  try {
    await waitFor(() => /"filesystem" ready/.test(originalLog.text()), 20000, "filesystem runtime ready");

    const rpc = await createRpcClient(original.container);

    console.log("\n--- Test 1: a write that completes and is ACKNOWLEDGED before the crash must survive ---");
    const confirmedWrite = await rpc.call({
      id: "1",
      export: "write_file",
      input: { path: "pre-crash.txt", content: "written and acknowledged before the crash" },
    });
    assert(!confirmedWrite.error, `expected the pre-crash write to succeed, got: ${confirmedWrite.error}`);

    console.log("\n--- Test 2: a write racing the kill — no response awaited, fire-and-crash ---");
    // Deliberately not awaited: this is the actual "SIGKILL mid-operation"
    // case. There's no WAL or durability guarantee in this system for a
    // write that was never acknowledged (see docs/computer-snapshots-
    // reference.md) — the only real requirement is that racing it doesn't
    // corrupt the snapshot or crash the restore pipeline. Its outcome is
    // therefore observed and logged below, not hard-asserted either way.
    rpc.call({ id: "2", export: "write_file", input: { path: "racing-crash.txt", content: "may or may not have landed" } }).catch(() => {});

    console.log("\n--- Killing the original container with a real SIGKILL (no graceful shutdown) ---");
    await original.container.kill({ signal: "SIGKILL" });
    await waitFor(async () => !(await original.container.inspect()).State.Running, 10000, "container to report not-running after SIGKILL");
    const killedInspect = await original.container.inspect();
    console.log(`post-kill state: Status=${killedInspect.State.Status} ExitCode=${killedInspect.State.ExitCode} OOMKilled=${killedInspect.State.OOMKilled}`);
    assert(!killedInspect.State.Running, "expected the container to be reported as not-running after SIGKILL");

    await originalLog.stop().catch(() => {});

    console.log("\n--- Test 3: createSnapshot() against an already-dead (crashed) container ---");
    // The real question this answers: do commit()/getArchive() even work
    // against a container docker itself considers exited, or does the
    // whole snapshot pipeline assume a live container and fail here? This
    // is the actual gap docs/computer-snapshots-reference.md never covers.
    const snapshot = await createSnapshot({ container: original.container, appName: manifest.name, manifest, docker });
    snapshotDir = snapshot.dir;
    console.log(`snapshot created from a crashed container: ${snapshot.id} at ${snapshot.dir}`);
    assert(snapshot.id, "expected createSnapshot to return an id even for a crashed container");

    console.log("\n--- Removing the crashed original container ---");
    await docker.getContainer("berth-snapshot-crash-milestone-original").remove({ force: true }).catch(() => {});

    console.log("\n--- Test 4: restoreSnapshot() + boot from a crash-time snapshot ---");
    const restored = await restoreSnapshot(snapshot.dir, docker);
    assert(restored.metadata.imageTag, "expected restoreSnapshot to report the loaded image tag");

    const newContainer = await startContainer({
      image: restored.metadata.imageTag,
      name: "berth-snapshot-crash-milestone-restored",
      manifest: restored.manifest,
      workingDir: "/app",
      extraBinds: [
        `${restored.contextDataHostDir}:${restored.metadata.contextDataPath}`,
        `${restored.contextIndexDbHostFile}:${restored.metadata.contextIndexDbPath}`,
      ],
      env: restored.env,
      docker,
    });

    const restoredLog = await startLogCapture(newContainer.container);
    try {
      await waitFor(() => /"filesystem" ready/.test(restoredLog.text()), 20000, "restored filesystem runtime ready");
      console.log("PASS — a container restored from a crash-time snapshot boots and becomes ready, same as a clean-shutdown one.");

      const restoredRpc = await createRpcClient(newContainer.container);

      console.log("\n--- Test 5: the acknowledged pre-crash write survived the crash-time snapshot ---");
      const readBack = await restoredRpc.call({ id: "3", export: "read_file", input: { path: "pre-crash.txt" } });
      console.log("read_file response:", readBack);
      assert(!readBack.error, `expected read_file to succeed on the restored container, got: ${readBack.error}`);
      assert(
        readBack.result?.content === "written and acknowledged before the crash",
        `expected the acknowledged pre-crash write to survive intact, got: ${JSON.stringify(readBack.result)}`,
      );
      console.log("PASS — a write that was acknowledged before the SIGKILL survived the crash, snapshot, and restore intact.");

      console.log("\n--- Informational: outcome of the write that raced the kill ---");
      const racingReadBack = await restoredRpc.call({ id: "4", export: "read_file", input: { path: "racing-crash.txt" } });
      if (!racingReadBack.error && racingReadBack.result?.content === "may or may not have landed") {
        console.log("(the racing write landed fully before the kill reached it — not asserted, just observed)");
      } else {
        console.log("(the racing write did not land, or landed partially — expected for an unacknowledged write racing a SIGKILL, not asserted)");
      }

      restoredRpc.close();
      console.log(
        "\nALL PASS — a container that crashed (real SIGKILL, no graceful shutdown) can still be snapshotted and " +
          "restored into a working container, with every write that was acknowledged before the crash intact.",
      );
    } finally {
      await restoredLog.stop();
      await stopContainer(newContainer.container);
    }
  } finally {
    await originalLog.stop().catch(() => {});
    await docker.getContainer("berth-snapshot-crash-milestone-original").remove({ force: true }).catch(() => {});
    if (snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
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

async function createRpcClient(container) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  // Terminates the attach options object docker-modem sends as this POST's
  // body straight into the container's stdin, so it can't concatenate onto the
  // first real request — see @berth/docker-orchestrator's stdio-rpc.ts for the
  // full explanation.
  stream.write("\n");
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
      const attempt = () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(request.id);
            reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
          }, 10000);
          pending.set(request.id, (response) => {
            clearTimeout(timer);
            resolve(response);
          });
          stream.write(JSON.stringify(request) + "\n");
        });
      return attempt().catch((err) => {
        if (!/timed out/.test(err.message)) throw err;
        return attempt();
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
    console.error("\nSNAPSHOT CRASH MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
