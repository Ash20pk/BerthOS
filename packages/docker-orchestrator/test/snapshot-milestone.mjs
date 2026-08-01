#!/usr/bin/env node
// Real, running verification of `berth snapshot create/restore`: boots a
// real apps/filesystem PRODUCTION container (self-contained, no bind mount —
// a dev container's /workspace is bind-mounted from the host, so a file
// written there would trivially "survive" regardless of whether snapshotting
// actually works; production mode is what makes this a genuine test of
// docker commit()/getArchive() actually capturing container-local state),
// writes a real /workspace file and a real tagged /context file via RPC,
// snapshots, stops+removes the original container entirely, restores into a
// brand-new container, and reads both back via RPC to confirm the image
// commit and the context-data archive both survived the round trip for
// real.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer, createSnapshot, restoreSnapshot, snapshotDirFor } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const IMAGE_TAG = "berth/filesystem:snapshot-milestone";

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));

  console.log("--- Building filesystem's production image (self-contained, no bind mount) ---");
  await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: IMAGE_TAG, target: "production", docker });

  console.log("\n--- Starting the original container ---");
  const original = await startContainer({
    image: IMAGE_TAG,
    name: "berth-snapshot-milestone-original",
    manifest,
    workingDir: "/app",
    docker,
  });

  const originalLog = await startLogCapture(original.container);
  let snapshotDir;
  try {
    await waitFor(() => /"filesystem" ready/.test(originalLog.text()), 20000, "filesystem runtime ready");

    const rpc = await createRpcClient(original.container);

    console.log("\n--- Writing real state before snapshotting ---");
    const writeWorkspace = await rpc.call({ id: "1", export: "write_file", input: { path: "snapshot-test.txt", content: "state before snapshot" } });
    assert(!writeWorkspace.error, `expected write_file to succeed, got: ${writeWorkspace.error}`);

    const writeContext = await rpc.call({
      id: "2",
      export: "write_context_file",
      input: { path: "notes.md", content: "important context" },
    });
    assert(!writeContext.error, `expected write_context_file to succeed, got: ${writeContext.error}`);

    const tagContext = await rpc.call({
      id: "3",
      export: "tag_context_file",
      input: { path: "notes.md", task: "snapshot-milestone", relatedApps: ["filesystem"] },
    });
    assert(!tagContext.error, `expected tag_context_file to succeed, got: ${tagContext.error}`);

    rpc.close();

    console.log("\n--- Test 1: berth snapshot create (real docker commit + real context-data archive) ---");
    const snapshot = await createSnapshot({ container: original.container, appName: manifest.name, manifest, docker });
    snapshotDir = snapshot.dir;
    console.log(`snapshot created: ${snapshot.id} at ${snapshot.dir}`);
    assert(snapshot.id, "expected createSnapshot to return an id");

    console.log("\n--- Stopping and removing the ORIGINAL container entirely ---");
    await originalLog.stop();
    await stopContainer(original.container);

    console.log("\n--- Test 2: berth snapshot restore into a brand-new container ---");
    const restored = await restoreSnapshot(snapshot.dir, docker);
    assert(restored.metadata.imageTag, "expected restoreSnapshot to report the loaded image tag");

    const newContainer = await startContainer({
      image: restored.metadata.imageTag,
      name: "berth-snapshot-milestone-restored",
      manifest: restored.manifest,
      workingDir: "/app",
      extraBinds: [`${restored.contextDataHostDir}:${restored.metadata.contextDataPath}`],
      env: restored.env,
      docker,
    });

    const restoredLog = await startLogCapture(newContainer.container);
    try {
      await waitFor(() => /"filesystem" ready/.test(restoredLog.text()), 20000, "restored filesystem runtime ready");

      const restoredRpc = await createRpcClient(newContainer.container);

      console.log("\n--- Test 3: the /workspace file written before the snapshot survived the image commit ---");
      const readBack = await restoredRpc.call({ id: "4", export: "read_file", input: { path: "snapshot-test.txt" } });
      console.log("read_file response:", readBack);
      assert(!readBack.error, `expected read_file to succeed on the restored container, got: ${readBack.error}`);
      assert(
        readBack.result?.content === "state before snapshot",
        `expected the pre-snapshot file content to survive, got: ${JSON.stringify(readBack.result)}`,
      );
      console.log("PASS — the file written before snapshotting is readable in the restored container, from the committed image layer.");

      console.log("\n--- Test 4: semantic-fs tag metadata survived the context-data archive round trip ---");
      // semantic-fs indexes tag()'s task/relatedApps/path text, not file
      // content — query with a term that actually overlaps the tag applied
      // before the snapshot, not the file's own content.
      const query = await restoredRpc.call({ id: "5", export: "query_context", input: { text: "snapshot-milestone" } });
      console.log("query_context response:", query);
      assert(!query.error, `expected query_context to succeed on the restored container, got: ${query.error}`);
      const results = query.result?.results ?? [];
      assert(
        results.some((r) => String(r.path ?? r).includes("notes.md")),
        `expected the restored semantic-fs index to still contain notes.md, got: ${JSON.stringify(results)}`,
      );
      console.log("PASS — semantic-fs's tagged metadata survived the snapshot's context-data archive round trip.");

      restoredRpc.close();
      console.log(
        "\nALL PASS — berth snapshot create/restore round-tripped both a real committed image layer and a real " +
          "semantic-fs context-data archive across two genuinely separate containers.",
      );
    } finally {
      await restoredLog.stop();
      await stopContainer(newContainer.container);
    }
  } finally {
    await originalLog.stop().catch(() => {});
    await docker
      .getContainer("berth-snapshot-milestone-original")
      .remove({ force: true })
      .catch(() => {});
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
      // A freshly-hijacked attach connection has occasionally taken its
      // first write to genuinely reach the container's stdin on this Docker
      // Desktop setup — the same class of attach-timing flakiness this
      // repo's own docs already name (Phase 4 gotchas: "the RPC client
      // retries once on a timed-out first call as cheap insurance either
      // way"). One resend on the SAME still-open connection (not a fresh
      // attach — see stopContainer's own doc comment on why closing/
      // reattaching mid-conversation is unsafe) resolves it without
      // touching stdin-close semantics at all.
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
    console.error("\nSNAPSHOT MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
